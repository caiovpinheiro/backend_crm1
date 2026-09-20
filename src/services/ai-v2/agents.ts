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

export type V2AgentListItem = {
  id: string;
  name: string;
  flow: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function formatZodIssues(error: z.ZodError): string {
  return (error as any).issues.map((e: { path: (string | number)[]; message: string }) => `${e.path.join(".")}: ${e.message}`).join("; ");
}

export async function listV2Agents(organizationId: string): Promise<V2AgentListItem[]> {
  const rows = await (prisma as unknown as {
    aIAgentConfig: {
      findMany: (args: { where: Record<string, unknown>; orderBy: { updatedAt: "desc" }; select: Record<string, boolean> }) => Promise<V2AgentListItem[]>;
    };
  }).aIAgentConfig.findMany({
    where: { organizationId, engine: "simple" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, active: true, createdAt: true, updatedAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    flow: (r as any).flow ?? "full",
    active: r.active,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export type V2AgentDetail = {
  id: string;
  name: string;
  active: boolean;
  publishedConfig: V2AgentConfig;
  draftConfig?: V2AgentConfig;
  archetype: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function getV2Agent(id: string, organizationId: string): Promise<V2AgentDetail | null> {
  const row = await (prisma as any).aIAgentConfig.findUnique({
    where: { id, organizationId },
    select: {
      id: true,
      name: true,
      active: true,
      simpleConfig: true,
      draftConfig: true,
      archetype: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) return null;
  try {
    const publishedConfig = normalizeV2Config(row.simpleConfig);
    const draftConfig = row.draftConfig ? normalizeV2Config(row.draftConfig) : undefined;
    return {
      id: row.id,
      name: row.name,
      active: row.active,
      publishedConfig,
      draftConfig,
      archetype: row.archetype,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch (err) {
    console.error("[ai-v2] invalid config for agent", id, err);
    return null;
  }
}

export async function createV2Agent(organizationId: string, input: {
  name: string;
  preset?: string;
  config?: unknown;
  active?: boolean;
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
        name: input.name,
        active: input.active ?? true,
        engine: "simple",
        archetype: "ATENDIMENTO",
        model: config.model ?? "gpt-4o-mini",
        responseBehavior: config.responseBehavior ?? "balanced",
        temperature: 0.4,
        systemPromptTemplate,
        simpleConfig: config as unknown as Record<string, unknown>,
        draftConfig: config as unknown as Record<string, unknown>,
        autonomyMode: "AUTONOMOUS",
        dailyTokenCap: 0,
        enabledTools: [],
      },
    });
    return { id: row.id, config };
  });
}

export async function updateV2Agent(id: string, organizationId: string, input: { name?: string; active?: boolean; config?: unknown }): Promise<{ id: string; config: V2AgentConfig }> {
  let config: V2AgentConfig | undefined;
  if (input.config !== undefined) {
    const validated = validateV2Config(input.config);
    if (!validated.ok) throw new Error(formatZodIssues(validated.errors));
    config = validated.data;
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.active !== undefined) data.active = input.active;
  if (config) data.simpleConfig = config as unknown as Record<string, unknown>;

  const row = await (prisma as unknown as {
    aIAgentConfig: {
      update: (args: { where: { id: string; organizationId: string }; data: Record<string, unknown> }) => Promise<{ id: string; simpleConfig: unknown }>;
    };
  }).aIAgentConfig.update({
    where: { id, organizationId },
    data,
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

  const row = await (prisma as any).aIAgentConfig.update({
    where: { id, organizationId },
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
  const agent = await (prisma as any).aIAgentConfig.findUnique({
    where: { id, organizationId },
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
        active: true,
      },
    });

    return { id, versionNumber: nextVersion, config };
  });
}

export async function listV2AgentVersions(
  id: string,
  organizationId: string,
): Promise<{ versionNumber: number; comment?: string | null; createdAt: Date; createdById?: string | null }[]> {
  const rows = await (prisma as any).aIAgentConfigVersion.findMany({
    where: { agentId: id, organizationId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true, comment: true, createdAt: true, createdById: true },
  });
  return rows;
}

export async function deleteV2Agent(id: string, organizationId: string): Promise<void> {
  await (prisma as unknown as {
    aIAgentConfig: {
      deleteMany: (args: { where: { id: string; organizationId: string } }) => Promise<void>;
    };
  }).aIAgentConfig.deleteMany({
    where: { id, organizationId },
  });
}

export function listV2PresetsService(): Array<{ key: string; label: string; config: V2AgentConfig }> {
  return listV2Presets();
}
