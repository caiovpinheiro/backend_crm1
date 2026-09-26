/**
 * Serviço de CRUD de agentes v2.
 * Nenhum domínio de cliente.
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { nextUserNumber } from "@/lib/public-id";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import {
  blankPreset,
  listV2Presets,
  normalizeV2Config,
  validateV2Config,
} from "@/lib/ai-v2/config";
import { anthropicKeyFields, openaiKeyFields } from "@/services/ai-v2/agent-key";

export type V2AgentListItem = {
  id: string;
  name: string;
  flow: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** 0 = nunca publicado. */
  lastVersionNumber: number;
  hasUnpublishedChanges: boolean;
  channelCount: number;
  /** Números da fase de teste (0 = atende todo mundo). */
  testPhoneCount: number;
  autonomyMode: string;
  themeCount: number;
  conversationsToday: number;
  handoffsToday: number;
};

function formatZodIssues(error: z.ZodError): string {
  return (error as any).issues.map((e: { path: (string | number)[]; message: string }) => `${e.path.join(".")}: ${e.message}`).join("; ");
}

/** Meia-noite de hoje no horário de Brasília (sem horário de verão desde 2019). */
function startOfTodayBrazil(now = new Date()): Date {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${day}T00:00:00-03:00`);
}

/** Conversas atendidas e transferências de hoje, por agente. Falha não derruba a lista. */
async function todayStats(organizationId: string, agentIds: string[]): Promise<Map<string, { conversations: number; handoffs: number }>> {
  const out = new Map<string, { conversations: number; handoffs: number }>();
  if (agentIds.length === 0) return out;
  try {
    const since = startOfTodayBrazil();
    const where = { organizationId, agentId: { in: agentIds }, createdAt: { gte: since } };
    const db = prisma as any;
    const [perConversation, handoffs] = await Promise.all([
      db.aISimpleTurnLog.groupBy({ by: ["agentId", "conversationId"], where }) as Promise<Array<{ agentId: string }>>,
      db.aISimpleTurnLog.groupBy({ by: ["agentId"], where: { ...where, handoff: true }, _count: { _all: true } }) as Promise<
        Array<{ agentId: string; _count: { _all: number } }>
      >,
    ]);
    for (const r of perConversation) {
      const cur = out.get(r.agentId) ?? { conversations: 0, handoffs: 0 };
      cur.conversations += 1;
      out.set(r.agentId, cur);
    }
    for (const r of handoffs) {
      const cur = out.get(r.agentId) ?? { conversations: 0, handoffs: 0 };
      cur.handoffs = r._count._all;
      out.set(r.agentId, cur);
    }
  } catch (err) {
    console.warn("[listV2Agents] números de hoje indisponíveis:", err instanceof Error ? err.message : err);
  }
  return out;
}

export async function listV2Agents(organizationId: string): Promise<V2AgentListItem[]> {
  const rows: Array<{
    id: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
    simpleConfig: unknown;
    draftConfig: unknown;
    user: { name: string };
  }> = await (prisma as any).aIAgentConfig.findMany({
    where: { organizationId, engine: "simple" },
    orderBy: { updatedAt: "desc" },
    include: { user: { select: { name: true } } },
  });
  const ids = rows.map((r) => r.id);
  const [versions, stats] = await Promise.all([
    ids.length
      ? ((prisma as any).aIAgentConfigVersion.groupBy({
          by: ["agentId"],
          where: { organizationId, agentId: { in: ids } },
          _max: { versionNumber: true },
        }) as Promise<Array<{ agentId: string; _max: { versionNumber: number | null } }>>)
      : Promise.resolve([]),
    todayStats(organizationId, ids),
  ]);
  const lastVersion = new Map(versions.map((v) => [v.agentId, v._max.versionNumber ?? 0]));

  return rows.map((r) => {
    // Uma config malformada (schema antigo, agente de teste abandonado) não
    // pode derrubar a listagem inteira da org — loga e cai pro default.
    const parse = (raw: unknown, label: string): V2AgentConfig | null => {
      if (!raw) return null;
      try {
        return normalizeV2Config(raw);
      } catch (err) {
        console.error(`[listV2Agents] ${label} invalido em ${r.id}:`, err instanceof z.ZodError ? formatZodIssues(err) : err);
        return null;
      }
    };
    const published = parse(r.simpleConfig, "simpleConfig");
    const draft = parse(r.draftConfig, "draftConfig");
    const current = draft ?? published;
    const today = stats.get(r.id);
    return {
      id: r.id,
      name: r.user?.name ?? "",
      flow: published?.flow ?? "full",
      active: r.active,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastVersionNumber: lastVersion.get(r.id) ?? 0,
      hasUnpublishedChanges: Boolean(draft && published && !configsEqual(published, draft)),
      channelCount: (current?.channelIds ?? []).length,
      testPhoneCount: (current?.allowedPhoneNumbers ?? []).length,
      autonomyMode: current?.autonomyMode ?? "suggest",
      themeCount: (current?.themes ?? []).length,
      conversationsToday: today?.conversations ?? 0,
      handoffsToday: today?.handoffs ?? 0,
    };
  });
}

export type V2AgentDetail = {
  id: string;
  name: string;
  active: boolean;
  publishedConfig: V2AgentConfig;
  draftConfig?: V2AgentConfig;
  /** True se existe rascunho e ele difere da config publicada. */
  hasUnpublishedChanges: boolean;
  /** Número da última versão publicada (0 se nunca publicado). */
  lastVersionNumber: number;
  archetype: string | null;
  hasOwnOpenaiKey: boolean;
  openaiApiKeyHint: string | null;
  hasAnthropicKey: boolean;
  anthropicApiKeyHint: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function configsEqual(a: V2AgentConfig, b: V2AgentConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mapV2AutonomyToPrisma(mode: V2AgentConfig["autonomyMode"]): "AUTONOMOUS" | "DRAFT" {
  return mode === "auto" ? "AUTONOMOUS" : "DRAFT";
}

export async function getV2Agent(id: string, organizationId: string): Promise<V2AgentDetail | null> {
  const row = await (prisma as any).aIAgentConfig.findFirst({
    where: { id, organizationId, engine: "simple" },
    include: {
      user: { select: { name: true } },
      _count: { select: { versions: true } },
    },
  });
  if (!row) {
    const anyRow = await (prisma as any).aIAgentConfig.findUnique({
      where: { id },
      select: { organizationId: true, engine: true, userId: true },
    });
    console.error(`[getV2Agent] not found id=${id} org=${organizationId} engine=simple; anyRow=`, anyRow);
    return null;
  }
  try {
    const publishedConfig = normalizeV2Config(row.simpleConfig);
    const draftConfig = row.draftConfig ? normalizeV2Config(row.draftConfig) : undefined;
    const lastVersion = await (prisma as any).aIAgentConfigVersion.findFirst({
      where: { agentId: id },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    return {
      id: row.id,
      name: row.user?.name ?? "",
      active: row.active,
      publishedConfig,
      draftConfig,
      hasUnpublishedChanges: draftConfig ? !configsEqual(publishedConfig, draftConfig) : false,
      lastVersionNumber: lastVersion?.versionNumber ?? 0,
      archetype: row.archetype,
      hasOwnOpenaiKey: Boolean(row.openaiApiKeyEnc),
      openaiApiKeyHint: row.openaiApiKeyHint ?? null,
      hasAnthropicKey: Boolean(row.anthropicApiKeyEnc),
      anthropicApiKeyHint: row.anthropicApiKeyHint ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ai-v2] invalid config for agent", id, err);
    throw new Error(`Configuração inválida para o agente ${id}: ${msg}`);
  }
}

export async function createV2Agent(organizationId: string, input: {
  name: string;
  preset?: string;
  config?: unknown;
  active?: boolean;
  openaiApiKey?: string | null;
}): Promise<{ id: string; config: V2AgentConfig }> {
  let config: V2AgentConfig;
  if (input.config) {
    const validated = validateV2Config(input.config);
    if (!validated.ok) throw new Error(formatZodIssues(validated.errors));
    config = validated.data;
  } else {
    const preset = listV2Presets().find((p) => p.key === input.preset)?.config ?? blankPreset();
    config = { ...preset, name: input.name || preset.name };
  }

  const safeSlug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "agente";
  let email = `${safeSlug}@ai.local`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const exists = await (prisma as any).user.findFirst({ where: { email } });
    if (!exists) break;
    email = `${safeSlug}-${Math.random().toString(36).slice(2, 6)}@ai.local`;
  }

  const systemPromptTemplate = config.tone
    ? `Tom: ${config.tone}\n${config.globalRules.join("\n")}`
    : "";

  return await (prisma as any).$transaction(async (tx: any) => {
    const user = await tx.user.create({
      data: {
        name: input.name,
        email,
        type: "AI",
        role: "MEMBER",
        hashedPassword: null,
        avatarUrl: null,
        organizationId,
        number: await nextUserNumber(organizationId, tx),
      },
    });

    const row = await tx.aIAgentConfig.create({
      data: {
        organizationId,
        userId: user.id,
        active: input.active ?? true,
        engine: "simple",
        archetype: "ATENDIMENTO",
        model: config.model ?? "gpt-4o-mini",
        responseBehavior: config.responseBehavior ?? "balanced",
        temperature: 0.4,
        systemPromptTemplate,
        simpleConfig: config as unknown as Record<string, unknown>,
        draftConfig: config as unknown as Record<string, unknown>,
        autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
        dailyTokenCap: 0,
        enabledTools: [],
        ...(openaiKeyFields(input.openaiApiKey) ?? {}),
      },
    });
    return { id: row.id, config };
  });
}

export async function updateV2Agent(id: string, organizationId: string, input: { name?: string; active?: boolean; config?: unknown; openaiApiKey?: string | null; anthropicApiKey?: string | null }): Promise<{ id: string; config: V2AgentConfig }> {
  let config: V2AgentConfig | undefined;
  if (input.config !== undefined) {
    const validated = validateV2Config(input.config);
    if (!validated.ok) throw new Error(formatZodIssues(validated.errors));
    config = validated.data;
  }

  const agent = await (prisma as any).aIAgentConfig.findFirst({
    where: { id, organizationId, engine: "simple" },
    select: { userId: true, simpleConfig: true },
  });
  if (!agent) throw new Error("Agente não encontrado.");

  const data: Record<string, unknown> = {};
  if (input.active !== undefined) data.active = input.active;
  if (config) {
    const cfgWithName = input.name !== undefined ? { ...config, name: input.name } : config;
    data.simpleConfig = cfgWithName as unknown as Record<string, unknown>;
    data.autonomyMode = mapV2AutonomyToPrisma(config.autonomyMode);
  } else if (input.name !== undefined) {
    data.simpleConfig = { ...agent.simpleConfig, name: input.name };
  }
  const keyUpdate = openaiKeyFields(input.openaiApiKey);
  if (keyUpdate) {
    data.openaiApiKeyEnc = keyUpdate.openaiApiKeyEnc;
    data.openaiApiKeyHint = keyUpdate.openaiApiKeyHint;
  }
  const anthropicUpdate = anthropicKeyFields(input.anthropicApiKey);
  if (anthropicUpdate) {
    data.anthropicApiKeyEnc = anthropicUpdate.anthropicApiKeyEnc;
    data.anthropicApiKeyHint = anthropicUpdate.anthropicApiKeyHint;
  }

  const row = await (prisma as any).$transaction(async (tx: any) => {
    if (input.name !== undefined && agent.userId) {
      await tx.user.update({ where: { id: agent.userId }, data: { name: input.name } });
    }
    return await tx.aIAgentConfig.update({
      where: { id, organizationId },
      data,
    });
  });
  return {
    id: row.id,
    config: config ?? normalizeV2Config(row.simpleConfig),
  };
}

export async function saveV2AgentDraft(
  id: string,
  organizationId: string,
  input: { config?: unknown },
): Promise<{ id: string; config: V2AgentConfig }> {
  let config: V2AgentConfig | undefined;
  if (input.config !== undefined) {
    const validated = validateV2Config(input.config);
    if (!validated.ok) throw new Error(formatZodIssues(validated.errors));
    config = validated.data;
  }

  const data: Record<string, unknown> = {};
  if (config) data.draftConfig = config as unknown as Record<string, unknown>;

  const existing = await (prisma as any).aIAgentConfig.findFirst({
    where: { id, organizationId, engine: "simple" },
    select: { id: true, draftConfig: true, simpleConfig: true },
  });
  if (!existing) throw new Error("Agente não encontrado.");

  const row = await (prisma as any).aIAgentConfig.update({
    where: { id },
    data,
  });
  return {
    id: row.id,
    config: config ?? normalizeV2Config(row.draftConfig ?? row.simpleConfig),
  };
}

export async function publishV2AgentVersion(
  id: string,
  organizationId: string,
  userId: string | undefined,
  comment?: string,
): Promise<{ id: string; versionNumber: number; config: V2AgentConfig }> {
  const agent = await (prisma as any).aIAgentConfig.findFirst({
    where: { id, organizationId, engine: "simple" },
    select: { simpleConfig: true, draftConfig: true },
  });
  if (!agent) throw new Error("Agente não encontrado.");

  const source = agent.draftConfig ?? agent.simpleConfig;
  if (!source) throw new Error("Nenhuma configuração para publicar.");
  const config = normalizeV2Config(source);

  return await (prisma as any).$transaction(async (tx: any) => {
    const lastVersion = await tx.aIAgentConfigVersion.findFirst({
      where: { agentId: id },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const nextVersion = (lastVersion?.versionNumber ?? 0) + 1;

    await tx.aIAgentConfigVersion.create({
      data: {
        organizationId,
        agentId: id,
        versionNumber: nextVersion,
        config: config as unknown as Record<string, unknown>,
        comment: comment ?? null,
        createdById: userId ?? null,
      },
    });

    await tx.aIAgentConfig.update({
      where: { id, organizationId },
      data: {
        simpleConfig: config as unknown as Record<string, unknown>,
        autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
        // Só a primeira publicação liga o agente. Antes toda publicação
        // religava um agente que alguém tinha desligado de propósito.
        ...(nextVersion === 1 ? { active: true } : {}),
      },
    });

    return { id, versionNumber: nextVersion, config };
  });
}

export async function listV2AgentVersions(
  id: string,
  organizationId: string,
): Promise<{ versionNumber: number; comment?: string | null; createdAt: Date; createdById?: string | null; createdByName?: string | null }[]> {
  const rows: Array<{ versionNumber: number; comment: string | null; createdAt: Date; createdById: string | null }> =
    await (prisma as any).aIAgentConfigVersion.findMany({
      where: { agentId: id, organizationId },
      orderBy: { versionNumber: "desc" },
      take: 50,
      select: { versionNumber: true, comment: true, createdAt: true, createdById: true },
    });
  const authorIds = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => Boolean(v)))];
  const authors: Array<{ id: string; name: string | null }> = authorIds.length
    ? await (prisma as any).user.findMany({ where: { id: { in: authorIds }, organizationId }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(authors.map((a) => [a.id, a.name]));
  return rows.map((r) => ({ ...r, createdByName: r.createdById ? nameOf.get(r.createdById) ?? null : null }));
}

/**
 * Traz uma versão publicada de volta para o rascunho. Não publica: a pessoa
 * testa e publica de novo se quiser voltar a ela no WhatsApp.
 */
export async function restoreV2AgentVersionToDraft(
  id: string,
  organizationId: string,
  versionNumber: number,
): Promise<{ id: string; config: V2AgentConfig }> {
  const version = await (prisma as any).aIAgentConfigVersion.findFirst({
    where: { agentId: id, organizationId, versionNumber },
    select: { config: true },
  });
  if (!version) throw new Error("Versão não encontrada.");
  return saveV2AgentDraft(id, organizationId, { config: version.config });
}

export async function deleteV2Agent(id: string, organizationId: string): Promise<void> {
  await (prisma as unknown as {
    aIAgentConfig: {
      deleteMany: (args: { where: { id: string; organizationId: string; engine: string } }) => Promise<void>;
    };
  }).aIAgentConfig.deleteMany({
    where: { id, organizationId, engine: "simple" },
  });
}

export function listV2PresetsService(): Array<{ key: string; label: string; config: V2AgentConfig }> {
  return listV2Presets();
}
