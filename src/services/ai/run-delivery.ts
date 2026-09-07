/**
 * Entrega da resposta — quem envia é o inbox, então é o inbox que fecha a
 * auditoria do run.
 *
 * O runner grava `ANSWERED` assim que o LLM devolve texto. Só que entre o
 * runner e o WhatsApp existem vários pontos de descarte: dedupe de resposta
 * quase idêntica, autorização perdida (humano assumiu), canal não
 * configurado, contato sem telefone, falha no envio. Em produção um run com
 * `responsePreview` completo ficou como ANSWERED sem nenhuma outbound, e a
 * mensagem do cliente sumiu sem rastro.
 *
 * Aqui o desfecho vira `RESPONSE_DISCARDED` com o motivo persistido.
 */

import { prisma } from "@/lib/prisma";

/** Motivos de descarte — chave estável para métrica, texto para o operador. */
export const RUN_DISCARD_REASONS = {
  near_duplicate: "resposta quase idêntica à anterior",
  empty_reply: "modelo devolveu resposta vazia",
  effect_claim_blocked: "resposta afirmou efeito que não aconteceu",
  not_authorized: "autorização perdida antes do envio",
  channel_not_configured: "canal não configurado — salva como rascunho",
  contact_without_phone: "contato sem telefone — salva como rascunho",
  send_failed: "falha no envio ao canal — salva como rascunho",
  media_ignored: "anexo recebido e ignorado por configuração do agente",
} as const;

export type RunDiscardReason = keyof typeof RUN_DISCARD_REASONS;

/**
 * Desfechos que podem ser sobrescritos por um descarte. Handoff, gate,
 * tool falhada e teto continuam sendo a causa raiz — não são apagados.
 */
const OVERWRITABLE = new Set(["ANSWERED", "NO_CONTEXT", "RESPONSE_DISCARDED"]);

/**
 * Marca o run como não entregue. Best-effort: auditoria nunca derruba o
 * atendimento. Escopo de tenant vem do `prisma` scoped.
 */
export async function markRunResponseDiscarded(args: {
  runId: string;
  reason: RunDiscardReason;
  detail?: string | null;
}): Promise<void> {
  try {
    const run = await prisma.aIAgentRun.findUnique({
      where: { id: args.runId },
      select: { outcome: true, status: true },
    });
    if (!run) return;
    if (run.status === "FAILED") return;
    if (run.outcome && !OVERWRITABLE.has(run.outcome)) return;

    const message = [
      `[descartada] ${args.reason}: ${RUN_DISCARD_REASONS[args.reason]}`,
      args.detail?.trim() || null,
    ]
      .filter(Boolean)
      .join(" | ");

    await prisma.aIAgentRun.update({
      where: { id: args.runId },
      data: {
        outcome: "RESPONSE_DISCARDED",
        errorMessage: message.slice(0, 500),
      },
    });
  } catch (err) {
    console.warn("[ai] markRunResponseDiscarded falhou", {
      runId: args.runId,
      reason: args.reason,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
