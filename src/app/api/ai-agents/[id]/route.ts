import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  deleteAIAgent,
  getAIAgent,
  sanitizePilotingInput,
  sanitizeSteeringInput,
  updateAIAgent,
  type UpdateAIAgentInput,
} from "@/services/ai-agents";
import { AgentReadinessError } from "@/lib/ai-agents/readiness";
import { parseAuditSource } from "@/lib/ai-agents/observability";
import type { AIAgentArchetype, AIAgentAutonomy } from "@prisma/client";

const ARCHETYPES: AIAgentArchetype[] = [
  "SDR",
  "ATENDIMENTO",
  "VENDEDOR",
  "SUPORTE",
];
const AUTONOMIES: AIAgentAutonomy[] = ["AUTONOMOUS", "DRAFT"];

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async () => {
    const { id } = await params;
    const agent = await getAIAgent(id);
    if (!agent) {
      return NextResponse.json(
        { message: "Agente não encontrado." },
        { status: 404 },
      );
    }
    return NextResponse.json(agent);
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  return withOrgContext(async () => {
    const { id } = await params;

    const archetype = body.archetype as AIAgentArchetype | undefined;
    if (archetype && !ARCHETYPES.includes(archetype)) {
      return NextResponse.json(
        { message: "Arquétipo inválido." },
        { status: 400 },
      );
    }

    const autonomyMode = body.autonomyMode as AIAgentAutonomy | undefined;
    if (autonomyMode && !AUTONOMIES.includes(autonomyMode)) {
      return NextResponse.json(
        { message: "Modo de autonomia inválido." },
        { status: 400 },
      );
    }

    const input: UpdateAIAgentInput = {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      archetype,
      model: typeof body.model === "string" ? body.model : undefined,
      temperature:
        typeof body.temperature === "number" ? body.temperature : undefined,
      maxTokens:
        typeof body.maxTokens === "number" ? body.maxTokens : undefined,
      maxSteps:
        typeof body.maxSteps === "number" ? body.maxSteps : undefined,
      templateId:
        typeof body.templateId === "string"
          ? body.templateId
          : body.templateId === null
            ? null
            : undefined,
      systemPromptOverride:
        typeof body.systemPromptOverride === "string"
          ? body.systemPromptOverride
          : body.systemPromptOverride === null
            ? null
            : undefined,
      productPolicy:
        typeof body.productPolicy === "string"
          ? body.productPolicy
          : body.productPolicy === null
            ? null
            : undefined,
      tone: typeof body.tone === "string" ? body.tone : undefined,
      language: typeof body.language === "string" ? body.language : undefined,
      autonomyMode,
      enabledTools: Array.isArray(body.enabledTools)
        ? body.enabledTools.filter((v): v is string => typeof v === "string")
        : undefined,
      dailyTokenCap:
        typeof body.dailyTokenCap === "number" ? body.dailyTokenCap : undefined,
      pipelineId:
        typeof body.pipelineId === "string"
          ? body.pipelineId
          : body.pipelineId === null
            ? null
            : undefined,
      /** @deprecated Preferir canal da conversa. */
      channelId:
        typeof body.channelId === "string"
          ? body.channelId
          : body.channelId === null
            ? null
            : undefined,
      avatarUrl:
        typeof body.avatarUrl === "string"
          ? body.avatarUrl
          : body.avatarUrl === null
            ? null
            : undefined,
      openaiApiKey:
        typeof body.openaiApiKey === "string"
          ? body.openaiApiKey
          : body.openaiApiKey === null
            ? null
            : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      ...sanitizePilotingInput({
        openingMessage: body.openingMessage,
        openingDelayMs: body.openingDelayMs,
        inactivityTimerMs: body.inactivityTimerMs,
        inactivityHandoffMode: body.inactivityHandoffMode,
        inactivityHandoffUserId: body.inactivityHandoffUserId,
        inactivityFarewellMessage: body.inactivityFarewellMessage,
        keywordHandoffs: body.keywordHandoffs,
        qualificationQuestions: body.qualificationQuestions,
        businessHours: body.businessHours,
        outputStyle: body.outputStyle,
        simulateTyping: body.simulateTyping,
        typingPerCharMs: body.typingPerCharMs,
        markMessagesRead: body.markMessagesRead,
        autoClosePolicy: body.autoClosePolicy,
      }),
      ...sanitizeSteeringInput({
        systemPromptTemplate: body.systemPromptTemplate,
        steeringRules: body.steeringRules,
        toolConfig: body.toolConfig,
        inboxPolicy: body.inboxPolicy,
        verticalPack: body.verticalPack,
      }),
      auditSource: parseAuditSource(body.auditSource ?? body.source),
    };

    try {
      const updated = await updateAIAgent(id, input);
      return NextResponse.json(updated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao atualizar.";
      const status =
        e instanceof AgentReadinessError
          ? 400
          : msg.includes("não encontrado")
            ? 404
            : 500;
      return NextResponse.json({ message: msg }, { status });
    }
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async () => {
    const { id } = await params;
    try {
      await deleteAIAgent(id);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao excluir." },
        { status: 500 },
      );
    }
  });
}
