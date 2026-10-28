/**
 * Webchat v2 — callback de situação para o site
 * (docs/decisoes/webchat-widget.md §9.6).
 *
 * Opcional: só com `config.v2.s2s.callbackUrl` (https) e segredo S2S no
 * canal. `POST` com `X-Timestamp`/`X-Signature` (mesma assinatura da
 * entrada) e corpo `{ ref, status, conversation_id }`, um por `ref` da
 * conversa:
 *  - `attended` = primeira resposta (humano ou IA) depois do registro do ref;
 *  - `resolved` = conversa encerrada.
 * Cada status sai uma vez por ref: a linha é marcada (`lastCallbackStatus`)
 * ANTES do envio, com update condicional — dois gatilhos simultâneos não
 * mandam em dobro. Entrega: timeout 5 s, 3 tentativas com backoff, destino
 * validado contra SSRF a cada tentativa (`safeFetch`: só https público,
 * sem redirect). Tudo em segundo plano (promessa solta, nunca esperada):
 * falha nunca afeta o atendimento.
 *
 * Limite conhecido: as tentativas rodam no processo que disparou (sem fila
 * durável); se o processo cair no meio, aquele status não é reenviado.
 */
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { withSystemContext } from "@/lib/webhook-context";
import { readWebchatSecret } from "@/lib/webchat/secrets";
import { signWebchatS2S } from "@/lib/webchat/signatures";
import { readWebchatV2Config } from "@/lib/webchat/v2-config";

const log = getLogger("webchat-s2s-callback");

export type WebchatCallbackStatus = "attended" | "resolved";

export const WEBCHAT_CALLBACK_TIMEOUT_MS = 5_000;
export const WEBCHAT_CALLBACK_ATTEMPTS = 3;
/** Espera antes da 2ª e da 3ª tentativa. */
export const WEBCHAT_CALLBACK_BACKOFF_MS = [2_000, 10_000] as const;
/** Atraso antes de reler os refs (deixa a transação do chamador comitar). */
const DISPATCH_DELAY_MS = 1_000;

export type WebchatCallbackPayload = {
  ref: string;
  status: WebchatCallbackStatus;
  conversation_id: string;
};

type FetchLike = typeof safeFetch;

