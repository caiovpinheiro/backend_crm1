/**
 * Seed one-shot da pilotagem profunda.
 *
 * Copia o comportamento vigente do código para o banco, para que as
 * abas do CRM já abram preenchidas — sem mudar o que o aluno recebe.
 *
 * Idempotente: só escreve onde o campo está vazio.
 *
 * Por padrão roda em diagnóstico (nada é gravado). Só grava com `--apply`.
 *
 * Uso (backend_crm1, com DATABASE_URL):
 *   npx tsx src/scripts/seed-agent-steering.ts [organizationId]
 *   npx tsx src/scripts/seed-agent-steering.ts [organizationId] --apply
 */
import { Prisma, PrismaClient } from "@prisma/client";

import { getArchetype } from "../lib/ai-agents/archetypes";
import { normalizeInboxPolicy } from "../lib/ai-agents/steering";
import { duplicatesSteeringRules } from "../lib/ai-agents/system-prompt";
import { getVerticalPack } from "../verticals";
import { ACADEMIC_DEPARTMENT_ALIASES } from "../verticals/academic/atendimento-prompt";

const academic = getVerticalPack("academic")!;
const ACADEMIC_ATENDIMENTO_RULES = academic.constants.atendimentoRules;
const ACADEMIC_CONFIDENCE_RULES = academic.constants.confidenceRules;
const ACADEMIC_MEDIA_CAPABILITY_RULES = academic.constants.mediaCapabilityRules;

/** Tools que o runner injetava à força no arquétipo ATENDIMENTO. */
const ACADEMIC_RUNTIME_TOOLS = [
  "consultar_matricula",
  "transfer_to_department",
  "execute_distribution",
  "transfer_to_human",
  "close_conversation",
];

const ACADEMIC_STEERING_RULES = [
  ACADEMIC_ATENDIMENTO_RULES,
  ACADEMIC_MEDIA_CAPABILITY_RULES,
  ACADEMIC_CONFIDENCE_RULES,
].join("\n\n");

/** Policy equivalente ao agente acadêmico de hoje (pack + aliases). */
function academicInboxPolicySnapshot() {
  const policy = normalizeInboxPolicy(null, "academic");
  return {
    ...policy,
    departmentAliases: {
      acolhimento: [...ACADEMIC_DEPARTMENT_ALIASES.acolhimento],
      retencao: [...ACADEMIC_DEPARTMENT_ALIASES.retencao],
      atendimento: [...ACADEMIC_DEPARTMENT_ALIASES.atendimento],
    },
  };
}

const RULES_MARKER = "## REGRAS ABSOLUTAS";

function countRules(text: string | null | undefined): number {
  return (text ?? "").split(RULES_MARKER).length - 1;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const orgId = args.find((a) => !a.startsWith("--"))?.trim() || null;
  const prisma = new PrismaClient();
  const inboxSnapshot = academicInboxPolicySnapshot();
  try {
    const agents = await prisma.aIAgentConfig.findMany({
      where: {
        archetype: "ATENDIMENTO",
        ...(orgId ? { organizationId: orgId } : {}),
      },
      select: {
        id: true,
        active: true,
        enabledTools: true,
        steeringRules: true,
        inboxPolicy: true,
        systemPromptOverride: true,
        systemPromptTemplate: true,
        organizationId: true,
        user: { select: { name: true } },
      },
    });
    console.log(
      `${apply ? "APLICANDO" : "DIAGNOSTICO (nada sera gravado)"} — ` +
        `${agents.length} agente(s) ATENDIMENTO.\n`,
    );

    for (const a of agents) {
      const current = a.enabledTools ?? [];
      const missingTools = ACADEMIC_RUNTIME_TOOLS.filter(
        (t) => !current.includes(t),
      );
      const tools = Array.from(new Set([...current, ...ACADEMIC_RUNTIME_TOOLS]));
      const overrideHadRules = duplicatesSteeringRules(
        a.systemPromptOverride,
        ACADEMIC_STEERING_RULES,
      );
      const templateHadRules = duplicatesSteeringRules(
        a.systemPromptTemplate,
        ACADEMIC_STEERING_RULES,
      );
      const hasSteering = Boolean(a.steeringRules?.trim());
      const hasInboxPolicy = a.inboxPolicy != null;
      const cleanTemplate = getArchetype("ATENDIMENTO").systemPromptTemplate;
      const copies =
        countRules(a.systemPromptTemplate) +
        countRules(a.systemPromptOverride) +
        countRules(hasSteering ? a.steeringRules : ACADEMIC_STEERING_RULES);

      console.log(
        `${a.user.name} (${a.id}) org=${a.organizationId}` +
          (a.active ? "" : " [INATIVO]"),
      );
      console.log(`  tools no banco: ${current.join(", ") || "(nenhuma)"}`);
      console.log(
        `  tools que o runtime injetava e hoje faltam: ${
          missingTools.join(", ") || "nenhuma"
        }`,
      );
      console.log(
        `  steeringRules: ${
          hasSteering
            ? `${a.steeringRules!.trim().length} chars (banco manda)`
            : "vazio (usando fallback do codigo)"
        }`,
      );
      console.log(
        `  copias das regras no prompt: ${copies}${copies > 1 ? " (duplicado)" : ""}`,
      );
      console.log(
        `  inboxPolicy: ${hasInboxPolicy ? "definido" : "vazio (pack academico)"}`,
      );

      if (!apply) {
        const plan = [
          missingTools.length ? `somar tools ${missingTools.join(", ")}` : null,
          hasSteering ? null : "gravar as regras atuais em steeringRules",
          hasInboxPolicy
            ? null
            : "gravar inboxPolicy do pack academico (interceptos + assuntos + aliases)",
          overrideHadRules ? "limpar systemPromptOverride duplicado" : null,
          templateHadRules
            ? "mover regras do template para a aba Regras"
            : null,
        ].filter(Boolean);
        console.log(
          `  --apply faria: ${plan.length ? plan.join("; ") : "nada"}\n`,
        );
        continue;
      }

      await prisma.aIAgentConfig.update({
        where: { id: a.id },
        data: {
          enabledTools: tools,
          ...(hasSteering ? {} : { steeringRules: ACADEMIC_STEERING_RULES }),
          ...(hasInboxPolicy
            ? {}
            : {
                inboxPolicy:
                  inboxSnapshot as unknown as Prisma.InputJsonValue,
              }),
          ...(overrideHadRules ? { systemPromptOverride: null } : {}),
          ...(templateHadRules ? { systemPromptTemplate: cleanTemplate } : {}),
        },
      });
      console.log(
        `  OK gravado` +
          (hasSteering ? " [regras preservadas]" : " [regras semeadas]") +
          (hasInboxPolicy ? " [inbox preservado]" : " [inbox semeado]") +
          (missingTools.length ? ` [+${missingTools.length} tool(s)]` : "") +
          (overrideHadRules ? " [override duplicado limpo]" : "") +
          (templateHadRules ? " [template sem regras duplicadas]" : "") +
          "\n",
      );
    }

    if (!apply) {
      console.log("Nada foi alterado. Rode de novo com --apply para gravar.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
