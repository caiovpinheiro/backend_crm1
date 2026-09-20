/**
 * Serviço de CRUD de agentes v2.
 * Nenhum domínio de cliente.
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
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

export async function getV2Agent(id: string, organizationId: string): Promise<{ id: string; name: string; active: boolean; simpleConfig: V2AgentConfig; archetype: string | null; createdAt: Date; updatedAt: Date } | null> {
  const row = await (prisma as unknown as {
    aIAgentConfig: {
      findUnique: (args: { where: { id: string; organizationId: string }; select: Record<string, boolean> }) => Promise<{
        id: string;
        name: string;
        active: boolean;
        simpleConfig: unknown;
        archetype: string | null;
        createdAt: Date;
        updatedAt: Date;
      } | null>;
    };
  }).aIAgentConfig.findUnique({
    where: { id, organizationId },
    select: { id: true, name: true, active: true, simpleConfig: true, archetype: true, createdAt: true, updatedAt: true },
  });
  if (!row) return null;
  try {
    const config = normalizeV2Config(row.simpleConfig);
    return { ...row, simpleConfig: config };
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

  const row = await (prisma as unknown as {
    aIAgentConfig: {
      create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    };
  }).aIAgentConfig.create({
    data: {
      organizationId,
      name: input.name,
      active: input.active ?? true,
      engine: "simple",
      archetype: "ATENDIMENTO",
      simpleConfig: config as unknown as Record<string, unknown>,
      autonomyMode: "AUTONOMOUS",
      dailyTokenCap: 0,
    },
  });
  return { id: row.id, config };
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