export type DeliverDeps = {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Cabeçalhos assinados de um envio (timestamp novo a cada tentativa). */
export function signedCallbackHeaders(secret: string, rawBody: string, nowMs: number): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    "Content-Type": "application/json",
    "X-Timestamp": timestamp,
    "X-Signature": signWebchatS2S(secret, timestamp, rawBody),
    "User-Agent": "Bwipo-Webchat-Callback/1",
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

/**
 * Entrega um callback. `true` = 2xx. Destino bloqueado (SSRF/redirect) não
 * repete; erro de rede, timeout e não-2xx repetem até 3 vezes.
 */
export async function deliverWebchatCallback(
  url: string,
  secret: string,
  payload: WebchatCallbackPayload,
  deps: DeliverDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? safeFetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.nowMs ?? Date.now;
  if (!url.startsWith("https://")) {
    log.warn({ host: hostOf(url) }, "callback do webchat ignorado: URL não é https");
    return false;
  }
  const rawBody = JSON.stringify(payload);
  for (let attempt = 1; attempt <= WEBCHAT_CALLBACK_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(WEBCHAT_CALLBACK_BACKOFF_MS[attempt - 2] ?? 10_000);
    try {
      const res = await fetchImpl(
        url,
        { method: "POST", headers: signedCallbackHeaders(secret, rawBody, now()), body: rawBody },
        { timeoutMs: WEBCHAT_CALLBACK_TIMEOUT_MS, maxRedirects: 0 },
      );
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return true;
      log.warn({ host: hostOf(url), httpStatus: res.status, attempt }, "callback do webchat recusado");
    } catch (err) {
      if (err instanceof SafeFetchError) {
        log.warn({ host: hostOf(url), code: err.code }, "callback do webchat bloqueado (destino não permitido)");
        return false;
      }
      log.warn(
        { host: hostOf(url), attempt, err: err instanceof Error ? err.name : "erro" },
        "callback do webchat falhou",
      );
    }
  }
  return false;
}

/** Refs ainda sem este status (resolved também cobre quem nunca recebeu attended). */
function pendingStatusWhere(status: WebchatCallbackStatus) {
  return status === "attended"
    ? { lastCallbackStatus: null }
    : { OR: [{ lastCallbackStatus: null }, { lastCallbackStatus: "attended" }] };
}

/**
 * Manda o status para os refs das conversas (contexto de org ativo).
 * Devolve quantos callbacks foram entregues com sucesso.
 */
export async function dispatchWebchatCallbacks(
  conversationIds: string[],
  status: WebchatCallbackStatus,
  deps: DeliverDeps = {},
): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const refs = await prisma.webchatConversationRef.findMany({
    where: { conversationId: { in: conversationIds }, ...pendingStatusWhere(status) },
    select: {
      id: true,
      ref: true,
      conversationId: true,
      conversation: { select: { channel: true, channelId: true, status: true } },
    },
    take: 200,
  });
  // Encerrado de fato (o gatilho pode ter vindo de uma transação desfeita).
  const eligible = refs.filter(
    (r) =>
      r.conversation?.channel === "webchat" &&
      r.conversation.channelId &&
      (status !== "resolved" || r.conversation.status === "RESOLVED"),
  );
  if (eligible.length === 0) return 0;

  const byChannel = new Map<string, typeof eligible>();
  for (const r of eligible) {
    const chId = r.conversation!.channelId!;
    byChannel.set(chId, [...(byChannel.get(chId) ?? []), r]);
  }

  let delivered = 0;
  for (const [channelId, rows] of byChannel) {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, provider: "WEBCHAT" },
      select: { config: true },
    });
    if (!channel) continue;
    const callbackUrl = readWebchatV2Config(channel.config).s2s.callbackUrl;
    const secret = readWebchatSecret(channel.config, "s2s");
    if (!callbackUrl || !secret) continue;
    for (const row of rows) {
      const claimed = await prisma.webchatConversationRef.updateMany({
        where: { id: row.id, ...pendingStatusWhere(status) },
        data: { lastCallbackStatus: status, lastCallbackAt: new Date() },
      });
      if (claimed.count !== 1) continue;
      const ok = await deliverWebchatCallback(
        callbackUrl,
        secret,
        { ref: row.ref, status, conversation_id: row.conversationId },
        deps,
      );
      if (ok) delivered++;
    }
  }
  return delivered;
}

/**
 * Gancho dos pontos onde a conversa é respondida/encerrada. Volta na hora
 * (nada é esperado); canal conhecido e diferente de webchat nem consulta
 * o banco.
 */
export function notifyWebchatConversationStatus(input: {
  organizationId: string | null | undefined;
  conversationIds: string[];
  status: WebchatCallbackStatus;
  /** `Conversation.channel`, quando o chamador já tem (atalho). */
  channel?: string | null;
}): void {
  const orgId = input.organizationId;
  if (!orgId || input.conversationIds.length === 0) return;
  if (input.channel !== undefined && input.channel !== "webchat") return;
  const ids = [...input.conversationIds];
  // Promessa solta de propósito (API e workers): o chamador nunca espera.
  // Pequeno atraso: quem encerra dentro de uma transação já comitou quando
  // o status é relido (`resolved` só sai para conversa RESOLVED de fato).
  setTimeout(() => {
    withSystemContext(orgId, () => dispatchWebchatCallbacks(ids, input.status), {
      actor: { type: "INTEGRATION", label: "Webchat" },
    }).catch((err: unknown) => log.warn({ err }, "callback do webchat: despacho falhou"));
  }, DISPATCH_DELAY_MS).unref?.();
}
