import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { ARCHETYPES } from "@/lib/ai-agents/archetypes";
import { TOOLS_CATALOG } from "@/lib/ai-agents/tools-catalog";
import { defaultInboxPolicy } from "@/lib/ai-agents/steering";
import { listAgentTemplates } from "@/services/ai-agent-templates";
import { listVerticalPackIds } from "@/verticals";
import { AGENT_MAX_STEPS } from "@/services/ai/runner";

/**
 * Fonte única de metadados do wizard/editor (Onda 3).
 * GET /api/ai-agents/metadata
 */
export async function GET() {
  return withOrgContext(async () => {
    const templates = await listAgentTemplates();
    return NextResponse.json({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        archetypeKey: t.archetypeKey,
        systemPromptTemplate: t.systemPromptTemplate,
        defaultTools: t.defaultTools,
        defaultTone: t.defaultTone,
        defaultModel: t.defaultModel,
        defaultInboxPolicy: t.defaultInboxPolicy,
        verticalPack: t.verticalPack,
        isSystem: t.isSystem,
      })),
      /** @deprecated use templates — mantido p/ FE legado. */
      archetypes: ARCHETYPES.map((a) => ({
        id: a.id,
        label: a.label,
        shortDescription: a.shortDescription,
        longDescription: a.longDescription,
        defaultTools: a.defaultTools,
        defaultTone: a.defaultTone,
        suggestedModel: a.suggestedModel,
        systemPromptTemplate: a.systemPromptTemplate,
        templateId: templates.find((t) => t.archetypeKey === a.id)?.id ?? null,
        verticalPack: a.id === "ATENDIMENTO" ? "academic" : null,
      })),
      tools: TOOLS_CATALOG,
      verticalPacks: listVerticalPackIds(),
      defaults: {
        inboxPolicy: defaultInboxPolicy(),
        maxSteps: AGENT_MAX_STEPS,
        language: "pt-BR",
        temperature: 0.7,
        maxTokens: 1024,
        autonomyMode: "DRAFT",
      },
    });
  });
}
