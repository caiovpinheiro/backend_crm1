/**
 * "digitando…" do CONTATO em canais Baileys (WhatsApp QR).
 *
 * O WhatsApp só manda `composing`/`recording` de um contato para quem
 * assinou a presença dele (`sock.presenceSubscribe(jid)`) — é o que o
 * WhatsApp Web faz quando o usuário abre uma conversa. Assinar presença de
 * muitos números de uma vez é comportamento de robô e aumenta o risco de
 * bloqueio do número conectado; por isso a assinatura aqui é econômica.
 *
 * Política de assinatura
 * ──────────────────────
 * - Nunca em massa: nada é assinado na conexão nem na reconexão. Socket
 *   novo começa com a tabela vazia.
 * - Só por atividade: assina o JID quando uma mensagem acabou de trafegar
 *   nele (recebida; ou enviada pelo CRM numa conversa em que o contato já
 *   escreveu — disparo frio/campanha não assina).
 * - Só conversa ABERTA (`status = OPEN`). Atividade em conversa com outro
 *   status derruba o registro do JID.
 * - TTL: sem mensagem nova em `BAILEYS_CONTACT_TYPING_TTL_MS` (10 min), o
 *   registro expira e a presença daquele JID passa a ser ignorada. O
 *   protocolo não tem "desassinar"; a assinatura no servidor do WhatsApp
 *   morre com a conexão. Mensagem nova na janela só renova o prazo (não
 *   reenvia a assinatura).
 * - Teto: no máximo `BAILEYS_CONTACT_TYPING_MAX_SUBSCRIPTIONS` (50) JIDs
 *   vivos por sessão. Cheio = não assina (não derruba os que estão vivos).
 * - Ritmo: no máximo `BAILEYS_CONTACT_TYPING_MAX_SUBSCRIBES_PER_MIN` (10)
 *   assinaturas enviadas por minuto por sessão. Estourou = não assina; a
 *   próxima mensagem do JID tenta de novo.
 * - Grupos, broadcast e newsletter: ignorados.
 * - `BAILEYS_CONTACT_TYPING=0` desliga tudo: não registra o listener, não
 *   assina, não publica. Default ligado — cada assinatura corresponde a
 *   uma conversa em que houve mensagem agora, com teto e ritmo baixos.
 *
 * Caminho quente (`presence.update`): só memória. O JID → conversa vem do
 * registro gravado quando a mensagem passou (o `message-handler` e o
 * `outbound-consumer` já têm contato e conversa em mãos nesse momento).
 * Nenhuma consulta ao banco por evento de presença.
 *
 * Entrega: `publishTypingEvent` → `sseBus` → Redis pub/sub → API, o mesmo
 * caminho de `message_status`/`new_message` do worker. O payload leva só
 * ids (`userName` sempre `null`): é o mesmo conjunto que quem não lista a
 * conversa já recebe em `new_message` (`sse-redact.ts`); a rota SSE aplica
 * o filtro de org e o de funil pelo `conversationId`.
 */
import type { BaileysEventMap, WASocket } from "@whiskeysockets/baileys";

import { getLogger } from "@/lib/logger";
import { publishTypingEvent } from "@/lib/realtime-events";
import { isLidJid, resolveJid } from "./lid-resolver";

const log = getLogger("baileys-typing");

export type ContactTypingConfig = {
  enabled: boolean;
  /** Janela de "atividade recente" de um JID assinado. */
  ttlMs: number;
  /** JIDs vivos ao mesmo tempo por sessão. */
  maxSubscriptions: number;
  /** Assinaturas enviadas por minuto por sessão. */
  maxSubscribesPerMinute: number;
};

export const CONTACT_TYPING_DEFAULTS = {
  ttlMs: 10 * 60_000,
  maxSubscriptions: 50,
  maxSubscribesPerMinute: 10,
} as const;

