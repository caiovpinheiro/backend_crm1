/**
 * Pack academic — ops + intercepts + prompts/constants.
 */

import {
  ACADEMIC_ATENDIMENTO_RULES,
  ACADEMIC_CONFIDENCE_RULES,
  ACADEMIC_CURRICULUM_TCE_RULES,
  ACADEMIC_DEPARTMENT_ALIASES,
  ACADEMIC_HANDOFF_KEYWORDS,
  ACADEMIC_MEDIA_CAPABILITY_RULES,
  ACADEMIC_SYSTEM_PROMPT_OVERRIDE,
  academicExamModalityRules,
  buildAvaDisciplinesMessage,
  formatCanonicalPortalAccessHint,
  formatExamAccessHint,
  formatFirstAccessHint,
  formatParticipationCertificateHint,
  formatPasswordResetHint,
  formatPoloAddressesHint,
  isAvaOrDisciplinesIntent,
  isFirstAccessIntent,
  isFirstAccessStuckIntent,
  parseFirstAccessChoice,
} from "@/verticals/academic/atendimento-prompt";
import * as closure from "@/verticals/academic/closure";
import * as routing from "@/verticals/academic/department-routing";
import { ensureAcademicDepartmentRoster } from "@/verticals/academic/ensure-dept-roster";
import * as inaugural from "@/verticals/academic/inaugural-class-link";
import type {
  VerticalIntercept,
  VerticalInterceptCtx,
  VerticalPack,
} from "@/verticals/types";

// `INAUGURAL_CLASS_YOUTUBE_URL` é constante, não op — fica fora de `ops`.
const { INAUGURAL_CLASS_YOUTUBE_URL: _inauguralUrl, ...inauguralOps } =
  inaugural;

// `intercepts` é array estático: era um getter que devolvia o valor cru de um
// `require()` lazy (cast, sem checagem em runtime) e o consumidor quebrava com
// `intercepts is not iterable` sempre que o módulo não estava pronto. O corpo
// pesado segue lazy — `import()` dentro do `run`, já em request —, então o
// ciclo intercepts ↔ services/ai continua fora do boot.
async function runAcademicPipeline(
  phase: VerticalIntercept["phase"],
  ctx: VerticalInterceptCtx,
) {
  const { runAcademicInterceptPipeline } = await import(
    "@/verticals/academic/intercepts"
  );
  return runAcademicInterceptPipeline(phase, ctx);
}

const academicIntercepts: VerticalIntercept[] = [
  {
    name: "academic_pre_assignee",
    phase: "pre_assignee",
    run: (ctx) => runAcademicPipeline("pre_assignee", ctx),
  },
  {
    name: "academic_post_assignee",
    phase: "post_assignee",
    run: (ctx) => runAcademicPipeline("post_assignee", ctx),
  },
];

export const academicPack: VerticalPack = {
  id: "academic",
  intercepts: academicIntercepts,
  promptBlocks: (ctx) => {
    const blocks: string[] = [];
    if (ctx.archetype === "ATENDIMENTO" || !ctx.archetype) {
      blocks.push(ACADEMIC_ATENDIMENTO_RULES);
      blocks.push(ACADEMIC_CURRICULUM_TCE_RULES);
      blocks.push(ACADEMIC_MEDIA_CAPABILITY_RULES);
      blocks.push(ACADEMIC_CONFIDENCE_RULES);
      if (typeof ctx.examsOnlineOnly === "boolean") {
        blocks.push(academicExamModalityRules(ctx.examsOnlineOnly));
      }
    }
    return blocks;
  },
  fallbackRules: (archetype) => {
    if (archetype !== "ATENDIMENTO") return "";
    return [
      ACADEMIC_ATENDIMENTO_RULES,
      ACADEMIC_CURRICULUM_TCE_RULES,
      ACADEMIC_MEDIA_CAPABILITY_RULES,
      ACADEMIC_CONFIDENCE_RULES,
    ].join("\n\n");
  },
  departmentAliases: { ...ACADEMIC_DEPARTMENT_ALIASES },
  toolCopy: {
    transferToHuman:
      "Transfere o aluno para um consultor humano quando ele pedir ou o tema exigir.",
    transferToDepartment:
      "Encaminha para Acolhimento, Retenção ou Atendimento conforme o tema.",
    executeDistribution:
      "Distribui o atendimento na fila do departamento já definido.",
    closeConversation:
      "Encerra o atendimento somente-IA quando o aluno se despede ou pede para fechar.",
    consultarMatricula:
      "Consulta matrícula/RA do aluno na base acadêmica da instituição.",
  },
  inboxPolicyDefaults: {
    interceptRetention: true,
    interceptCourseShopping: true,
    inauguralEnabled: true,
  },
  ops: {
    ...closure,
    ...routing,
    ...inauguralOps,
    ensureAcademicDepartmentRoster,
    isFirstAccessIntent,
    isFirstAccessStuckIntent,
    isAvaOrDisciplinesIntent,
    parseFirstAccessChoice,
    formatFirstAccessHint,
    formatPasswordResetHint,
    formatExamAccessHint,
    formatParticipationCertificateHint,
    formatPoloAddressesHint,
    formatCanonicalPortalAccessHint,
    academicExamModalityRules,
    buildAvaDisciplinesMessage,
  },
  constants: {
    handoffKeywords: [...ACADEMIC_HANDOFF_KEYWORDS],
    atendimentoRules: ACADEMIC_ATENDIMENTO_RULES,
    confidenceRules: ACADEMIC_CONFIDENCE_RULES,
    curriculumTceRules: ACADEMIC_CURRICULUM_TCE_RULES,
    mediaCapabilityRules: ACADEMIC_MEDIA_CAPABILITY_RULES,
    systemPromptOverride: ACADEMIC_SYSTEM_PROMPT_OVERRIDE,
  },
};
