/**
 * Serviço de CRUD dos agentes de IA.
 *
 * O agente é persistido em DUAS tabelas (uma transação):
 *  - `User` com type=AI (aparece em seletores/Distribution)
 *  - `AIAgentConfig` 1:1 com User (prompt, tools, conhecimento, etc.)
 *
 * Aqui centralizamos a criação/edição/listagem pra não espalhar
 * regras de negócio pelas rotas.
 */

import { Prisma } from "@prisma/client";
import type { AIAgentArchetype, AIAgentAutonomy } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { nextUserNumber } from "@/lib/public-id";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { encryptSecret } from "@/lib/secret-crypto";
import { apiKeyHint } from "@/services/ai/agent-key";
import { getArchetype } from "@/lib/ai-agents/archetypes";
import {
  HANDOFF_MODES,
  normalizeBusinessHours,
  normalizeOutputStyle,
  normalizeQualificationQuestions,
  type BusinessHoursConfig,
  type HandoffMode,
  type OutputStyle,
  type QualificationQuestion,
} from "@/lib/ai-agents/piloting";
import {
  normalizeInboxPolicy,
  normalizeToolConfig,
  type InboxPolicy,
  type ToolConfigMap,
} from "@/lib/ai-agents/steering";

export type AIAgentRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  archetype: AIAgentArchetype;
  model: string;
  autonomyMode: AIAgentAutonomy;
  enabledTools: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  knowledgeDocsCount: number;
};

export async function listAIAgents(): Promise<AIAgentRow[]> {
  const rows = await prisma.aIAgentConfig.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
      _count: { select: { knowledgeDocs: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.user.name,
    email: r.user.email,
    avatarUrl: r.user.avatarUrl,
    archetype: r.archetype,
    model: r.model,
    autonomyMode: r.autonomyMode,
    enabledTools: r.enabledTools,
    active: r.active,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    knowledgeDocsCount: r._count.knowledgeDocs,
  }));
}

/**
 * Tira a chave OpenAI cifrada de qualquer row de `AIAgentConfig` que vá
 * para o cliente. A UI só precisa do bit "tem chave própria?" e do hint
 * (últimos 4 chars, coluna `openaiApiKeyHint`) — o `openaiApiKeyEnc`
 * nunca sai do servidor.
 *
 * Único ponto de redaction: GET, PUT e qualquer rota nova passam por
 * aqui. Antes o strip existia só no GET e o PUT devolvia o row cru do
 * Prisma direto no JSON da resposta.
 */
export function redactAgentOpenaiKey<
  T extends { openaiApiKeyEnc?: string | null },
>(row: T): Omit<T, "openaiApiKeyEnc"> & { hasOwnOpenaiKey: boolean } {
  const { openaiApiKeyEnc, ...safe } = row;
  return { ...safe, hasOwnOpenaiKey: Boolean(openaiApiKeyEnc) };
}

export async function getAIAgent(id: string) {
  const row = await prisma.aIAgentConfig.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          avatarUrl: true,
          signature: true,
        },
      },
    },
  });
  if (!row) return null;
  return redactAgentOpenaiKey(row);
}

export type CreateAIAgentInput = {
  name: string;
  archetype: AIAgentArchetype;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPromptTemplate?: string;
  systemPromptOverride?: string | null;
  productPolicy?: string | null;

  // Pilotagem profunda (regras + travas de tool + política de inbox).
  steeringRules?: string | null;
  toolConfig?: ToolConfigMap | null;
  inboxPolicy?: InboxPolicy | null;
  tone?: string;
  language?: string;
  autonomyMode?: AIAgentAutonomy;
  enabledTools?: string[];
  dailyTokenCap?: number;
  pipelineId?: string | null;
  channelId?: string | null;
  avatarUrl?: string | null;
  /// Chave OpenAI do agente (texto puro na entrada; cifrada no banco).
  /// `""`/`null` limpa. CRM multi-tenant: não há chave global.
  openaiApiKey?: string | null;

  // Piloting (controles operacionais).
  openingMessage?: string | null;
  openingDelayMs?: number;
  inactivityTimerMs?: number;
  inactivityHandoffMode?: HandoffMode;
  inactivityHandoffUserId?: string | null;
  inactivityFarewellMessage?: string | null;
  keywordHandoffs?: string[];
  qualificationQuestions?: QualificationQuestion[];
  businessHours?: BusinessHoursConfig | null;
  outputStyle?: OutputStyle;

  // Comportamento humano: typing indicator + read receipts.
  simulateTyping?: boolean;
  typingPerCharMs?: number;
  markMessagesRead?: boolean;
};

