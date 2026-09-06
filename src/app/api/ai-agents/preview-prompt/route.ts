import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  normalizeOutputStyle,
  normalizeQualificationQuestions,
} from "@/lib/ai-agents/piloting";
import {
  fallbackSteeringRules,
  renderSystemPrompt,
} from "@/lib/ai-agents/system-prompt";
import { getVerticalPack } from "@/verticals";

/**
 * Preview real do system prompt (mesma montagem do runner, sem RAG/DB de conversa).
 * POST /api/ai-agents/preview-prompt
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  return withOrgContext(async () => {
    const template =
      typeof body.systemPromptTemplate === "string"
        ? body.systemPromptTemplate
        : "";
    if (!template.trim()) {
      return NextResponse.json(
        { message: "systemPromptTemplate obrigatório." },
        { status: 400 },
      );
    }

    const archetype =
      typeof body.archetype === "string" ? body.archetype : "SDR";
    const verticalPack =
      typeof body.verticalPack === "string"
        ? body.verticalPack
        : body.verticalPack === null
          ? null
          : undefined;
    const pack = getVerticalPack(
      verticalPack === undefined
        ? archetype === "ATENDIMENTO"
          ? "academic"
          : null
        : verticalPack,
    );

    const enabledTools = Array.isArray(body.enabledTools)
      ? body.enabledTools.filter((t): t is string => typeof t === "string")
      : [];

    const steeringRules =
      (typeof body.steeringRules === "string" && body.steeringRules.trim()) ||
      fallbackSteeringRules(archetype, pack?.id ?? null);

    const examsOnlineOnly = true;
    const runtimeOverride =
      [
        typeof body.systemPromptOverride === "string"
          ? body.systemPromptOverride.trim()
          : "",
        steeringRules,
        pack ? pack.ops.academicExamModalityRules?.(examsOnlineOnly) ?? "" : "",
        pack?.constants.curriculumTceRules ?? "",
      ]
        .filter(Boolean)
        .join("\n\n") || null;

    const prompt = renderSystemPrompt({
      template,
      override: runtimeOverride,
      productPolicy:
        typeof body.productPolicy === "string" ? body.productPolicy : null,
      hasProductSearch: enabledTools.includes("search_products"),
      hasEnrollmentLookup: enabledTools.includes("consultar_matricula"),
      tone: typeof body.tone === "string" ? body.tone : "profissional",
      language: typeof body.language === "string" ? body.language : "pt-BR",
      autonomyMode:
        body.autonomyMode === "AUTONOMOUS" ? "AUTONOMOUS" : "DRAFT",
      contact: {
        name: "Preview Contato",
        email: "preview@example.com",
        phone: "+5500000000000",
        lifecycleStage: "SUBSCRIBER",
        tags: [],
      },
      deal: null,
      retrievalBlock: "",
      qualificationQuestions: normalizeQualificationQuestions(
        body.qualificationQuestions,
      ),
      outputStyle: normalizeOutputStyle(body.outputStyle),
      templateVars: {
        agent_name:
          typeof body.agentName === "string" ? body.agentName : "Agente",
        company_name:
          typeof body.companyName === "string"
            ? body.companyName
            : "Empresa",
        deal_products: null,
        last_human_interaction: null,
      },
    });

    return NextResponse.json({
      prompt,
      verticalPack: pack?.id ?? null,
      interceptCount: pack?.intercepts.length ?? 0,
    });
  });
}
