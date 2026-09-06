/**
 * Runner principal do agente de IA.
 *
 * Um "run" é uma invocação completa do agente respondendo a um ponto
 * de entrada (inbox, playground, step de automation). Resolve o
 * contexto (contato/deal/conversa/histórico), monta system prompt,
 * chama o LLM com tool-loop e persiste trace + custo.
 *
 * Fluxo:
 *   1. Carrega agente + config. Aplica check de autonomia/cap diário.
 *   2. Monta histórico dos últimos N turns (user ↔ assistant).
 *   3. Renderiza system prompt (template + overrides + variáveis do
 *      contato).
 *   4. Chama `generateWithTools` com o tool-loop (até 8 passos).
 *   5. Persiste `AIAgentRun` + `AIAgentMessage` (trace) + custo.
 *
 * Quem **envia a mensagem pro cliente** é quem chamou o runner (o
 * webhook ou o playground). O runner só devolve o texto final e
 * indica se houve handoff.
 */

import type { AIAgentAutonomy, Prisma } from "@prisma/client";

import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { runWithActor } from "@/lib/request-context";
import { estimateCost } from "@/lib/ai-agents/pricing";
import {
  normalizeOutputStyle,
  normalizeQualificationQuestions,
} from "@/lib/ai-agents/piloting";
import { DEFAULT_CHAT_MODEL, generateWithTools } from "@/services/ai/provider";
import {
  ACADEMIC_CURRICULUM_TCE_RULES,
  academicExamModalityRules,
  formatCanonicalPortalAccessHint,
  formatExamAccessHint,
  formatFirstAccessHint,
  formatPasswordResetHint,
  formatParticipationCertificateHint,
  formatPoloAddressesHint,
} from "@/lib/ai-agents/academic-atendimento-prompt";
import {
  fallbackSteeringRules,
  renderSystemPrompt,
} from "@/lib/ai-agents/system-prompt";
import {
  formatCampaignDispatchBlock,
  hydrateOutboundTemplateContent,
  loadLastCampaignDispatchContext,
} from "@/services/ai/campaign-context";
import { formatLocalClockHint } from "@/services/ai/idle-followup";
import {
  formatMessageModelsBlock,
  pickFollowUpMedia,
  retrieveRelevantMessageModels,
  type AgentFaqMedia,
} from "@/services/ai/message-models-retrieval";
import {
  formatRetrievalBlock,
  retrieveRelevantChunks,
} from "@/services/ai/retrieval";
import {
  normalizeInboxPolicy,
  normalizeToolConfig,
} from "@/lib/ai-agents/steering";
import {
  behaviorSliceFromAgent,
  hashAgentBehaviorConfig,
} from "@/lib/ai-agents/observability";
import { buildToolSet, type RunContext } from "@/services/ai/tools";

export type RunSource = "inbox" | "playground" | "automation" | "api";

/** Limite do tool-loop — NÃO alterar sem decisão explícita (Onda 0 só observa). */
export const AGENT_MAX_STEPS = 8;

export {
  fallbackSteeringRules,
  renderSystemPrompt,
  type RenderArgs,
} from "@/lib/ai-agents/system-prompt";

export type RunArgs = {
  agentId: string;
  source: RunSource;
  /// Conteúdo do usuário (cliente). No playground é livre; no inbox
  /// é a última mensagem recebida.
  userMessage: string;
  conversationId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  /// Turns anteriores (para manter contexto). Se omitido e tiver
  /// conversationId, o runner busca automaticamente as últimas 10.
  history?: Array<{ role: "user" | "assistant"; content: string }>;
};

export type RunResult = {
  runId: string;
  text: string;
  status: "COMPLETED" | "FAILED" | "HANDOFF";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  autonomyMode: AIAgentAutonomy;
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  /// Tutorial do modelo interno casado — o inbox envia depois do texto.
  followUpMedia?: AgentFaqMedia[];
  error?: string;
};

const MAX_HISTORY = 10;

