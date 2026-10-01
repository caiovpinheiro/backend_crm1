/**
 * Sinal "envio terminou" do worker `meta-outbound` para quem espera na API
 * (`waitUntilSent` em POST /messages e /attachments).
 *
 * Antes (RT-7 / P-8) a API fazia `message.findUnique` a cada 250 ms por até
 * 40 s — ~160 queries por envio esperado e request mais longa que o timeout
 * típico de gateway (30 s). Agora o worker publica
 * `crm:outbound:status:<messageId>` no Redis assim que grava `sent`/`failed`
 * e a API acorda no mesmo instante; o polling fica só como fallback (com
 * backoff) para Redis ausente ou mensagem perdida.
 *
 * Uma única conexão de subscribe por processo (ioredis em modo subscriber
 * só aceita SUBSCRIBE/UNSUBSCRIBE), com dispatch por canal em memória.
 * Tudo best-effort: sem REDIS_URL ou com Redis fora, publish é no-op e
 * `waitForOutboundStatusSignal` só resolve pelo timeout.
 */
import IORedis from "ioredis";

export const OUTBOUND_STATUS_CHANNEL_PREFIX = "crm:outbound:status:";

export type OutboundFinalStatus = "sent" | "failed";

type StatusListener = (status: OutboundFinalStatus) => void;

const globalForSignal = globalThis as unknown as {
  outboundStatusPub?: IORedis | null;
  outboundStatusSub?: IORedis | null;
  outboundStatusListeners?: Map<string, Set<StatusListener>>;
};

function redisUrl(): string | null {
  const url = process.env.REDIS_URL?.trim();
  return url ? url : null;
}

export function outboundStatusChannel(messageId: string): string {
  return `${OUTBOUND_STATUS_CHANNEL_PREFIX}${messageId}`;
}

function parseStatus(raw: string): OutboundFinalStatus | null {
  try {
    const parsed = JSON.parse(raw) as { status?: unknown };
    const status = typeof parsed?.status === "string" ? parsed.status : "";
    if (status === "sent" || status === "failed") return status;
  } catch {
    /* payload inválido: ignora */
  }
  return null;
}

function getPub(): IORedis | null {
  const url = redisUrl();
  if (!url) return null;
  if (globalForSignal.outboundStatusPub === undefined) {
    const client = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    client.on("error", () => {
      /* best-effort: erro de Redis não pode derrubar o worker */
    });
    void client.connect().catch(() => {});
    globalForSignal.outboundStatusPub = client;
  }
  return globalForSignal.outboundStatusPub ?? null;
}

function listeners(): Map<string, Set<StatusListener>> {
  if (!globalForSignal.outboundStatusListeners) {
    globalForSignal.outboundStatusListeners = new Map();
  }
  return globalForSignal.outboundStatusListeners;
}

function getSub(): IORedis | null {
  const url = redisUrl();
  if (!url) return null;
  if (globalForSignal.outboundStatusSub === undefined) {
    const client = new IORedis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    client.on("error", () => {
      /* best-effort */
    });
    client.on("message", (channel: string, raw: string) => {
      const set = listeners().get(channel);
      if (!set || set.size === 0) return;
      const status = parseStatus(raw);
      if (!status) return;
      for (const fn of Array.from(set)) {
        try {
          fn(status);
        } catch {
          /* listener não pode quebrar o dispatch */
        }
      }
    });
    void client.connect().catch(() => {});
    globalForSignal.outboundStatusSub = client;
  }
  return globalForSignal.outboundStatusSub ?? null;
}

/**
 * Worker: avisa quem espera que a mensagem terminou. Chamar DEPOIS de
 * gravar `sendStatus` no banco — quem recebe o sinal confia nele sem
 * reler a linha.
 */
export async function publishOutboundStatus(
  messageId: string,
  status: OutboundFinalStatus,
): Promise<void> {
  const pub = getPub();
  if (!pub) return;
  try {
    await pub.publish(
      outboundStatusChannel(messageId),
      JSON.stringify({ status, at: Date.now() }),
    );
  } catch {
    /* best-effort: a API tem o polling de fallback */
  }
}

export type OutboundStatusSubscription = {
  /** Resolve com o status final ou `null` no timeout. */
  promise: Promise<OutboundFinalStatus | null>;
  /**
   * Resolve `true` quando o SUBSCRIBE foi confirmado (a partir daí nenhum
   * publish se perde) e `false` se não há Redis / não confirmou a tempo.
   */
  ready: Promise<boolean>;
  /** Cancela: desregistra o listener e faz UNSUBSCRIBE se ninguém mais ouve. */
  dispose: () => void;
};

/**
 * API: assina o canal da mensagem. `ready` deve ser aguardado ANTES da
 * primeira leitura do banco, senão o worker pode publicar entre a leitura
 * e o SUBSCRIBE e o sinal se perde (o polling de fallback ainda cobre).
 */
export function subscribeOutboundStatus(
  messageId: string,
  opts: { timeoutMs: number; readyTimeoutMs?: number },
): OutboundStatusSubscription {
  const sub = getSub();
  const channel = outboundStatusChannel(messageId);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 500;

  if (!sub) {
    return {
      promise: Promise.resolve(null),
      ready: Promise.resolve(false),
      dispose: () => {},
    };
  }

  let settled = false;
  let resolveStatus: (s: OutboundFinalStatus | null) => void = () => {};
  const promise = new Promise<OutboundFinalStatus | null>((resolve) => {
    resolveStatus = resolve;
  });

  const listener: StatusListener = (status) => finish(status);

  const set = listeners().get(channel) ?? new Set<StatusListener>();
  const firstListener = set.size === 0;
  set.add(listener);
  listeners().set(channel, set);

  const timer = setTimeout(() => finish(null), opts.timeoutMs);
  timer.unref?.();

  const dispose = () => {
    const current = listeners().get(channel);
    if (current) {
      current.delete(listener);
      if (current.size === 0) {
        listeners().delete(channel);
        void sub.unsubscribe(channel).catch(() => {});
      }
    }
  };

  function finish(status: OutboundFinalStatus | null) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    dispose();
    resolveStatus(status);
  }

  const ready = firstListener
    ? new Promise<boolean>((resolve) => {
        const readyTimer = setTimeout(() => resolve(false), readyTimeoutMs);
        readyTimer.unref?.();
        sub
          .subscribe(channel)
          .then(() => {
            clearTimeout(readyTimer);
            resolve(true);
          })
          .catch(() => {
            clearTimeout(readyTimer);
            resolve(false);
          });
      })
    : Promise.resolve(true);

  return { promise, ready, dispose: () => finish(null) };
}

/** Só para testes: zera conexões e listeners do processo. */
export function __resetOutboundStatusSignalForTests(): void {
  globalForSignal.outboundStatusPub?.disconnect();
  globalForSignal.outboundStatusSub?.disconnect();
  globalForSignal.outboundStatusPub = undefined;
  globalForSignal.outboundStatusSub = undefined;
  globalForSignal.outboundStatusListeners = undefined;
}
