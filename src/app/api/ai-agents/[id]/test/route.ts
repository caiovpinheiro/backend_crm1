import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { getVerticalPack, runVerticalIntercepts } from "@/verticals";
import { runAgent } from "@/services/ai/runner";
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

    // Simulação dry-run: env mínimo; interceptos que precisam de send/DB
    // reais devem no-op ou short-circuit via helpers ausentes.
    if (pack) {
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
