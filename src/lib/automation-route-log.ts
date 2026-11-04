/**
 * Registro de "por qual saída o contato saiu do passo".
 *
 * Alimenta o % por saída no canvas (`GET /api/automations/:id/stats` →
 * `routes`). Uma linha `ROUTED` por decisão, com a chave da saída em
 * `message`:
 *  - `btn_<i>`  → botão/opção na posição i de `buttons`/`rows`
 *  - `else`     → "Outra resposta"
 *  - `timeout`  → "Caso o contato não responda"
 *  - `received` → wait_for_reply respondido
 *  - `next`     → "Próximo passo"
 *  - `to:<id>`  → desvio por `gotoStepId` (condição, horário, distribuição…);
 *                 o front casa com a saída cujo destino é esse id.
 *
 * "Caso ocorrer erro no envio" não grava aqui: já é o `FAILED_HANDLED`.
 *
 * Falha de escrita só gera warn — telemetria não pode derrubar o fluxo.
 */
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

const log = getLogger("automation-route-log");

export const ROUTED_LOG_STATUS = "ROUTED";

export async function logAutomationRoute(args: {
  organizationId?: string | null;
  automationId: string;
  contactId?: string | null;
  dealId?: string | null;
  stepId: string;
  stepType?: string | null;
  route: string | null | undefined;
}): Promise<void> {
  const route = args.route?.trim();
  if (!route) return;
  const data = {
    automationId: args.automationId,
    contactId: args.contactId ?? null,
    dealId: args.dealId ?? null,
    stepId: args.stepId,
    stepType: args.stepType ?? null,
    status: ROUTED_LOG_STATUS,
    message: route,
  };
  try {
    await prisma.automationLog.create({
      data: args.organizationId
        ? { ...data, organizationId: args.organizationId }
        : withOrgFromCtx(data),
    });
  } catch (err) {
    log.warn(
      `falha ao gravar saída ${route} — auto=${args.automationId} step=${args.stepId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
