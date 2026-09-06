import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  createAIAgent,
  listAIAgents,
  sanitizePilotingInput,
  type CreateAIAgentInput,
} from "@/services/ai-agents";
import type { AIAgentArchetype, AIAgentAutonomy } from "@prisma/client";

const ARCHETYPES: AIAgentArchetype[] = [
  "SDR",
  "ATENDIMENTO",
  "VENDEDOR",
  "SUPORTE",
];
const AUTONOMIES: AIAgentAutonomy[] = ["AUTONOMOUS", "DRAFT"];

export async function GET() {
  return withOrgContext(async () => {
    try {
      const agents = await listAIAgents();
      return NextResponse.json(agents);
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  return withOrgContext(async () => {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json(
        { message: "Nome é obrigatório." },
        { status: 400 },
      );
    }

    const archetype = body.archetype as AIAgentArchetype;
    if (!ARCHETYPES.includes(archetype)) {
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

    const input: CreateAIAgentInput = {
      name,
      archetype,
      model: typeof body.model === "string" ? body.model : undefined,
      temperature:
        typeof body.temperature === "number" ? body.temperature : undefined,
      maxTokens:
        typeof body.maxTokens === "number" ? body.maxTokens : undefined,
      systemPromptOverride:
        typeof body.systemPromptOverride === "string"
          ? body.systemPromptOverride
          : null,
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
      pipelineId: typeof body.pipelineId === "string" ? body.pipelineId : null,
      channelId: typeof body.channelId === "string" ? body.channelId : null,
      avatarUrl: typeof body.avatarUrl === "string" ? body.avatarUrl : null,
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
        useInternalModels: body.useInternalModels,
        simulateTyping: body.simulateTyping,
        typingPerCharMs: body.typingPerCharMs,
        markMessagesRead: body.markMessagesRead,
      }),
    };

    try {
      const result = await createAIAgent(input);
      return NextResponse.json(
        { id: result.config.id, userId: result.user.id },
        { status: 201 },
      );
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao criar agente." },
        { status: 500 },
      );
    }
  });
}
