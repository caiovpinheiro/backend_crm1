import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  evaluateMessageRules,
  MESSAGE_RULE_LABELS,
  normalizeMessageRules,
} from "@/lib/ai-agents/message-rules";
import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { prisma } from "@/lib/prisma";

/**
 * "Testar frase" da tela de regras: diz QUAL regra pega a mensagem e qual
 * é o próximo passo — sem enviar nada, sem chamar o modelo.
 *
 * Aceita `rules` no corpo para o operador testar a lista que está editando
 * antes de salvar; sem isso, usa o que está no banco.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  return withOrgContext(async () => {
    const { id } = await params;
    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) {
      return NextResponse.json({ message: "Mensagem vazia." }, { status: 400 });
    }

    // Escopo de organização vem do RequestContext (extension do Prisma).
    const agent = await prisma.aIAgentConfig.findUnique({
      where: { id },
      select: { id: true, inboxPolicy: true, verticalPack: true },
    });
    if (!agent) {
      return NextResponse.json(
        { message: "Agente não encontrado." },
        { status: 404 },
      );
    }

    const rules = Array.isArray(body.rules)
      ? normalizeMessageRules(body.rules)
      : normalizeInboxPolicy(agent.inboxPolicy, agent.verticalPack)
          .messageRules;

    const hit = evaluateMessageRules(message, rules);
    if (!hit) {
      return NextResponse.json({
        matched: false,
        nextStepLabel:
          "Nenhuma regra pegou esta mensagem — o agente segue o atendimento normal.",
      });
    }

    const action = MESSAGE_RULE_LABELS.actions.find(
      (a) => a.id === hit.rule.action,
    );
    return NextResponse.json({
      matched: true,
      position: hit.position,
      rule: {
        id: hit.rule.id,
        label: hit.rule.label,
        action: hit.rule.action,
        department: hit.rule.department,
      },
      nextStepLabel: action?.label ?? hit.rule.action,
    });
  });
}
