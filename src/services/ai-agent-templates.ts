/**
 * AgentTemplate — moldes de agente (sistema + org).
 * Dual-write com AIAgentArchetype via archetypeKey.
 *
 * Usa prismaBase + acesso dinâmico ao delegate (até `prisma generate`
 * expor `agentTemplate` tipado).
 */

import { Prisma } from "@prisma/client";
import type { AIAgentArchetype } from "@prisma/client";

import { ARCHETYPES } from "@/lib/ai-agents/archetypes";
import { prismaBase } from "@/lib/prisma-base";
import { getOrgIdOrNull } from "@/lib/request-context";

const SYSTEM_IDS: Record<AIAgentArchetype, string> = {
  SDR: "tmpl_sys_sdr",
  ATENDIMENTO: "tmpl_sys_atendimento",
  VENDEDOR: "tmpl_sys_vendedor",
  SUPORTE: "tmpl_sys_suporte",
};

type TemplateRow = {
  id: string;
  organizationId: string | null;
  name: string;
  description: string | null;
  archetypeKey: string | null;
  systemPromptTemplate: string;
  defaultTools: string[];
  defaultTone: string;
  defaultModel: string;
  defaultInboxPolicy: unknown;
  verticalPack: string | null;
  isSystem: boolean;
};

function templatesDb() {
  return (
    prismaBase as unknown as {
      agentTemplate: {
        upsert: (args: unknown) => Promise<TemplateRow>;
        findMany: (args: unknown) => Promise<TemplateRow[]>;
        findFirst: (args: unknown) => Promise<TemplateRow | null>;
      };
    }
  ).agentTemplate;
}

/** Upsert dos 4 templates de sistema a partir do catálogo de arquétipos. */
export async function ensureSystemTemplates(): Promise<void> {
  const db = templatesDb();
  for (const a of ARCHETYPES) {
    const id = SYSTEM_IDS[a.id];
    const verticalPack = a.id === "ATENDIMENTO" ? "academic" : null;
    const defaultInboxPolicy =
      a.id === "ATENDIMENTO"
        ? ({
            interceptRetention: true,
            interceptCourseShopping: true,
            inauguralEnabled: true,
          } as Prisma.InputJsonValue)
        : Prisma.JsonNull;

    await db.upsert({
      where: { id },
      create: {
        id,
        organizationId: null,
        name: a.label,
        description: a.shortDescription,
        archetypeKey: a.id,
        systemPromptTemplate: a.systemPromptTemplate,
        defaultTools: a.defaultTools,
        defaultTone: a.defaultTone,
        defaultModel: a.suggestedModel,
        defaultInboxPolicy,
        verticalPack,
        isSystem: true,
      },
      update: {
        name: a.label,
        description: a.shortDescription,
        systemPromptTemplate: a.systemPromptTemplate,
        defaultTools: a.defaultTools,
        defaultTone: a.defaultTone,
        defaultModel: a.suggestedModel,
        defaultInboxPolicy,
        verticalPack,
      },
    });
  }
}

export async function listAgentTemplates() {
  await ensureSystemTemplates();
  const orgId = getOrgIdOrNull();
  return templatesDb().findMany({
    where: {
      OR: [
        { isSystem: true },
        ...(orgId ? [{ organizationId: orgId }] : []),
      ],
    },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
}

export async function findSystemTemplateByArchetype(
  archetype: AIAgentArchetype,
) {
  await ensureSystemTemplates();
  return templatesDb().findFirst({
    where: { isSystem: true, archetypeKey: archetype },
  });
}

export function systemTemplateIdForArchetype(
  archetype: AIAgentArchetype,
): string {
  return SYSTEM_IDS[archetype];
}