const RATE_WINDOW_MS = 60_000;

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number((raw ?? "").trim());
  if (!raw?.trim() || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function readContactTypingConfig(
  env: Record<string, string | undefined> = process.env,
): ContactTypingConfig {
  const flag = (env.BAILEYS_CONTACT_TYPING ?? "1").trim().toLowerCase();
  return {
    enabled: !["0", "false", "off", "no"].includes(flag),
    ttlMs: intEnv(
      env.BAILEYS_CONTACT_TYPING_TTL_MS,
      CONTACT_TYPING_DEFAULTS.ttlMs,
      30_000,
      60 * 60_000,
    ),
    maxSubscriptions: intEnv(
      env.BAILEYS_CONTACT_TYPING_MAX_SUBSCRIPTIONS,
      CONTACT_TYPING_DEFAULTS.maxSubscriptions,
      1,
      500,
    ),
    maxSubscribesPerMinute: intEnv(
      env.BAILEYS_CONTACT_TYPING_MAX_SUBSCRIBES_PER_MIN,
      CONTACT_TYPING_DEFAULTS.maxSubscribesPerMinute,
      1,
      60,
    ),
  };
}

/** O que o tracker precisa do socket — o teste passa um falso. */
export type ContactTypingSocket = {
  ev: Pick<WASocket["ev"], "on">;
  presenceSubscribe: (jid: string) => Promise<unknown>;
};

export type ContactActivity = {
  /** JID da mensagem como veio do WhatsApp (pode ser `@lid`). */
  jid: string;
  /** JID de telefone já resolvido, quando o chamador tem. */
  resolvedJid?: string | null;
  organizationId: string;
  conversationId: string;
  contactId: string;
  /** `Conversation.status` no momento da mensagem. */
  conversationStatus: string;
  /**
   * Só no envio pelo CRM: o contato já escreveu neste ticket
   * (`lastInboundAt`)? `false` = envio frio, não assina. Ausente =
   * mensagem recebida.
   */
  contactHasWritten?: boolean;
};

export type ContactActivityResult =
  | "subscribed"
  | "renewed"
  | "disabled"
  | "ignored"
  | "not_open"
  | "cold"
  | "cap"
  | "rate";

type Entry = {
  keys: string[];
  organizationId: string;
  conversationId: string;
  contactId: string;
  expiresAt: number;
};

/** `5511…:12@s.whatsapp.net` → `5511…@s.whatsapp.net`; só contato 1:1. */
function userKey(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  if (at <= 0) return null;
  const server = jid.slice(at + 1);
  if (server !== "s.whatsapp.net" && server !== "lid" && server !== "c.us") return null;
  const user = jid.slice(0, at).split(":")[0];
  if (!user) return null;
  return `${user}@${server === "c.us" ? "s.whatsapp.net" : server}`;
}

export class ContactTypingTracker {
  private sock: ContactTypingSocket | null = null;
  private byKey = new Map<string, Entry>();
  private entries = new Set<Entry>();
  private subscribeTimes: number[] = [];

  constructor(
    private readonly channelId: string,
    private readonly config: ContactTypingConfig = readContactTypingConfig(),
  ) {}

  /**
   * Liga o tracker a um socket recém-criado. Zera a tabela: socket novo =
   * nenhuma assinatura no servidor, e nada é reassinado em massa.
   */
  attach(sock: ContactTypingSocket): void {
    this.reset();
    if (!this.config.enabled) return;
    this.sock = sock;
    sock.ev.on("presence.update", (update) => {
      // Listener de um socket antigo (reconexão) não fala mais por aqui.
      if (this.sock !== sock) return;
      this.handlePresenceUpdate(update);
    });
  }

  reset(): void {
    this.sock = null;
    this.byKey.clear();
    this.entries.clear();
    this.subscribeTimes = [];
  }

  /** JIDs vivos (para teste e log). */
  get size(): number {
    return this.entries.size;
  }

  /** Mensagem trafegou neste JID: assina ou renova, conforme a política. */
  noteActivity(activity: ContactActivity): ContactActivityResult {
    const sock = this.sock;
    if (!this.config.enabled || !sock) return "disabled";
    const key = userKey(activity.jid);
    if (!key) return "ignored";
    const altKey = userKey(activity.resolvedJid);
    const now = Date.now();

    const existing = this.byKey.get(key) ?? (altKey ? this.byKey.get(altKey) : undefined);

    if (activity.conversationStatus !== "OPEN") {
      if (existing) this.drop(existing);
      return "not_open";
    }

    // Envio frio (campanha, primeiro contato): nunca assina nem renova.
    if (activity.contactHasWritten === false) return "cold";

    if (existing && existing.expiresAt > now) {
      existing.organizationId = activity.organizationId;
      existing.conversationId = activity.conversationId;
      existing.contactId = activity.contactId;
      existing.expiresAt = now + this.config.ttlMs;
      for (const k of [key, altKey]) {
        if (k && !existing.keys.includes(k)) {
          existing.keys.push(k);
          this.byKey.set(k, existing);
        }
      }
      return "renewed";
    }
    if (existing) this.drop(existing);

    this.purgeExpired(now);
    if (this.entries.size >= this.config.maxSubscriptions) return "cap";

    this.subscribeTimes = this.subscribeTimes.filter((t) => now - t < RATE_WINDOW_MS);
    if (this.subscribeTimes.length >= this.config.maxSubscribesPerMinute) return "rate";
    this.subscribeTimes.push(now);

    const entry: Entry = {
      keys: altKey && altKey !== key ? [key, altKey] : [key],
      organizationId: activity.organizationId,
      conversationId: activity.conversationId,
      contactId: activity.contactId,
      expiresAt: now + this.config.ttlMs,
    };
    this.entries.add(entry);
    for (const k of entry.keys) this.byKey.set(k, entry);

    let pending: Promise<unknown>;
    try {
      pending = sock.presenceSubscribe(activity.jid);
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.catch((err: unknown) => {
      // Sem assinatura não chega presença: solta a vaga; a próxima
      // mensagem do JID tenta de novo.
      if (this.entries.has(entry)) this.drop(entry);
      log.debug(
        { channelId: this.channelId, err: err instanceof Error ? err.message : String(err) },
        "presenceSubscribe falhou",
      );
    });
    return "subscribed";
  }

  /** Caminho quente: só memória, nenhuma consulta. */
  handlePresenceUpdate(update: BaileysEventMap["presence.update"]): boolean {
    if (!this.config.enabled) return false;
    const key = userKey(update?.id);
    if (!key) return false; // grupo, broadcast, newsletter

    let typing = false;
    for (const presence of Object.values(update.presences ?? {})) {
      const state = presence?.lastKnownPresence;
      if (state === "composing" || state === "recording") {
        typing = true;
        break;
      }
    }
    // `paused`/`available`/`unavailable` não publicam: o cliente expira
    // o indicador pelo `until`.
    if (!typing) return false;

    const entry = this.lookup(key, update.id);
    if (!entry) return false;

    try {
      return publishTypingEvent({
        organizationId: entry.organizationId,
        conversationId: entry.conversationId,
        contactId: entry.contactId,
        userId: null,
        userName: null,
        source: "contact",
      });
    } catch (err) {
      log.debug(
        { channelId: this.channelId, err: err instanceof Error ? err.message : String(err) },
        "publish typing do contato falhou",
      );
      return false;
    }
  }

  private lookup(key: string, rawJid: string): Entry | null {
    let entry = this.byKey.get(key);
    if (!entry && isLidJid(rawJid)) {
      // Presença veio pelo LID e o registro está pelo telefone (ou o
      // mapa LID→telefone chegou depois da mensagem).
      const resolved = userKey(resolveJid(this.channelId, rawJid));
      if (resolved) entry = this.byKey.get(resolved);
    }
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.drop(entry);
      return null;
    }
    return entry;
  }

  private purgeExpired(now: number): void {
    for (const entry of this.entries) {
      if (entry.expiresAt <= now) this.drop(entry);
    }
  }

  private drop(entry: Entry): void {
    this.entries.delete(entry);
    for (const k of entry.keys) {
      if (this.byKey.get(k) === entry) this.byKey.delete(k);
    }
  }
}

// ── Registro por canal ──────────────────────────────────────────────────
// A sessão liga o tracker ao socket; `message-handler` e
// `outbound-consumer` só conhecem o `channelId`.

const trackers = new Map<string, ContactTypingTracker>();

export function attachContactTyping(channelId: string, sock: ContactTypingSocket): void {
  let tracker = trackers.get(channelId);
  if (!tracker) {
    tracker = new ContactTypingTracker(channelId);
    trackers.set(channelId, tracker);
  }
  tracker.attach(sock);
}

export function detachContactTyping(channelId: string): void {
  trackers.get(channelId)?.reset();
  trackers.delete(channelId);
}

/** Best-effort: nunca derruba o processamento da mensagem. */
export function noteContactActivity(
  channelId: string,
  activity: ContactActivity,
): ContactActivityResult {
  try {
    return trackers.get(channelId)?.noteActivity(activity) ?? "disabled";
  } catch (err) {
    log.debug(
      { channelId, err: err instanceof Error ? err.message : String(err) },
      "noteContactActivity falhou",
    );
    return "ignored";
  }
}

/** Só para testes. */
export function __resetContactTypingForTests(): void {
  for (const tracker of trackers.values()) tracker.reset();
  trackers.clear();
}
