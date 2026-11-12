import makeWASocket, {
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
  type GroupMetadata,
  type WASocket,
  type BaileysEventMap,
  type AnyMessageContent,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { Prisma } from "@prisma/client";
import QRCode from "qrcode";

import { bumpResponseFamilies, RESPONSE_FAMILIES } from "@/lib/cache/response-families";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import {
  publishChannelUpdated,
  publishMessageStatus,
} from "@/lib/realtime-events";
import { withSystemContext } from "@/lib/webhook-context";
import { credsAreRegistered, usePostgresAuthState } from "./auth-state-postgres";
import { handleBaileysMessage } from "./message-handler";
import { snapshotFromMeta } from "./sync-groups";
import {
  upsertChannelGroupSnapshots,
  type BaileysGroupSnapshot,
} from "@/services/whatsapp-groups";
import { registerLidMapping, getMapSize, clearChannelMap, loadPersistedMappings, fixLidContacts } from "./lid-resolver";
import { attachContactTyping, detachContactTyping } from "./contact-typing";
import { maskPhone } from "@/lib/pii-mask";
import { getLogger } from "@/lib/logger";
import { noteMessageChange } from "@/lib/cache/message-versions";
import { decideReconnect, disconnectReasonName } from "./reconnect-policy";
import { PROCESS_OWNER } from "./session-lock";

const log = getLogger("worker.baileys.baileys-session");

const QR_TIMEOUT_MS = 60_000;

/** Eventos que esta classe escuta — removidos ao trocar de socket. */
const SOCKET_EVENTS = [
  "creds.update",
  "connection.update",
  "contacts.upsert",
  "contacts.update",
  "groups.upsert",
  "messaging-history.set",
  "chats.upsert",
  "groups.update",
  "group-participants.update",
  "messages.upsert",
  "messages.update",
] as const;

export interface BaileysSessionHooks {
  /** Este processo ainda é o dono da trava do canal? (`session-lock.ts`) */
  stillOwner?: () => Promise<boolean>;
  /** Perdeu a trava: o manager encerra esta sessão e tenta pegar de novo. */
  onLostOwnership?: () => void;
}

function snapshotsFromChats(
  chats: Array<{ id?: string | null; name?: string | null }>,
): BaileysGroupSnapshot[] {
  const out: BaileysGroupSnapshot[] = [];
  for (const chat of chats) {
    if (!chat.id?.endsWith("@g.us")) continue;
    out.push({
      jid: chat.id,
      name: chat.name?.trim() || "",
      description: null,
      ownerJid: null,
      partial: true,
      members: [],
    });
  }
  return out;
}

/**
 * Quais mensagens do `messages.upsert` o CRM processa.
 * - Só `notify` (chegou pela rede). `append` é eco do que este socket enviou
 *   (o CRM já gravou) ou fila offline.
 * - Conversa 1:1: só as recebidas (`fromMe` é tratado pelo envio do CRM).
 * - Grupo: também as do próprio número enviadas pelo celular/WhatsApp Web,
 *   senão o histórico do grupo no CRM fica sem o que a empresa escreveu
 *   (DNA Work, 12/11: "TESTEZIM PAE" e "123" no "Teste Grupo").
 */
export function shouldHandleUpsertMessage(
  type: string,
  key: { remoteJid?: string | null; fromMe?: boolean | null },
): boolean {
  if (type !== "notify") return false;
  if (!key.fromMe) return true;
  return Boolean(key.remoteJid?.endsWith("@g.us"));
}

export class BaileysSession {
  channelId: string;
  socket: WASocket | null = null;
  /** Tentativa de reconexão desde a última conexão aberta. */
  private attempt = 0;
  private badSessionStreak = 0;
  private openedAt: number | null = null;
  /** Cada socket novo ganha um número; evento de socket antigo é ignorado. */
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Credencial em uso (o Baileys atualiza no lugar ao parear pelo QR). */
  private creds: unknown = null;
  private qrTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  // Cacheado no `connect()` p/ que cada `messages.upsert` rode sob
  // withSystemContext sem fazer roundtrip ao DB por mensagem. Sem o
  // contexto, ensureOpenDealForContact falhava silenciosamente —
  // contato + conversa criavam, mas o deal "Lead de Entrada" não.
  private organizationId: string | null = null;
  // Baileys 7 cifra grupo com sender-keys dos participantes. Sem este
  // cache o sendMessage(@g.us) resolve metadados vazios e o WhatsApp
  // nunca entrega — a API já tinha respondido 200 só por enfileirar.
  private groupCache = new Map<string, GroupMetadata>();
  // Grupos vistos no histórico ou no upsert. O sync completo inclui esta
  // lista para não apagar um grupo que o `participating` ainda não devolveu.
  private discoveredGroups = new Map<string, BaileysGroupSnapshot>();

  constructor(
    channelId: string,
    private readonly hooks: BaileysSessionHooks = {},
  ) {
    this.channelId = channelId;
  }

  /** Sessão encerrada de vez (stop/disconnect/logout ou pede QR). */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Há uma reconexão agendada (socket ainda não reaberto). */
  get isReconnecting(): boolean {
    return this.reconnectTimer !== null;
  }

  /** Reconecta agora, cancelando a espera (ex.: usuário pediu conectar). */
  async connectNow(): Promise<void> {
    this.clearReconnectTimer();
    await this.connect();
  }

  /**
   * Pediram "conectar" com a sessão já aberta: a rota grava CONNECTING antes
   * de enfileirar e nada voltava a CONNECTED — o canal ficava "Conectando"
   * e o modal do QR esperando para sempre. Regrava o status real.
   */
  async reaffirmConnected(): Promise<boolean> {
    if (!this.socket?.user) return false;
    await this.patchChannel({ status: "CONNECTED", qrCode: null }, "CONNECTED");
    return true;
  }

  /** Fecha o socket atual sem mexer no status e sem disparar reconexão. */
  private teardownSocket(): void {
    const old = this.socket;
    this.socket = null;
    if (!old) return;
    for (const ev of SOCKET_EVENTS) {
      try {
        old.ev.removeAllListeners(ev);
      } catch {
        /* best-effort */
      }
    }
    try {
      old.end(undefined);
    } catch {
      /* best-effort */
    }
  }

  async connect(): Promise<void> {
    // Cache do organizationId do channel — usado em todo callback
    // `messages.upsert` para garantir AsyncLocalStorage scope.
    if (!this.organizationId) {
      const ch = await prismaBase.channel.findUnique({
        where: { id: this.channelId },
        select: { organizationId: true },
      });
      if (!ch) {
        log.error({ channelId: this.channelId }, "[baileys] channel não existe — abortando connect");
        return;
      }
      this.organizationId = ch.organizationId;
    }

    if (this.destroyed) return;

    const loaded = await loadPersistedMappings(this.channelId);
    if (loaded > 0) {
      log.info(
        { channelId: this.channelId, loaded },
        "[baileys] carregou mapeamentos LID→phone do banco",
      );
    }

    const { state, saveCreds } = await usePostgresAuthState(this.channelId);
    if (this.destroyed) return;
    this.creds = state.creds;

    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
      log.info(
        { channelId: this.channelId, version: version.join(".") },
        "[baileys] usando versão WA",
      );
    } catch {
      version = [2, 3000, 1034074495];
      log.warn(
        { channelId: this.channelId, version: version.join(".") },
        "[baileys] fallback para versão",
      );
    }

    if (this.destroyed) return;
    // Nunca dois sockets da mesma sessão no mesmo processo.
    this.teardownSocket();
    const gen = ++this.generation;

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys),
      },
      version,
      printQRInTerminal: false,
      browser: ["CRM Eduit", "Chrome", "4.0.0"],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
    });

    this.socket = sock;

    // "digitando…" do contato: registra o listener de presença e zera a
    // tabela de assinaturas (nada é assinado aqui — só por mensagem).
    attachContactTyping(this.channelId, sock);

    sock.ev.on("creds.update", () => {
      const orgId = this.organizationId;
      if (!orgId) return;
      // saveCreds já tenta 3× e loga; aqui só não deixa a rejeição solta.
      withSystemContext(orgId, saveCreds).catch(() => {});
    });

    sock.ev.on("connection.update", (update) => {
      if (gen !== this.generation) return;
      void this.handleConnectionUpdate(update).catch((err) => {
        log.error(
          { channelId: this.channelId, err: err instanceof Error ? err.message : err },
          "[baileys] erro tratando connection.update",
        );
      });
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      let newMappings = 0;
      for (const c of contacts as Array<{ id?: string; lid?: string }>) {
        if (c.lid && c.id && c.id.endsWith("@s.whatsapp.net")) {
          registerLidMapping(this.channelId, c.lid, c.id);
          newMappings++;
        }
      }
      log.info(
        {
          channelId: this.channelId,
          contacts: contacts.length,
          newMappings,
          total: getMapSize(this.channelId),
        },
        "[baileys] contacts.upsert: LIDs mapeados",
      );
      if (newMappings > 0) {
        fixLidContacts(this.channelId).then((fixed) => {
          if (fixed > 0) log.info(
            { channelId: this.channelId, fixed },
            "[baileys] contatos com LID corrigidos",
          );
        }).catch(() => {});
      }
    });

    // Baileys 7 avisa cada par LID↔telefone que aprende (mensagens, sync).
    // Sem isto, contato fora da agenda ficava só com o LID.
    sock.ev.on("lid-mapping.update", (mapping) => {
      const pairs = Array.isArray(mapping) ? mapping : [mapping];
      let added = 0;
      for (const m of pairs as Array<{ lid?: string; pn?: string }>) {
        if (m?.lid && m.pn && m.pn.endsWith("@s.whatsapp.net")) {
          if (registerLidMapping(this.channelId, m.lid, m.pn)) added++;
        }
      }
      const orgId = this.organizationId;
      if (added > 0 && orgId) {
        void withSystemContext(orgId, () => fixLidContacts(this.channelId)).catch(() => {});
      }
    });

    sock.ev.on("contacts.update", (updates) => {
      for (const c of updates as Array<{ id?: string; lid?: string }>) {
        if (c.lid && c.id && c.id.endsWith("@s.whatsapp.net")) {
          registerLidMapping(this.channelId, c.lid, c.id);
        }
      }
    });

    sock.ev.on("groups.upsert", (groups) => {
      for (const g of groups) this.rememberGroup(g);
      void this.persistDiscovered(groups.map((g) => snapshotFromMeta(g)));
    });

    sock.ev.on("messaging-history.set", ({ chats }) => {
      void this.persistDiscovered(snapshotsFromChats(chats));
    });

    sock.ev.on("chats.upsert", (chats) => {
      void this.persistDiscovered(snapshotsFromChats(chats));
    });

    sock.ev.on("groups.update", (updates) => {
      for (const u of updates) {
        if (!u.id) continue;
        const prev = this.groupCache.get(u.id);
        const full = Array.isArray((u as GroupMetadata).participants);
        if (prev) {
          this.rememberGroup({ ...prev, ...u } as GroupMetadata);
          continue;
        }
        // `groupFetchAllParticipating` emite o metadado inteiro neste evento.
        // Refetch em paralelo estourava o limite e a lista saía incompleta.
        if (full) {
          this.rememberGroup(u as GroupMetadata);
          continue;
        }
        void sock.groupMetadata(u.id).then((m) => this.rememberGroup(m)).catch(() => {});
      }
    });

    sock.ev.on("group-participants.update", (event) => {
      void sock.groupMetadata(event.id).then((m) => this.rememberGroup(m)).catch(() => {});
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      const orgId = this.organizationId;
      if (!orgId) {
        log.warn(
          { channelId: this.channelId },
          "[baileys] mensagens recebidas sem organizationId cacheado — descartando",
        );
        return;
      }
      for (const msg of messages) {
        if (!msg.message) continue;
        if (!shouldHandleUpsertMessage(type, msg.key)) continue;
        // CRITICAL: o callback `sock.ev.on` é disparado fora do
        // AsyncLocalStorage scope estabelecido em BaileysManager. Sem
        // o `withSystemContext` aqui, queries scoped (prisma extension
        // + withOrgFromCtx) e helpers que dependem de `getOrgIdOrThrow`
        // (ex.: ensureOpenDealForContact → criação do deal "Lead de
        // Entrada") falhavam silenciosamente — contato e conversa eram
        // criados, mas o deal não.
        void withSystemContext(orgId, () => handleBaileysMessage(this.channelId, msg, sock));
      }
    });

    sock.ev.on("messages.update", (updates) => {
      // Mesmo motivo do messages.upsert: callback fora do ALS → precisa
      // withSystemContext, senão prisma scoped joga e o ACK (incl. read)
      // nunca grava — ticks azuis nunca aparecem ao vivo.
      for (const u of updates) {
        const status = u.update?.status;
        if (status !== undefined && status !== null && u.key?.id) {
          void this.handleMessageStatusUpdate(u.key.id, status as number);
        }
      }
    });
  }

  private async handleMessageStatusUpdate(wamid: string, baileysStatus: number) {
    const statusMap: Record<number, string> = { 2: "sent", 3: "delivered", 4: "read" };
    const s = statusMap[baileysStatus];
    if (!s) return;

    const orgId = this.organizationId;
    if (!orgId) {
      log.warn(
        { channelId: this.channelId, status: s },
        "[baileys] status sem organizationId cacheado — descartando",
      );
      return;
    }

    try {
      await withSystemContext(orgId, async () => {
        const msg = await prisma.message.findFirst({
          where: { externalId: wamid },
          select: { id: true, externalId: true, sendStatus: true, conversationId: true },
        });
        if (!msg) return;

        const priority: Record<string, number> = {
          failed: 0,
          sent: 1,
          delivered: 2,
          read: 3,
        };
        // sendStatus pode vir em MAIÚSCULAS de outros caminhos — normaliza.
        const current = (msg.sendStatus ?? "").toLowerCase();
        if ((priority[s] ?? 0) <= (priority[current] ?? -1)) return;

        await prisma.message.update({
          where: { id: msg.id },
          data: { sendStatus: s },
        });
        void noteMessageChange(orgId, msg.conversationId, "upd", msg.id, msg.externalId);

        // O front usa `externalId ?? id` como id da bolha; publicar só o
        // UUID interno faz o update otimista do tick (incl. read azul)
        // nunca casar. Envia bubbleId + internalId, igual ao path Meta.
        publishMessageStatus({
          organizationId: orgId,
          conversationId: msg.conversationId,
          messageId: msg.externalId ?? msg.id,
          internalId: msg.id,
          status: s,
        });
      });
    } catch (err) {
      log.warn({ channelId: this.channelId, err }, "[baileys] Erro ao atualizar status");
    }
  }

  private async patchChannel(
    data: Prisma.ChannelUpdateInput,
    status?: string,
  ): Promise<void> {
    const orgId = this.organizationId;
    if (!orgId) {
      log.warn({ channelId: this.channelId }, "[baileys] patchChannel sem organizationId");
      return;
    }
    await withSystemContext(orgId, async () => {
      await prisma.channel.update({
        where: { id: this.channelId },
        data,
      });
    });
    // Status/QR aparecem na lista de canais em cache.
    await bumpResponseFamilies(orgId, RESPONSE_FAMILIES.channels);
    try {
      publishChannelUpdated({
        organizationId: orgId,
        channelId: this.channelId,
        status: status ?? (typeof data.status === "string" ? data.status : undefined),
      });
    } catch {
      /* best-effort */
    }
  }

  private async handleConnectionUpdate(
    update: Partial<BaileysEventMap["connection.update"]>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.clearQrTimer();
      try {
        const qrDataUri = await QRCode.toDataURL(qr, { margin: 1 });
        await this.patchChannel({ status: "QR_READY", qrCode: qrDataUri }, "QR_READY");
        log.info({ channelId: this.channelId }, "[baileys] QR code gerado");

        this.qrTimer = setTimeout(() => {
          log.info({ channelId: this.channelId }, "[baileys] QR expirado — timeout");
          void this.patchChannel(
            { status: "DISCONNECTED", qrCode: null },
            "DISCONNECTED",
          );
        }, QR_TIMEOUT_MS);
      } catch (e) {
        log.error({ channelId: this.channelId, err: e }, "[baileys] erro ao gerar QR");
      }
    }

    if (connection === "open") {
      this.clearQrTimer();
      log.info(
        {
          channelId: this.channelId,
          tentativas: this.attempt,
          owner: PROCESS_OWNER,
        },
        "[baileys] conexão aberta",
      );
      this.attempt = 0;
      this.badSessionStreak = 0;
      this.openedAt = Date.now();
      const me = this.socket?.user;
      const phone = me?.id?.split(":")[0] ?? me?.id?.split("@")[0] ?? null;

      await this.patchChannel(
        {
          status: "CONNECTED",
          qrCode: null,
          lastConnectedAt: new Date(),
          phoneNumber: phone,
        },
        "CONNECTED",
      );
      log.info({ channelId: this.channelId, phone: maskPhone(phone) }, "[baileys] conectado");
      const { enqueueBaileysControl } = await import("@/lib/queue");
      void enqueueBaileysControl({ channelId: this.channelId, action: "sync-groups" });
    }

    if (connection === "close") {
      await this.handleClose(lastDisconnect?.error);
    }
  }

  private async handleClose(error: unknown): Promise<void> {
    this.clearQrTimer();
    const statusCode =
      error instanceof Boom ? error.output.statusCode : undefined;
    const message = error instanceof Error ? error.message : error ? String(error) : null;
    const uptimeMs = this.openedAt ? Date.now() - this.openedAt : null;
    this.openedAt = null;
    // Socket que caiu não serve mais: tira os listeners e fecha; o próximo
    // é criado no connect().
    this.teardownSocket();

    if (this.destroyed) {
      log.info(
        { channelId: this.channelId, status: statusCode, motivo: disconnectReasonName(statusCode) },
        "[baileys] conexão fechada (sessão encerrada)",
      );
      return;
    }

    // Ainda sem parear (QR não lido): não fica gerando QR para sempre.
    // 515 é o reinício normal logo depois de ler o QR — esse segue.
    if (!credsAreRegistered(this.creds) && statusCode !== 515) {
      this.destroyed = true;
      log.info(
        { channelId: this.channelId, status: statusCode ?? null, motivo: disconnectReasonName(statusCode) },
        "[baileys] QR não lido — sessão encerrada até pedirem conectar de novo",
      );
      await this.patchChannel({ status: "DISCONNECTED", qrCode: null }, "DISCONNECTED");
      return;
    }

    this.badSessionStreak = statusCode === 500 ? this.badSessionStreak + 1 : 0;
    this.attempt++;
    const decision = decideReconnect({
      statusCode,
      attempt: this.attempt,
      badSessionStreak: this.badSessionStreak,
    });

    log.warn(
      {
        channelId: this.channelId,
        status: statusCode ?? null,
        motivo: decision.reason,
        erro: message,
        conectadoPorMs: uptimeMs,
        tentativa: this.attempt,
        acao: decision.action,
        proximaEmMs: decision.action === "retry" ? decision.delayMs : null,
        owner: PROCESS_OWNER,
      },
      "[baileys] conexão fechada",
    );
    await this.recordDisconnect({
      at: new Date().toISOString(),
      statusCode: statusCode ?? null,
      reason: decision.reason,
      message,
      uptimeMs,
      attempt: this.attempt,
      action: decision.action,
      owner: PROCESS_OWNER,
    }).catch(() => {});

    if (decision.action === "logout") {
      this.destroyed = true;
      log.info({ channelId: this.channelId }, "[baileys] deslogado no aparelho — limpando sessão");
      const orgId = this.organizationId;
      if (orgId) {
        await withSystemContext(orgId, async () => {
          await prisma.baileysAuthKey.deleteMany({ where: { channelId: this.channelId } });
        });
      }
      await this.patchChannel({ status: "DISCONNECTED", qrCode: null }, "DISCONNECTED");
      return;
    }

    if (decision.action === "needs_qr") {
      this.destroyed = true;
      log.error(
        { channelId: this.channelId, motivo: decision.reason },
        "[baileys] sessão não aceita mais — precisa ler o QR de novo",
      );
      await this.patchChannel({ status: "FAILED", qrCode: null }, "FAILED");
      return;
    }

    // 440: outra conexão abriu esta sessão. Só volta se este processo
    // ainda é o dono da trava; senão quem tem a trava fica com o número.
    if (statusCode === 440 && this.hooks.stillOwner) {
      const owner = await this.hooks.stillOwner().catch(() => false);
      if (!owner) {
        log.warn(
          { channelId: this.channelId, owner: PROCESS_OWNER },
          "[baileys] conexão substituída e a trava é de outro processo — não reconecta",
        );
        this.hooks.onLostOwnership?.();
        return;
      }
    }

    await this.patchChannel({ status: "CONNECTING" }, "CONNECTING");
    this.scheduleReconnect(decision.delayMs);
  }

  private scheduleReconnect(delayMs: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      void this.connect().catch((err) => {
        log.error(
          { channelId: this.channelId, err: err instanceof Error ? err.message : err },
          "[baileys] reconexão falhou antes de abrir o socket",
        );
        // Banco/rede fora no meio do connect(): tenta de novo pela mesma regra.
        this.attempt++;
        const next = decideReconnect({ statusCode: undefined, attempt: this.attempt, badSessionStreak: 0 });
        if (next.action === "retry" && !this.destroyed) this.scheduleReconnect(next.delayMs);
      });
    }, delayMs);
  }

  /** Último motivo de queda em `Channel.sessionData.lastDisconnect` (diagnóstico). */
  private async recordDisconnect(info: Record<string, unknown>): Promise<void> {
    const orgId = this.organizationId;
    if (!orgId) return;
    await withSystemContext(orgId, async () => {
      const row = await prisma.channel.findUnique({
        where: { id: this.channelId },
        select: { sessionData: true },
      });
      const prev =
        row?.sessionData && typeof row.sessionData === "object" && !Array.isArray(row.sessionData)
          ? (row.sessionData as Record<string, unknown>)
          : {};
      await prisma.channel.update({
        where: { id: this.channelId },
        data: { sessionData: { ...prev, lastDisconnect: info } as Prisma.InputJsonValue },
      });
    });
  }

  rememberGroup(meta: GroupMetadata): void {
    if (!meta?.id) return;
    this.groupCache.set(meta.id, meta);
  }

  discoveredGroupSnapshots(): BaileysGroupSnapshot[] {
    return [...this.discoveredGroups.values()];
  }

  private async persistDiscovered(snaps: BaileysGroupSnapshot[]): Promise<void> {
    const fresh = snaps.filter((snap) => {
      if (!snap.jid.endsWith("@g.us")) return false;
      const prev = this.discoveredGroups.get(snap.jid);
      if (!prev) return true;
      if (prev.partial && !snap.partial) return true;
      return Boolean(snap.partial && snap.name.trim() && snap.name !== prev.name);
    });
    if (fresh.length === 0) return;
    for (const snap of fresh) {
      const prev = this.discoveredGroups.get(snap.jid);
      if (!prev || (prev.partial && !snap.partial)) {
        this.discoveredGroups.set(snap.jid, snap);
      } else if (snap.name.trim()) {
        this.discoveredGroups.set(snap.jid, { ...prev, name: snap.name });
      }
    }
    const orgId = this.organizationId;
    if (!orgId) return;
    try {
      await withSystemContext(orgId, () =>
        upsertChannelGroupSnapshots(orgId, this.channelId, fresh),
      );
    } catch (err) {
      log.warn(
        { channelId: this.channelId, err: err instanceof Error ? err.message : err },
        "[baileys] falha ao gravar grupos descobertos",
      );
    }
  }

  async sendMessage(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined> {
    if (!this.socket) throw new Error("Socket não conectado");
    if (!this.socket.user) {
      await this.waitForOpen(12_000);
      if (!this.socket?.user) {
        throw new Error("Sessão Baileys ainda conectando. Tente de novo em alguns segundos.");
      }
    }
    if (isJidGroup(jid) && !this.groupCache.has(jid)) {
      try {
        const meta = await Promise.race([
          this.socket.groupMetadata(jid),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("groupMetadata timeout")), 8_000),
          ),
        ]);
        this.rememberGroup(meta);
      } catch (err) {
        log.warn(
          { channelId: this.channelId, jid, err: err instanceof Error ? err.message : err },
          "[baileys] groupMetadata falhou",
        );
      }
    }
    const dest = this.groupCache.get(jid)?.id ?? jid;
    // Baileys 7 cifra grupo com sender-keys + addressing LID. Cache
    // parcial (groups.update) fazia o relay pular o groupMetadata vivo.
    return this.socket.sendMessage(
      dest,
      content,
      dest.endsWith("@g.us") ? { useCachedGroupMetadata: false } : undefined,
    );
  }

  /**
   * Desligamento do processo (deploy/restart): fecha o socket SEM mudar o
   * status e sem apagar nada. O próximo worker reabre a mesma sessão com as
   * credenciais salvas — sem QR. Antes este caminho gravava DISCONNECTED e
   * o boot só reconectava CONNECTED/CONNECTING: todo deploy derrubava o número.
   */
  async stop(): Promise<void> {
    this.destroyed = true;
    this.clearQrTimer();
    this.clearReconnectTimer();
    detachContactTyping(this.channelId);
    this.teardownSocket();
    log.info({ channelId: this.channelId, owner: PROCESS_OWNER }, "[baileys] sessão parada (sem mudar status)");
  }

  /** Desconexão pedida (ação "disconnect"): fecha e marca DISCONNECTED. */
  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.clearQrTimer();
    this.clearReconnectTimer();
    this.groupCache.clear();
    this.discoveredGroups.clear();
    clearChannelMap(this.channelId);
    detachContactTyping(this.channelId);
    this.teardownSocket();
    await this.patchChannel({ status: "DISCONNECTED", qrCode: null }, "DISCONNECTED");
  }

  async logout(): Promise<void> {
    this.clearQrTimer();
    this.clearReconnectTimer();
    this.groupCache.clear();
    this.discoveredGroups.clear();
    clearChannelMap(this.channelId);
    if (!this.socket) {
      await this.connect();
      await this.waitForOpen(8_000);
    } else if (!this.socket.user) {
      await this.waitForOpen(4_000);
    }
    this.destroyed = true;
    detachContactTyping(this.channelId);
    try {
      if (this.socket) {
        await this.socket.logout();
        log.info({ channelId: this.channelId }, "[baileys] logout enviado ao WhatsApp");
      }
    } catch (err) {
      log.warn({ channelId: this.channelId, err }, "[baileys] logout falhou");
      try {
        this.socket?.end(undefined);
      } catch {
        /* best-effort */
      }
    }
    this.socket = null;
    const orgId = this.organizationId;
    if (orgId) {
      await withSystemContext(orgId, async () => {
        await prisma.baileysAuthKey.deleteMany({ where: { channelId: this.channelId } });
      });
    }
    await this.patchChannel(
      { status: "DISCONNECTED", qrCode: null, sessionData: Prisma.JsonNull },
      "DISCONNECTED",
    );
  }

  private waitForOpen(ms: number): Promise<void> {
    if (this.socket?.user) return Promise.resolve();
    const sock = this.socket;
    if (!sock) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sock.ev.off("connection.update", onUp);
        resolve();
      }, ms);
      const onUp = (update: Partial<BaileysEventMap["connection.update"]>) => {
        if (update.connection === "open") {
          clearTimeout(timer);
          sock.ev.off("connection.update", onUp);
          resolve();
        }
      };
      sock.ev.on("connection.update", onUp);
    });
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearQrTimer() {
    if (this.qrTimer) {
      clearTimeout(this.qrTimer);
      this.qrTimer = null;
    }
  }
}
