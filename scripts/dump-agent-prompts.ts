/**
 * Dump de system prompts de agentes ativos → baseline/<agentId>.txt
 *
 * Usa a MESMA função `renderSystemPrompt` do runner, com contexto
 * sintético FIXO (sem RAG / sem DB de conversa). Reexecutável.
 *
 * Uso (backend_crm1, com DATABASE_URL):
 *   npx tsx scripts/dump-agent-prompts.ts [organizationId]
 *
 * Neutro em comportamento — só lê configs e grava arquivos.
 */

import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

/** Contexto sintético estável — NÃO mudar sem regenerar todos os baselines. */
const FIXED_CONTACT = {
  name: "Baseline Contato",
  email: "baseline@example.com",
  phone: "+5500000000000",
  lifecycleStage: "SUBSCRIBER",
  tags: [{ tag: { name: "baseline-tag" } }],
};

const FIXED_DEAL = {
  title: "Baseline Deal",
  value: 100,
  stage: {
    name: "Baseline Stage",
    pipeline: { name: "Baseline Pipeline" },
  },
};

const BASELINE_DIR = join(process.cwd(), "baseline");

async function main() {
  const orgId = process.argv[2]?.trim() || null;
  const { PrismaClient } = await import("@prisma/client");
  const {
    normalizeOutputStyle,
    normalizeQualificationQuestions,
  } = await import("../src/lib/ai-agents/piloting");
  const {
    ACADEMIC_CURRICULUM_TCE_RULES,
    academicExamModalityRules,
  } = await import("../src/lib/ai-agents/academic-atendimento-prompt");
  const {
    fallbackSteeringRules,
    renderSystemPrompt,
  } = await import("../src/lib/ai-agents/system-prompt");

  const prisma = new PrismaClient();

  try {
    mkdirSync(BASELINE_DIR, { recursive: true });

    const agents = await prisma.aIAgentConfig.findMany({
      where: {
        active: true,
        ...(orgId ? { organizationId: orgId } : {}),
      },
      orderBy: { id: "asc" },
    });

    console.log(
      `Dumping ${agents.length} agente(s) ativo(s)${orgId ? ` org=${orgId}` : ""} → ${BASELINE_DIR}`,
    );

    for (const agent of agents) {
      const isAcademicAttendance = agent.archetype === "ATENDIMENTO";
      const runtimeTools = agent.enabledTools ?? [];
      const steeringRules =
        agent.steeringRules?.trim() || fallbackSteeringRules(agent.archetype);
      const runtimeOverride =
        [
          agent.systemPromptOverride?.trim(),
          steeringRules,
          isAcademicAttendance ? academicExamModalityRules(true) : "",
          isAcademicAttendance ? ACADEMIC_CURRICULUM_TCE_RULES : "",
        ]
          .filter(Boolean)
          .join("\n\n") || null;

      const prompt = renderSystemPrompt({
        template: agent.systemPromptTemplate,
        override: runtimeOverride,
        productPolicy: agent.productPolicy,
        hasProductSearch: runtimeTools.includes("search_products"),
        hasEnrollmentLookup: runtimeTools.includes("consultar_matricula"),
        tone: agent.tone,
        language: agent.language,
        autonomyMode: agent.autonomyMode,
        contact: FIXED_CONTACT,
        deal: FIXED_DEAL,
        retrievalBlock: "",
        qualificationQuestions: normalizeQualificationQuestions(
          agent.qualificationQuestions,
        ),
        outputStyle: normalizeOutputStyle(agent.outputStyle),
        templateVars: {
          agent_name: "Baseline Agent",
          company_name: "Baseline Company",
          deal_products: null,
          last_human_interaction: null,
        },
      });

      const outPath = join(BASELINE_DIR, `${agent.id}.txt`);
      writeFileSync(outPath, prompt, "utf8");
      console.log(`  OK ${agent.id} (${agent.archetype}) → ${outPath}`);
    }

    console.log("Done.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
