import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { getVerticalPack, runVerticalIntercepts } from "@/verticals";
import { runAgent } from "@/services/ai/runner";
import { evaluateMessageRules } from "@/lib/ai-agents/message-rules";
import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";

/**
 * Playground — path inbox simulado (Onda 3):
 * 1) avalia interceptos do vertical pack (sem send real)
 * 2) se nenhum hit, chama o runner (LLM)
 * Resposta inclui interceptFired, llmInvoked e systemPromptSnapshot.
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

    const userMessage =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!userMessage) {
      return NextResponse.json(
        { message: "Mensagem vazia." },
        { status: 400 },
      );
    }

    const contactId =
      typeof body.contactId === "string" && body.contactId
        ? body.contactId
        : null;
    const dealId =
      typeof body.dealId === "string" && body.dealId ? body.dealId : null;
    const history = Array.isArray(body.history)
      ? (body.history as Array<{ role: "user" | "assistant"; content: string }>)
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string",
          )
          .slice(-10)
      : undefined;

    const agent = await prisma.aIAgentConfig.findUnique({
      where: { id },
      select: {
        id: true,
        verticalPack: true,
        inboxPolicy: true,
        archetype: true,
      },
    });
    if (!agent) {
      return NextResponse.json(
        { message: "Agente não encontrado." },
        { status: 404 },
      );
    }

    const pack = getVerticalPack(agent.verticalPack);
    let interceptFired: string | null = null;

    // Regras de mensagem do operador vêm antes de tudo, como no inbox real.
    // Aqui é dry-run: nada é enviado nem distribuído, só reportado.
    const testPolicy = normalizeInboxPolicy(
      agent.inboxPolicy,
      agent.verticalPack,
    );
    const ruleHit = evaluateMessageRules(userMessage, testPolicy.messageRules);
    if (ruleHit && ruleHit.rule.action !== "answer_with_knowledge") {
      return NextResponse.json({
        runId: null,
        text: `[regra] ${ruleHit.rule.label} → ${ruleHit.rule.action}${
          ruleHit.rule.department ? ` (${ruleHit.rule.department})` : ""
        }`,
        status: "COMPLETED",
        interceptFired: `message_rule:${ruleHit.rule.id}`,
        messageRule: {
          id: ruleHit.rule.id,
          label: ruleHit.rule.label,
          position: ruleHit.position,
          action: ruleHit.rule.action,
        },
        llmInvoked: false,
        systemPrompt: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: [],
      });
    }
    // Regra que manda responder com a base pula os interceptos do pack.
    const skipIntercepts = Boolean(ruleHit);

    // Simulação dry-run: env mínimo; interceptos que precisam de send/DB
    // reais devem no-op ou short-circuit via helpers ausentes.
    if (pack && !skipIntercepts) {
      const dryEnv: Record<string, unknown> = {
        args: {
          conversationId: "__playground__",
          contactId: contactId ?? "__playground_contact__",
          userMessage,
          channel: "meta",
        },
        conversation: { id: "__playground__", assignedToId: null },
        policy: normalizeInboxPolicy(agent.inboxPolicy, agent.verticalPack),
        playground: true,
        logAi: () => undefined,
        helpers: {
          recordInboxInterceptRun: async () => undefined,
          sendAgentMessage: async () => {
            throw new Error("playground_no_send");
          },
          isBareGreetingMessage: () => false,
          isAcademicSelfServeTurn: () => false,
        },
      };
      try {
        const hitPre = await runVerticalIntercepts(pack, {
          phase: "pre_assignee",
          env: dryEnv,
        });
        if (hitPre?.handled) {
          interceptFired = hitPre.interceptName;
        } else {
          const hitPost = await runVerticalIntercepts(pack, {
            phase: "post_assignee",
            env: dryEnv,
          });
          if (hitPost?.handled) {
            interceptFired = hitPost.interceptName;
          }
        }
      } catch (e) {
        // playground_no_send ou DB missing → trata como intercepto se nome no env
        const msg = e instanceof Error ? e.message : "";
        if (msg === "playground_no_send" && dryEnv.interceptName) {
          interceptFired = String(dryEnv.interceptName);
        }
      }
    }

    if (interceptFired) {
      return NextResponse.json({
        runId: null,
        text: `[intercepto] ${interceptFired}`,
        status: "COMPLETED",
        interceptFired,
        llmInvoked: false,
        systemPrompt: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: [],
      });
    }

    try {
      const result = await runAgent({
        agentId: id,
        source: "playground",
        userMessage,
        contactId,
        dealId,
        history,
      });

      const run = await prisma.aIAgentRun.findUnique({
        where: { id: result.runId },
        select: { systemPromptSnapshot: true },
      });

      return NextResponse.json({
        ...result,
        interceptFired: null,
        llmInvoked: true,
        systemPrompt: run?.systemPromptSnapshot ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
