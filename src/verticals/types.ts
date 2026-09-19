/**
 * Contrato de vertical packs.
 * Fora de `src/verticals/<id>/`, use só `getVerticalPack` / `runVerticalIntercepts`.
 */

import type { TabulateOnExitMode, ToolPolicy } from "@/lib/ai-agents/steering";
import type { RunContext } from "@/services/ai/tools";

/**
 * Construtor de uma tool do pack, com a mesma assinatura das tools do núcleo.
 *
 * O retorno fica em `unknown` de propósito: o tipo real é o `Tool` do AI SDK,
 * que é heterogêneo por definição (cada tool tem input e output próprios). O
 * `buildToolSet` faz o cast uma vez, no mesmo lugar onde já casta as do
 * núcleo. Tipar aqui só empurraria o `any` para dentro de cada pack.
 */
export type VerticalToolFactory = (ctx: RunContext, policy: ToolPolicy) => unknown;

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
  restoreDealToAcademicOrigin?: PackOp;
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
  /**
   * Carrega a config de tenant da org do contexto para o cache do processo.
   * Chamado antes de montar prompt ou rodar intercept — os textos do pack
   * são síncronos e precisam da config já resolvida.
   */
  loadTenantConfig?: () => Promise<unknown>;
  intercepts: VerticalIntercept[];
  promptBlocks: (ctx: PromptBlockCtx) => Promise<string[]> | string[];
  fallbackRules: (archetype: string) => string;
  departmentAliases: Record<string, string[]>;
  toolCopy: {
    transferToHuman?: string;
    transferToDepartment?: string;
    executeDistribution?: string;
    closeConversation?: string;
  };
  /**
   * Ferramentas que só existem neste vertical. O núcleo não as conhece pelo
   * nome: descobre por aqui quem constrói (`buildToolSet`) e o que mostrar na
   * tela (`GET /api/ai-agents/tools`). Ferramenta de produto entra por esta
   * porta, nunca no `FACTORY_MAP`.
   */
  extraTools?: Array<{
    id: string;
    label: string;
    description: string;
    category: "crm" | "whatsapp" | "handoff";
    defaultForArchetypes: string[];
    factory: VerticalToolFactory;
  }>;
  /** Defaults de inboxPolicy quando o agente tem este pack (antes do JSON salvo). */
  inboxPolicyDefaults?: {
    interceptRetention?: boolean;
    interceptCourseShopping?: boolean;
    interceptFirstAccess?: boolean;
    inauguralEnabled?: boolean;
    tabulateOnExit?: TabulateOnExitMode;
    humanRequestKeywords?: string[];
    nonsenseAskOnceMessage?: string | null;
    nonsenseStopMessage?: string | null;
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
    /** Limite de alcance da tool de matrícula. Só entra se a tool está no turno. */
    enrollmentScopeRules: string;
    mediaCapabilityRules: string;
    systemPromptOverride: string;
  };
};

export async function runVerticalIntercepts(
  pack: VerticalPack | null | undefined,
  ctx: VerticalInterceptCtx,
): Promise<VerticalInterceptHit | null> {
  if (!pack) return null;
  await pack.loadTenantConfig?.().catch(() => null);
  for (const intercept of pack.intercepts) {
    if (intercept.phase !== ctx.phase) continue;
    const hit = await intercept.run(ctx);
    if (hit && hit.handled) return hit;
  }
  return null;
}
