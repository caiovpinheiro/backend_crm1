import { prisma } from "@/lib/prisma";

const POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 40_000;

/**
 * Bloqueia até o worker marcar o envio Meta (`sent`/`failed`).
 * Usado na sequência de modelo interno (texto+imagem) para a Graph
 * receber os itens na ordem, em vez de texto na fila outbound e mídia
 * na fila attach em paralelo.
 */
export async function waitForMessageSendStatus(
  messageId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<"sent" | "failed" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.message.findUnique({
      where: { id: messageId },
      select: { sendStatus: true },
    });
    const status = (row?.sendStatus ?? "").toLowerCase();
    if (status === "sent") return "sent";
    if (status === "failed") return "failed";
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return "timeout";
}
