import { prisma } from "@/lib/prisma";
import { subscribeOutboundStatus } from "@/lib/outbound-status-signal";

/**
 * RT-7 / P-8: teto de 15 s (era 40 s — maior que o timeout típico de
 * gateway, o cliente recebia 502 com a mensagem já enviada e reenviava).
 * O worker leva segundos, não dezenas; passado o teto a rota devolve
 * `pending` e o `message_status` do SSE fecha o ciclo.
 */
export const DEFAULT_WAIT_SEND_TIMEOUT_MS = 15_000;
export const WAIT_SEND_POLL_MIN_MS = 250;
export const WAIT_SEND_POLL_MAX_MS = 2_000;

export type WaitSendResult = "sent" | "failed" | "timeout";

type WaitDeps = {
  /** Injeção para teste: leitura do status no banco. */
  readStatus?: (messageId: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
};

async function readStatusFromDb(messageId: string): Promise<string | null> {
  const row = await prisma.message.findUnique({
    where: { id: messageId },
    select: { sendStatus: true },
  });
  return row?.sendStatus ?? null;
}

function toFinal(status: string | null): "sent" | "failed" | null {
  const s = (status ?? "").toLowerCase();
  if (s === "sent") return "sent";
  if (s === "failed") return "failed";
  return null;
}

/**
 * Bloqueia até o worker marcar o envio Meta (`sent`/`failed`).
 * Usado na sequência de modelo interno (texto+imagem) para a Graph
 * receber os itens na ordem, em vez de texto na fila outbound e mídia
 * na fila attach em paralelo.
 *
 * Estratégia: assina `crm:outbound:status:<id>` (o worker publica ao
 * terminar) e, em paralelo, faz polling no banco com backoff 250 → 2000 ms
 * como fallback (Redis ausente, sinal perdido). Quem chegar primeiro vence.
 */
export async function waitForMessageSendStatus(
  messageId: string,
  timeoutMs = DEFAULT_WAIT_SEND_TIMEOUT_MS,
  deps: WaitDeps = {},
): Promise<WaitSendResult> {
  const readStatus = deps.readStatus ?? readStatusFromDb;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const deadline = Date.now() + timeoutMs;
  const signal = subscribeOutboundStatus(messageId, { timeoutMs });
  // Sem Redis (ou sinal expirado) o race passa a depender só do polling.
  const never = new Promise<never>(() => {});
  let signalPromise: Promise<"sent" | "failed" | null> = signal.promise;

  try {
    // Só depois do SUBSCRIBE confirmado a leitura inicial é segura contra
    // a corrida "worker publicou entre o findUnique e o subscribe".
    await signal.ready;

    let delay = WAIT_SEND_POLL_MIN_MS;
    for (;;) {
      const fromDb = toFinal(await readStatus(messageId));
      if (fromDb) return fromDb;

      const remaining = deadline - Date.now();
      if (remaining <= 0) return "timeout";

      const winner = await Promise.race([
        signalPromise,
        sleep(Math.min(delay, remaining)).then(() => "poll" as const),
      ]);
      if (winner === "sent" || winner === "failed") return winner;
      if (winner === null) {
        signalPromise = never;
        continue;
      }
      delay = Math.min(delay * 2, WAIT_SEND_POLL_MAX_MS);
    }
  } finally {
    signal.dispose();
  }
}