export async function runAgent(args: RunArgs): Promise<RunResult> {
  const agent = await prisma.aIAgentConfig.findUnique({
    where: { id: args.agentId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!agent) throw new Error("Agente não encontrado.");
  if (!agent.active) throw new Error("Agente inativo.");

  // Todo o restante roda como ator AI — qualquer logEvent disparado por
  // tool calls (move_stage, add_tag, transfer_to_human, etc.) sai
  // imputado ao agente IA em vez do humano da sessao que originou.
  return runWithActor(
    {
      type: "AI",
      label: agent.user?.name ?? "IA",
      ref: agent.id,
    },
    async () => {

  if (agent.dailyTokenCap > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const usage = await prisma.aIAgentRun.aggregate({
      where: { agentId: agent.id, createdAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    const used =
      (usage._sum.inputTokens ?? 0) + (usage._sum.outputTokens ?? 0);
    if (used >= agent.dailyTokenCap) {
      throw new Error(
        `Cap diário de tokens atingido (${used}/${agent.dailyTokenCap}).`,
      );
    }
  }

  const configHash = hashAgentBehaviorConfig(behaviorSliceFromAgent(agent));

  const run = await prisma.aIAgentRun.create({
    data: withOrgFromCtx({
      agentId: agent.id,
      source: args.source,
      conversationId: args.conversationId ?? null,
      contactId: args.contactId ?? null,
      status: "RUNNING" as const,
      configHash,
      llmInvoked: true,
      interceptsFired: [] as unknown as Prisma.InputJsonValue,
      stepCountReached: false,
    }),
  });

  try {
    const contact = args.contactId
      ? await prisma.contact.findUnique({
          where: { id: args.contactId },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            lifecycleStage: true,
            tags: { include: { tag: { select: { name: true } } } },
          },
        })
      : null;

    const deal = args.dealId
      ? await prisma.deal.findUnique({
          where: { id: args.dealId },
          include: {
            stage: {
              select: {
                name: true,
                pipelineId: true,
                pipeline: { select: { name: true } },
              },
            },
          },
        })
      : null;

    const history =
      args.history ??
      (await loadHistoryFromConversation(args.conversationId ?? null));

    // RAG: busca trechos da base de conhecimento do agente relevantes
    // pra mensagem atual. Se não houver docs, retorna [] rapidamente.
    const retrievedChunks = await retrieveRelevantChunks(
      agent.id,
      args.userMessage,
      4,
    ).catch((err) => {
      console.warn(`[ai] RAG falhou, seguindo sem contexto: ${err}`);
      return [];
    });
    const retrievalBlock = formatRetrievalBlock(retrievedChunks);

    const qualificationQuestions = normalizeQualificationQuestions(
      agent.qualificationQuestions,
    );
    const outputStyle = normalizeOutputStyle(agent.outputStyle);

    const isAcademicAttendance = agent.archetype === "ATENDIMENTO";
    // Modelos internos do CRM (tela Internos) — só ATENDIMENTO; denylist
    // de retenção fica em message-models-retrieval.
    const retrievedModels = isAcademicAttendance
      ? await retrieveRelevantMessageModels(args.userMessage, 3).catch(
          (err) => {
            console.warn(
              `[ai] modelos internos RAG falhou, seguindo sem: ${err}`,
            );
            return [];
          },
        )
      : [];
    const messageModelsBlock = isAcademicAttendance
      ? formatMessageModelsBlock(retrievedModels)
      : "";
    const followUpMedia = pickFollowUpMedia(retrievedModels);
    // Últimos turnos: "quero sim" herda o assunto (portal/AVA) da pergunta anterior.
    const recentContextForHint = history
      .slice(-4)
      .map((m) => m.content)
      .join("\n");
    const portalAccessHint = isAcademicAttendance
      ? formatCanonicalPortalAccessHint(args.userMessage, recentContextForHint)
      : "";
    const campaignCtx = await loadLastCampaignDispatchContext(
      args.conversationId ?? null,
      args.contactId ?? null,
    ).catch((err) => {
      console.warn(`[ai] contexto de campanha falhou: ${err}`);
      return null;
    });
    const campaignDispatchBlock = formatCampaignDispatchBlock(campaignCtx);
    // Fato da operação: toda prova é online. Se um dia voltar a existir
    // prova presencial, a org grava `ai.exams.onlineOnly=false` em
    // `PUT /api/settings/org` — sem deploy. Falha de contexto/org cai no
    // default seguro (online).
    const examsOnlineOnly = isAcademicAttendance
      ? await getOrgSettingBool("ai.exams.onlineOnly", true).catch(() => true)
      : true;
    const examAccessHint = isAcademicAttendance
      ? formatExamAccessHint(
          args.userMessage,
          [recentContextForHint, campaignCtx?.body ?? ""]
            .filter(Boolean)
            .join("\n"),
          examsOnlineOnly,
        )
      : "";
    const poloAddressesHint = isAcademicAttendance
      ? formatPoloAddressesHint(args.userMessage, recentContextForHint)
      : "";
    const certificateHint = isAcademicAttendance
      ? formatParticipationCertificateHint(
          args.userMessage,
          [recentContextForHint, campaignCtx?.body ?? ""]
            .filter(Boolean)
            .join("\n"),
        )
      : "";
    const firstAccessHint = isAcademicAttendance
      ? formatFirstAccessHint(args.userMessage, recentContextForHint)
      : "";
    const passwordResetHint = isAcademicAttendance
      ? formatPasswordResetHint(args.userMessage, recentContextForHint)
      : "";
    const clockHint = isAcademicAttendance ? formatLocalClockHint() : "";
    const retrievalWithModels = [
      retrievalBlock,
      messageModelsBlock,
      portalAccessHint,
      examAccessHint,
      poloAddressesHint,
      certificateHint,
      firstAccessHint,
      passwordResetHint,
      campaignDispatchBlock,
      clockHint,
    ]
      .filter(Boolean)
      .join("\n");

    const runtimeTools = agent.enabledTools;
    const steeringRules =
      agent.steeringRules?.trim() || fallbackSteeringRules(agent.archetype);
    const runtimeOverride =
      [
        agent.systemPromptOverride?.trim(),
        steeringRules,
        isAcademicAttendance ? academicExamModalityRules(examsOnlineOnly) : "",
        isAcademicAttendance ? ACADEMIC_CURRICULUM_TCE_RULES : "",
      ]
        .filter(Boolean)
        .join("\n\n") || null;

    const systemPrompt = renderSystemPrompt({
      template: agent.systemPromptTemplate,
      override: runtimeOverride,
      productPolicy: agent.productPolicy,
      hasProductSearch: runtimeTools.includes("search_products"),
      hasEnrollmentLookup: runtimeTools.includes("consultar_matricula"),
      tone: agent.tone,
      language: agent.language,
      autonomyMode: agent.autonomyMode,
      contact,
      deal,
      retrievalBlock: retrievalWithModels,
      qualificationQuestions,
      outputStyle,
    });

    await prisma.aIAgentRun.update({
      where: { id: run.id },
      data: { systemPromptSnapshot: systemPrompt },
    });

    const ctx: RunContext = {
      agentUserId: agent.userId,
      agentId: agent.id,
      conversationId: args.conversationId ?? null,
      contactId: args.contactId ?? null,
      dealId: args.dealId ?? null,
      userMessage: args.userMessage,
      inboxPolicy: normalizeInboxPolicy(agent.inboxPolicy),
    };

    const toolSet = buildToolSet(
      ctx,
      runtimeTools,
      normalizeToolConfig(agent.toolConfig),
    );

    const messages: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [
      ...history,
      { role: "user", content: args.userMessage },
    ];

    await prisma.aIAgentMessage.create({
      data: withOrgFromCtx({ runId: run.id, role: "system", content: systemPrompt }),
    });
    await prisma.aIAgentMessage.create({
      data: withOrgFromCtx({ runId: run.id, role: "user", content: args.userMessage }),
    });

    const result = await generateWithTools({
      model: agent.model || DEFAULT_CHAT_MODEL,
      system: systemPrompt,
      messages,
      tools: Object.keys(toolSet).length > 0 ? toolSet : undefined,
      temperature: agent.temperature,
      maxOutputTokens: agent.maxTokens,
      maxSteps: AGENT_MAX_STEPS,
    });

    const stepCountReached = result.steps >= AGENT_MAX_STEPS;
    if (stepCountReached) {
      console.warn("[ai] maxSteps reached", {
        agentId: agent.id,
        conversationId: args.conversationId ?? null,
        steps: result.steps,
        maxSteps: AGENT_MAX_STEPS,
      });
    }

    for (const call of result.toolCalls) {
      await prisma.aIAgentMessage.create({
        data: withOrgFromCtx({
          runId: run.id,
          role: "tool",
          toolName: call.toolName,
          content: "",
          toolData: {
            args: call.args ?? null,
            result: call.result ?? null,
          } as Prisma.InputJsonValue,
        }),
      });
    }
    if (result.text) {
      await prisma.aIAgentMessage.create({
        data: withOrgFromCtx({ runId: run.id, role: "assistant", content: result.text }),
      });
    }

    const costUsd = estimateCost(
      agent.model,
      result.inputTokens,
      result.outputTokens,
    );

    const hadTransfer = result.toolCalls.some((c) =>
      [
        "transfer_to_human",
        "transfer_to_department",
        "execute_distribution",
      ].includes(c.toolName),
    );
    const status: RunResult["status"] = hadTransfer ? "HANDOFF" : "COMPLETED";

    await prisma.aIAgentRun.update({
      where: { id: run.id },
      data: {
        status,
        handoffReason: hadTransfer ? "tool_transfer" : null,
        responsePreview: result.text.slice(0, 500),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd,
        finishedAt: new Date(),
        systemPromptSnapshot: systemPrompt,
        configHash,
        llmInvoked: true,
        stepCountReached,
      },
    });

    return {
      runId: run.id,
      text: result.text,
      status,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd,
      autonomyMode: agent.autonomyMode,
      toolCalls: result.toolCalls.map((c) => ({
        name: c.toolName,
        args: c.args,
        result: c.result,
      })),
      followUpMedia: status === "COMPLETED" ? followUpMedia : [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.aIAgentRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        errorMessage: message.slice(0, 500),
        finishedAt: new Date(),
      },
    }).catch(() => null);
    return {
      runId: run.id,
      text: "",
      status: "FAILED",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      autonomyMode: "DRAFT",
      toolCalls: [],
      error: message,
    };
  }
    },
  ) as Promise<RunResult>;
}

async function loadHistoryFromConversation(
  conversationId: string | null,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  if (!conversationId) return [];
  const msgs = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY,
    select: {
      content: true,
      direction: true,
      messageType: true,
      templateConfigId: true,
      senderName: true,
    },
  });
  const chronological = msgs.reverse().filter((m) => !!m.content);
  const hydrated = await Promise.all(
    chronological.map(async (m) => {
      const raw = m.content ?? "";
      const content =
        m.direction === "out"
          ? await hydrateOutboundTemplateContent({
              content: raw,
              messageType: m.messageType,
              templateConfigId: m.templateConfigId,
              senderName: m.senderName,
            })
          : raw;
      return {
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        content,
      };
    }),
  );
  return hydrated;
}
