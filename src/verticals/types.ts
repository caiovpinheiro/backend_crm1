/**
 * Contrato de vertical packs.
 * Fora de `src/verticals/<id>/`, use só `getVerticalPack` / `runVerticalIntercepts`.
 */

export type VerticalInterceptHit = {
  handled: true;
  interceptName: string;
  meta?: Record<string, unknown>;
};

export type VerticalInterceptPhase = "pre_assignee" | "post_assignee";

/** Bag mutável montado pelo inbox-handler. */
export type VerticalInterceptCtx = {
  phase: VerticalInterceptPhase;
  env: Record<string, any>;
};

export type VerticalIntercept = {
  name: string;
  phase: VerticalInterceptPhase;
  run: (
    ctx: VerticalInterceptCtx,
  ) => Promise<VerticalInterceptHit | null | void>;
};

export type PromptBlockCtx = {
  archetype?: string;
  userMessage?: string;
  recentContext?: string;
  examsOnlineOnly?: boolean;
  [key: string]: unknown;
};

type PackOp = (...args: any[]) => any;

/**
 * Métodos que o core chama nos packs. Sempre opcionais: o pack pode não
 * implementar, e o agente pode não ter pack nenhum. Constantes e outros
 * exports dos módulos do vertical caem no index signature (não-chamáveis
 * sem cast, de propósito).
 */
export type VerticalPackOps = {
  // intenção / classificação
  isFirstAccessIntent?: PackOp;
  isFirstAccessStuckIntent?: PackOp;
  isAvaOrDisciplinesIntent?: PackOp;
  isImmediateAcademicHandoffJustified?: PackOp;
  textImpliesAcademicHandoff?: PackOp;
  inferDepartmentFromContext?: PackOp;
  shouldCloseAfterAgentFarewell?: PackOp;
  parseFirstAccessChoice?: PackOp;
  // ações
  executeAcademicDepartmentHandoff?: PackOp;
  moveOpenDealToEmAtendimento?: PackOp;
  closeAiOnlyConversation?: PackOp;
  closeIfAgentFarewellEndsAttendance?: PackOp;
  ensureAcademicDepartmentRoster?: PackOp;
  // cópia / prompt
  buildAvaDisciplinesMessage?: PackOp;
  formatFirstAccessHint?: PackOp;
  formatPasswordResetHint?: PackOp;
  formatExamAccessHint?: PackOp;
  formatParticipationCertificateHint?: PackOp;
  formatPoloAddressesHint?: PackOp;
  formatCanonicalPortalAccessHint?: PackOp;
  academicExamModalityRules?: PackOp;
  /** Demais helpers do vertical (closure, routing, inaugural…). */
  [key: string]: PackOp | undefined;
};

export type VerticalPack = {
  id: string;
  intercepts: VerticalIntercept[];
  promptBlocks: (ctx: PromptBlockCtx) => Promise<string[]> | string[];
  fallbackRules: (archetype: string) => string;
  departmentAliases: Record<string, string[]>;
  toolCopy: {
    transferToHuman?: string;
    transferToDepartment?: string;
    executeDistribution?: string;
    closeConversation?: string;
    consultarMatricula?: string;
  };
  /** Defaults de inboxPolicy quando o agente tem este pack (antes do JSON salvo). */
  inboxPolicyDefaults?: {
    interceptRetention?: boolean;
    interceptCourseShopping?: boolean;
    inauguralEnabled?: boolean;
  };
  /**
   * Ops do pack — nomes = exports dos módulos do vertical.
   * Todos opcionais de propósito: agente sem pack cai em `{}`, então
   * chamada sem `?.()` é erro de compilação (era `Record<string, any>`
   * e deixava passar `TypeError: is not a function` em runtime).
   */
  ops: VerticalPackOps;
  constants: {
    handoffKeywords: string[];
    atendimentoRules: string;
    confidenceRules: string;
    curriculumTceRules: string;
    mediaCapabilityRules: string;
    systemPromptOverride: string;
  };
};

export async function runVerticalIntercepts(
  pack: VerticalPack | null | undefined,
  ctx: VerticalInterceptCtx,
): Promise<VerticalInterceptHit | null> {
  if (!pack) return null;
  for (const intercept of pack.intercepts) {
    if (intercept.phase !== ctx.phase) continue;
    const hit = await intercept.run(ctx);
    if (hit && hit.handled) return hit;
  }
  return null;
}
