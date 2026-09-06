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
  /** Ops tipadas frouxamente — nomes = exports dos módulos academic. */
  ops: Record<string, any>;
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
