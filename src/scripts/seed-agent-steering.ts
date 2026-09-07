/**
 * Seed one-shot da pilotagem profunda.
 *
 * O runtime passou a ler `steeringRules` e `enabledTools` do banco em vez
 * de forçar as constantes acadêmicas a cada run. Este script copia o
 * comportamento vigente para o banco, para que o primeiro deploy NÃO mude
 * nada até o consultor editar na tela.
 *
 * Idempotente: só escreve onde o campo está vazio.
 *
 * Uso (backend_crm1, com DATABASE_URL):
 *   npx tsx src/scripts/seed-agent-steering.ts [organizationId]
 */
import { getVerticalPack } from "../verticals";
import { getArchetype } from "../lib/ai-agents/archetypes";

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

async function main() {
  const orgId = process.argv[2]?.trim() || null;
  const prisma = new PrismaClient();
  try {
    const agents = await prisma.aIAgentConfig.findMany({
      where: {
        archetype: "ATENDIMENTO",
        ...(orgId ? { organizationId: orgId } : {}),
      },
      select: {
        id: true,
        enabledTools: true,
        steeringRules: true,
        systemPromptOverride: true,
        systemPromptTemplate: true,
        organizationId: true,
        user: { select: { name: true } },
      },
    });
    console.log(`Encontrados ${agents.length} agente(s) ATENDIMENTO.`);

    for (const a of agents) {
      const tools = Array.from(
        new Set([...(a.enabledTools ?? []), ...ACADEMIC_RUNTIME_TOOLS]),
      );
      // O override antigo já continha as regras (script apply-*). Mantê-lo
      // duplicaria o texto no prompt agora que ele soma com steeringRules.
      const overrideHadRules =
        (a.systemPromptOverride ?? "").includes("## REGRAS ABSOLUTAS");
      const templateHadRules =
        (a.systemPromptTemplate ?? "").includes("## REGRAS ABSOLUTAS");
      const cleanTemplate = getArchetype("ATENDIMENTO").systemPromptTemplate;

      await prisma.aIAgentConfig.update({
        where: { id: a.id },
        data: {
          enabledTools: tools,
          ...(a.steeringRules?.trim()
            ? {}
            : { steeringRules: ACADEMIC_STEERING_RULES }),
          ...(overrideHadRules ? { systemPromptOverride: null } : {}),
          ...(templateHadRules ? { systemPromptTemplate: cleanTemplate } : {}),
        },
      });
      console.log(
        `  OK ${a.user.name} (${a.id}) org=${a.organizationId}` +
          (a.steeringRules?.trim() ? " [regras preservadas]" : " [regras semeadas]") +
          (overrideHadRules ? " [override duplicado limpo]" : "") +
          (templateHadRules ? " [template sem regras]" : ""),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
