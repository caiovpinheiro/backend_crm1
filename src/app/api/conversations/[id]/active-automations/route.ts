import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import type { AppUserRole } from "@/lib/auth-types";
import { requireConversationAccess } from "@/lib/conversation-access";
import { getContactActiveContexts } from "@/services/automation-context";
import { getConversationLite } from "@/services/conversations";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Labels pt-BR dos tipos de step (subset do STEP_TYPE_LABELS do executor;
 * duplicado aqui de propósito pra rota não importar o executor inteiro,
 * que carrega BullMQ/Meta client como side effect).
 */
const STEP_LABELS: Record<string, string> = {
  send_email: "Enviando e-mail",
  move_stage: "Movendo estágio",
  assign_owner: "Atribuindo responsável",
  add_tag: "Adicionando tag",
  remove_tag: "Removendo tag",
  update_field: "Atualizando campo",
  create_activity: "Criando atividade",
  send_whatsapp_message: "Enviando mensagem",
  send_whatsapp_template: "Enviando template",
  send_whatsapp_media: "Enviando mídia",
  send_whatsapp_interactive: "Aguardando escolha do lead",
  send_whatsapp_list: "Aguardando escolha do lead",
  send_whatsapp_flow: "Aguardando formulário do lead",
  send_product: "Enviando produto",
  webhook: "Chamando webhook",
  delay: "Em espera (atraso)",
  condition: "Avaliando condição",
  update_lead_score: "Atualizando lead score",
  question: "Aguardando resposta do lead",
  wait_for_reply: "Aguardando resposta do lead",
  set_variable: "Definindo variável",
  goto: "Redirecionando fluxo",
  finish: "Finalizando",
  create_deal: "Criando negócio",
  finish_conversation: "Encerrando conversa",
  tabulate_conversation: "Tabulando conversa",
  business_hours: "Verificando horário",
  check_agent_status: "Verificando status do agente",
  execute_distribution: "Distribuindo lead",
};

export type ActiveAutomationDto = {
  contextId: string;
  automationId: string;
  name: string;
  status: "RUNNING" | "PAUSED";
  /** Descrição amigável do passo atual (ex.: "Aguardando resposta do lead"). */
  stepLabel: string | null;
  /** Quando o passo atual expira por timeout (ISO) — null se sem cronômetro. */
  timeoutAt: string | null;
  /** Última atividade do fluxo (ISO). */
  updatedAt: string;
};

/**
 * GET /api/conversations/:id/active-automations
 *
 * Automações vivas (RUNNING/PAUSED) do CONTATO da conversa — alimenta o
 * chip "robô em execução" no header do inbox. O vínculo é por contato
 * porque `AutomationContext` não referencia conversa (modelo de ticket:
 * o fluxo sobrevive à troca de ticket).
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id } = await context.params;
      const accessUser = authResult.user as { id: string; role: AppUserRole };
      const denied = await requireConversationAccess({ user: accessUser }, id);
      if (denied) return denied;

      const conv = await getConversationLite(id);
      if (!conv) {
        return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
      }
      if (!conv.contactId) {
        return NextResponse.json({ items: [] });
      }

      const contexts = await getContactActiveContexts(conv.contactId);
      const items: ActiveAutomationDto[] = contexts.map((ctx) => {
        const step = ctx.currentStepId
          ? ctx.automation.steps.find((s) => s.id === ctx.currentStepId)
          : null;
        return {
          contextId: ctx.id,
          automationId: ctx.automationId,
          name: ctx.automation.name,
          status: ctx.status as "RUNNING" | "PAUSED",
          stepLabel: step ? (STEP_LABELS[step.type] ?? step.type) : null,
          timeoutAt: ctx.timeoutAt ? ctx.timeoutAt.toISOString() : null,
          updatedAt: ctx.updatedAt.toISOString(),
        };
      });

      return NextResponse.json({ items });
    });
  } catch (e) {
    console.error("[active-automations] error:", e);
    return NextResponse.json({ message: "Erro ao buscar automações ativas." }, { status: 500 });
  }
}