/**
 * Garante que os campos de piloting recebidos via API estão no
 * formato certo antes de ir pro banco. Qualquer JSON com chaves
 * extras é silenciosamente dropado.
 */
export function sanitizePilotingInput(input: {
  openingMessage?: unknown;
  openingDelayMs?: unknown;
  inactivityTimerMs?: unknown;
  inactivityHandoffMode?: unknown;
  inactivityHandoffUserId?: unknown;
  inactivityFarewellMessage?: unknown;
  keywordHandoffs?: unknown;
  qualificationQuestions?: unknown;
  businessHours?: unknown;
  outputStyle?: unknown;
  simulateTyping?: unknown;
  typingPerCharMs?: unknown;
  markMessagesRead?: unknown;
}): Partial<
  Pick<
    CreateAIAgentInput,
    | "openingMessage"
    | "openingDelayMs"
    | "inactivityTimerMs"
    | "inactivityHandoffMode"
    | "inactivityHandoffUserId"
    | "inactivityFarewellMessage"
    | "keywordHandoffs"
    | "qualificationQuestions"
    | "businessHours"
    | "outputStyle"
    | "simulateTyping"
    | "typingPerCharMs"
    | "markMessagesRead"
  >
> {
  const out: Partial<CreateAIAgentInput> = {};

  if (typeof input.openingMessage === "string") {
    out.openingMessage = input.openingMessage.trim() || null;
  } else if (input.openingMessage === null) {
    out.openingMessage = null;
  }

  if (typeof input.openingDelayMs === "number" && input.openingDelayMs >= 0) {
    out.openingDelayMs = Math.floor(input.openingDelayMs);
  }

  if (
    typeof input.inactivityTimerMs === "number" &&
    input.inactivityTimerMs >= 0
  ) {
    out.inactivityTimerMs = Math.floor(input.inactivityTimerMs);
  }

  if (
    typeof input.inactivityHandoffMode === "string" &&
    HANDOFF_MODES.includes(input.inactivityHandoffMode as HandoffMode)
  ) {
    out.inactivityHandoffMode = input.inactivityHandoffMode as HandoffMode;
  }

  if (typeof input.inactivityHandoffUserId === "string") {
    out.inactivityHandoffUserId = input.inactivityHandoffUserId.trim() || null;
  } else if (input.inactivityHandoffUserId === null) {
    out.inactivityHandoffUserId = null;
  }

  if (typeof input.inactivityFarewellMessage === "string") {
    out.inactivityFarewellMessage =
      input.inactivityFarewellMessage.trim() || null;
  } else if (input.inactivityFarewellMessage === null) {
    out.inactivityFarewellMessage = null;
  }

  if (Array.isArray(input.keywordHandoffs)) {
    out.keywordHandoffs = input.keywordHandoffs
      .filter((v): v is string => typeof v === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (input.qualificationQuestions !== undefined) {
    out.qualificationQuestions = normalizeQualificationQuestions(
      input.qualificationQuestions,
    );
  }

  if (input.businessHours === null) {
    out.businessHours = null;
  } else if (input.businessHours !== undefined) {
    out.businessHours = normalizeBusinessHours(input.businessHours);
  }

  if (typeof input.outputStyle === "string") {
    out.outputStyle = normalizeOutputStyle(input.outputStyle);
  }

  if (typeof input.simulateTyping === "boolean") {
    out.simulateTyping = input.simulateTyping;
  }

  if (typeof input.typingPerCharMs === "number" && input.typingPerCharMs >= 0) {
    // Cap defensivo: 200ms/char ~ 300cpm (bem lento), evita time-out absurdo.
    out.typingPerCharMs = Math.min(Math.floor(input.typingPerCharMs), 200);
  }

  if (typeof input.markMessagesRead === "boolean") {
    out.markMessagesRead = input.markMessagesRead;
  }

  return out;
}

/**
 * Normaliza os campos de pilotagem profunda vindos da API. Mesma
 * filosofia do `sanitizePilotingInput`: chave desconhecida é dropada e
 * ausência de campo significa "não mexe".
 */
export function sanitizeSteeringInput(input: {
  systemPromptTemplate?: unknown;
  steeringRules?: unknown;
  toolConfig?: unknown;
  inboxPolicy?: unknown;
}): Partial<
  Pick<
    CreateAIAgentInput,
    "systemPromptTemplate" | "steeringRules" | "toolConfig" | "inboxPolicy"
  >
> {
  const out: Partial<CreateAIAgentInput> = {};

  if (
    typeof input.systemPromptTemplate === "string" &&
    input.systemPromptTemplate.trim()
  ) {
    // Template vazio deixaria o agente sem prompt-base — só aceita texto.
    out.systemPromptTemplate = input.systemPromptTemplate;
  }

  if (typeof input.steeringRules === "string") {
    out.steeringRules = input.steeringRules.trim() || null;
  } else if (input.steeringRules === null) {
    out.steeringRules = null;
  }

  if (input.toolConfig === null) {
    out.toolConfig = null;
  } else if (input.toolConfig !== undefined) {
    out.toolConfig = normalizeToolConfig(input.toolConfig);
  }

  if (input.inboxPolicy === null) {
    out.inboxPolicy = null;
  } else if (input.inboxPolicy !== undefined) {
    out.inboxPolicy = normalizeInboxPolicy(input.inboxPolicy);
  }

  return out;
}

/**
 * Traduz `input.openaiApiKey` (texto puro) nos campos de banco.
 * `undefined` = não mexe. `""`/`null` = limpa. `"sk-…"` = cifra + hint.
 */
function openaiKeyFields(
  raw: string | null | undefined,
): { openaiApiKeyEnc: string | null; openaiApiKeyHint: string | null } | null {
  if (raw === undefined) return null;
  const key = (raw ?? "").trim();
  if (!key) return { openaiApiKeyEnc: null, openaiApiKeyHint: null };
  if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) {
    throw new Error("Formato de chave OpenAI inválido. Esperado algo como sk-…");
  }
  return { openaiApiKeyEnc: encryptSecret(key), openaiApiKeyHint: apiKeyHint(key) };
}

export async function createAIAgent(input: CreateAIAgentInput) {
  const archetype = getArchetype(input.archetype);

  const safeSlug =
    input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") ||
    "agente";
  const baseEmail = `${safeSlug}@ai.local`;

  let email = baseEmail;
  for (let attempt = 0; attempt < 20; attempt++) {
    const exists = await prisma.user.findFirst({ where: { email } });
    if (!exists) break;
    email = `${safeSlug}-${Math.random().toString(36).slice(2, 6)}@ai.local`;
  }

  const enabledTools = input.enabledTools ?? archetype.defaultTools;

  return prisma.$transaction(async (tx) => {
    const orgId = getOrgIdOrThrow();
    const user = await tx.user.create({
      data: {
        name: input.name,
        email,
        type: "AI",
        role: "MEMBER",
        hashedPassword: null,
        avatarUrl: input.avatarUrl ?? null,
        organizationId: orgId,
        number: await nextUserNumber(orgId, tx),
      },
    });

    const config = await tx.aIAgentConfig.create({
      data: withOrgFromCtx({
        userId: user.id,
        archetype: input.archetype,
        model: input.model ?? archetype.suggestedModel,
        temperature: input.temperature ?? 0.7,
        maxTokens: input.maxTokens ?? 1024,
        systemPromptTemplate:
          input.systemPromptTemplate ?? archetype.systemPromptTemplate,
        systemPromptOverride: input.systemPromptOverride ?? null,
        productPolicy: input.productPolicy ?? null,
        steeringRules: input.steeringRules ?? null,
        toolConfig:
          (input.toolConfig as unknown as Prisma.InputJsonValue | undefined) ??
          Prisma.JsonNull,
        inboxPolicy:
          (input.inboxPolicy as unknown as Prisma.InputJsonValue | undefined) ??
          Prisma.JsonNull,
        tone: input.tone ?? archetype.defaultTone,
        language: input.language ?? "pt-BR",
        autonomyMode: input.autonomyMode ?? "DRAFT",
        enabledTools,
        dailyTokenCap: input.dailyTokenCap ?? 0,
        pipelineId: input.pipelineId ?? null,
        channelId: input.channelId ?? null,
        active: true,

        // Piloting — usa defaults do banco quando não informado.
        openingMessage: input.openingMessage ?? null,
        openingDelayMs: input.openingDelayMs ?? 0,
        inactivityTimerMs: input.inactivityTimerMs ?? 0,
        inactivityHandoffMode: input.inactivityHandoffMode ?? "KEEP_OWNER",
        inactivityHandoffUserId: input.inactivityHandoffUserId ?? null,
        inactivityFarewellMessage: input.inactivityFarewellMessage ?? null,
        keywordHandoffs: input.keywordHandoffs ?? [],
        qualificationQuestions:
          (input.qualificationQuestions as unknown as Prisma.InputJsonValue) ??
          [],
        businessHours:
          (input.businessHours as unknown as Prisma.InputJsonValue | undefined) ??
          Prisma.JsonNull,
        outputStyle: input.outputStyle ?? "conversational",
        simulateTyping: input.simulateTyping ?? true,
        typingPerCharMs: input.typingPerCharMs ?? 25,
        markMessagesRead: input.markMessagesRead ?? true,
        ...(openaiKeyFields(input.openaiApiKey) ?? {}),
      }),
    });

    return { user, config: redactAgentOpenaiKey(config) };
  });
}

export type UpdateAIAgentInput = Partial<
  Omit<CreateAIAgentInput, "archetype">
> & {
  archetype?: AIAgentArchetype;
  active?: boolean;
};

export async function updateAIAgent(id: string, input: UpdateAIAgentInput) {
  const existing = await prisma.aIAgentConfig.findUnique({
    where: { id },
    include: { user: true },
  });
  if (!existing) throw new Error("Agente não encontrado.");

  return prisma.$transaction(async (tx) => {
    if (input.name || input.avatarUrl !== undefined) {
      await tx.user.update({
        where: { id: existing.userId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.avatarUrl !== undefined
            ? { avatarUrl: input.avatarUrl }
            : {}),
        },
      });
    }

    const config = await tx.aIAgentConfig.update({
      where: { id },
      data: {
        ...(input.archetype ? { archetype: input.archetype } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.systemPromptTemplate !== undefined
          ? { systemPromptTemplate: input.systemPromptTemplate }
          : {}),
        ...(input.systemPromptOverride !== undefined
          ? { systemPromptOverride: input.systemPromptOverride }
          : {}),
        ...(input.steeringRules !== undefined
          ? { steeringRules: input.steeringRules }
          : {}),
        ...(input.toolConfig !== undefined
          ? {
              toolConfig:
                input.toolConfig === null
                  ? Prisma.JsonNull
                  : (input.toolConfig as unknown as Prisma.InputJsonValue),
            }
          : {}),
        ...(input.inboxPolicy !== undefined
          ? {
              inboxPolicy:
                input.inboxPolicy === null
                  ? Prisma.JsonNull
                  : (input.inboxPolicy as unknown as Prisma.InputJsonValue),
            }
          : {}),
        ...(input.productPolicy !== undefined
          ? { productPolicy: input.productPolicy }
          : {}),
        ...(input.tone ? { tone: input.tone } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(input.autonomyMode ? { autonomyMode: input.autonomyMode } : {}),
        ...(input.enabledTools ? { enabledTools: input.enabledTools } : {}),
        ...(input.dailyTokenCap !== undefined
          ? { dailyTokenCap: input.dailyTokenCap }
          : {}),
        ...(input.pipelineId !== undefined
          ? { pipelineId: input.pipelineId }
          : {}),
        ...(input.channelId !== undefined
          ? { channelId: input.channelId }
          : {}),
        ...(openaiKeyFields(input.openaiApiKey) ?? {}),
        ...(input.active !== undefined ? { active: input.active } : {}),

        // Piloting.
        ...(input.openingMessage !== undefined
          ? { openingMessage: input.openingMessage }
          : {}),
        ...(input.openingDelayMs !== undefined
          ? { openingDelayMs: input.openingDelayMs }
          : {}),
        ...(input.inactivityTimerMs !== undefined
          ? { inactivityTimerMs: input.inactivityTimerMs }
          : {}),
        ...(input.inactivityHandoffMode !== undefined
          ? { inactivityHandoffMode: input.inactivityHandoffMode }
          : {}),
        ...(input.inactivityHandoffUserId !== undefined
          ? { inactivityHandoffUserId: input.inactivityHandoffUserId }
          : {}),
        ...(input.inactivityFarewellMessage !== undefined
          ? { inactivityFarewellMessage: input.inactivityFarewellMessage }
          : {}),
        ...(input.keywordHandoffs !== undefined
          ? { keywordHandoffs: input.keywordHandoffs }
          : {}),
        ...(input.qualificationQuestions !== undefined
          ? {
              qualificationQuestions:
                input.qualificationQuestions as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(input.businessHours !== undefined
          ? {
              businessHours:
                input.businessHours === null
                  ? Prisma.JsonNull
                  : (input.businessHours as unknown as Prisma.InputJsonValue),
            }
          : {}),
        ...(input.simulateTyping !== undefined
          ? { simulateTyping: input.simulateTyping }
          : {}),
        ...(input.typingPerCharMs !== undefined
          ? { typingPerCharMs: input.typingPerCharMs }
          : {}),
        ...(input.markMessagesRead !== undefined
          ? { markMessagesRead: input.markMessagesRead }
          : {}),
        ...(input.outputStyle !== undefined
          ? { outputStyle: input.outputStyle }
          : {}),
      },
    });

    // Mesmo strip do GET: o `config` cru traz `openaiApiKeyEnc` e a rota
    // PUT devolve este objeto direto no corpo da resposta.
    return redactAgentOpenaiKey(config);
  });
}

export async function toggleAIAgentActive(id: string) {
  const existing = await prisma.aIAgentConfig.findUnique({
    where: { id },
    select: { active: true },
  });
  if (!existing) throw new Error("Agente não encontrado.");
  const updated = await prisma.aIAgentConfig.update({
    where: { id },
    data: { active: !existing.active },
  });
  // Hoje a rota devolve só `{ active }`, mas o row cru sai daqui — redige
  // pra ninguém transformar isso em leak ao passar a devolver o objeto.
  return redactAgentOpenaiKey(updated);
}

export async function deleteAIAgent(id: string) {
  const existing = await prisma.aIAgentConfig.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!existing) return;

  // Deletando o User cascateia pro AIAgentConfig (relation 1:1) e pros
  // Knowledge/Run via onDelete CASCADE. Mensagens mantêm a referência
  // `aiAgentUserId` como null (SET NULL) para preservar histórico.
  await prisma.user.delete({ where: { id: existing.userId } });
}
