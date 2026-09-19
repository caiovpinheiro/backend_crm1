import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Contexto de tenant para a request em curso. Populado no inicio do
 * handler (via `withOrgContext`) e propagado pelo AsyncLocalStorage pra
 * dentro de qualquer callback chamado no mesmo "fluxo logico" — Promise
 * chains, setImmediate, setTimeout, streams, etc.
 *
 * Por que AsyncLocalStorage em vez de passar `orgId` como prop?
 * - Nao precisa mudar a assinatura de 300+ funcoes de services/lib.
 * - A Prisma Client Extension precisa ler org sem acesso a `request`.
 * - Codigo em services chamado pelo worker (fora de HTTP) tambem
 *   funciona contanto que tenha sido embrulhado por `withOrgContext`.
 *
 * Limitacoes conhecidas:
 * - Nao atravessa workers (worker_threads) — precisa repassar
 *   explicitamente se algum dia migrarmos pra threads.
 * - Se alguma chamada async usar callback estilo Node (`fn(cb)`) SEM
 *   promise, o contexto se perde. Hoje o codebase eh 100% async/await.
 */

/// Tipo de ator. Espelha `ActorType` do schema Prisma — duplicado aqui
/// porque essa lib roda em paths sem dependencia no Prisma Client (evita
/// ciclo com extension).
export type ContextActorType =
  | "HUMAN"
  | "AI"
  | "AUTOMATION"
  | "INTEGRATION"
  | "SYSTEM";

/// Snapshot rico do ator para auditoria/feed de atividade (ActivityEvent).
/// Resolvido nas portas de entrada (sessao/token/webhook/automation
/// executor/agente IA) e propagado pelo AsyncLocalStorage junto do
/// `userId`. O `logEvent()` central le este campo para preencher
/// `actorType/actorLabel/actorSublabel/actorRef` sem que cada call site
/// precise saber quem disparou a acao.
export type ContextActor = {
  type: ContextActorType;
  /// Snapshot do nome a exibir no feed (ex.: "Felipe", "n8n_comercial",
  /// "SalesBot", "Robo", "Sistema"). Imutavel — preserva o rotulo da
  /// hora do evento mesmo se o User for renomeado depois.
  label?: string | null;
  /// Contexto secundario (ex.: nome do bloco da automacao
  /// "RB - INICIO LICENCIADO", nome do agente, nome do token, etc.).
  sublabel?: string | null;
  /// Id externo do ator nao-humano (automationId, agentId, tokenId).
  ref?: string | null;
};

export type RequestContext = {
  /// Id da organizacao atual. Null so em rotas expostas ao super-admin
  /// EduIT (ex.: /admin/organizations lista todas). Rotas scoped devem
  /// exigir nao-null via getOrgIdOrThrow().
  organizationId: string | null;
  /// Id do user atual da sessao — util pra auditoria.
  userId: string;
  /// Flag de super-admin. Habilita bypass da RLS no Postgres quando a
  /// Prisma Extension seta `SET LOCAL app.is_super_admin`.
  isSuperAdmin: boolean;
  /// Atribuicao rica de ator para o log de atividade (ActivityEvent).
  /// Complementa `actorType`/`actorUserId` passados explicitamente no
  /// `logEvent()`; nunca substitui o `actorType` obrigatorio do input.
  actor?: ContextActor;
  /// Usuário humano que deu origem a uma execução automatizada disparada
  /// a partir deste contexto de request (ex.: gatilho de mudança de fase
  /// gerado por uma ação humana). Usado pelo `logEvent` como fallback de
  /// `triggeredByUserId` quando o caller não passa explicitamente.
  triggeredByUserId?: string;
};

/**
 * A instancia do AsyncLocalStorage e cacheada em globalThis — MESMO motivo
 * e padrao do `prisma` (lib/prisma.ts cacheia em globalThis.prismaScoped).
 *
 * Por que isso e obrigatorio (bug de producao-dev caçado em 13/jun/26):
 *   - O `prisma` estendido sobrevive ao HMR (cacheado em globalThis). A
 *     closure da extension capturou `getRequestContext`, que le o `storage`
 *     deste modulo.
 *   - Quando o Turbopack/HMR recompila e recarrega `request-context.ts`,
 *     um `new AsyncLocalStorage()` criaria uma instancia NOVA. O
 *     `withOrgContext` passaria a gravar o contexto na instancia nova,
 *     enquanto a extension (cacheada) continuaria lendo a ANTIGA →
 *     `getRequestContext()` retorna undefined → throw "fora de
 *     RequestContext" em praticamente todos os endpoints.
 *   - Ancorar a ALS em globalThis garante que todo reload reaproveite a
 *     MESMA instancia que a closure cacheada do prisma capturou.
 */
const globalForCtx = globalThis as unknown as {
  __crmRequestContextStorage?: AsyncLocalStorage<RequestContext>;
};

const storage =
  globalForCtx.__crmRequestContextStorage ??
  new AsyncLocalStorage<RequestContext>();

globalForCtx.__crmRequestContextStorage = storage;

export const requestContext = storage;

/**
 * Executa `fn` dentro de um contexto com `ctx`. Qualquer chamada
 * async dentro de `fn` consegue ler o contexto via `getRequestContext()`
 * ou `getOrgIdOrThrow()`.
 */
export function runWithContext<T>(
  ctx: RequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Ativa o contexto para o resto da continuation async atual E para o
 * caller que aguardar a Promise.
 *
 * Comportamento (Node v18+):
 *   - `enterWith()` muda o store atual e PROPAGA pra todas as
 *     continuations descendentes geradas por awaits subsequentes.
 *   - Quando uma async function que chamou `enterWith` retorna, a
 *     Promise resolve mantendo o store ativo — o caller que faz `await`
 *     herda o ctx no frame de continuacao.
 *   - Validado empiricamente em `node test-als.mjs` (24/abr/26).
 *
 * Use casos:
 *   - `requireAuth()` chama `enterRequestContext` apos resolver a
 *     session, populando ctx pra todo o handler que faz
 *     `await requireAuth()`. Isso permite que rotas legadas (sem
 *     `withOrgContext` explicito) funcionem corretamente com a Prisma
 *     extension multi-tenant.
 *   - Webhooks/cron resolvem o ctx a partir do payload e chamam
 *     `enterRequestContext` antes de qualquer prisma.*.
 *
 * Idempotente: so ativa se nao houver ctx ja ativo — `runWithContext`
 * (storage.run) tem precedencia.
 */
export function enterRequestContext(ctx: RequestContext): void {
  if (storage.getStore()) return;
  storage.enterWith(ctx);
}

/** Retorna o contexto atual ou `undefined` se ninguem embrulhou a request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Atalho que explode se nao houver organizationId definido. Use em lugares
 * onde a ausencia e bug (ex.: dentro de service que assume tenant scoped).
 */
export function getOrgIdOrThrow(): string {
  const ctx = storage.getStore();
  if (!ctx?.organizationId) {
    throw new Error(
      "getOrgIdOrThrow: organization context ausente. Esqueceu de envolver o handler em withOrgContext()?",
    );
  }
  return ctx.organizationId;
}

/** Retorna orgId ou null (super-admin). Nao explode. */
export function getOrgIdOrNull(): string | null {
  return storage.getStore()?.organizationId ?? null;
}

/** Retorna a flag super-admin (default false). */
export function isSuperAdminContext(): boolean {
  return Boolean(storage.getStore()?.isSuperAdmin);
}

/// Retorna o ator atual (se algum porto de entrada o populou).
export function getActorContext(): ContextActor | undefined {
  return storage.getStore()?.actor;
}

/// Executa `fn` herdando o ctx atual mas sobrescrevendo o `actor`.
/// Usado por automation-executor / agente IA / import worker quando
/// querem que tudo que rodar dentro do step seja imputado a
/// AUTOMATION/AI sem perder o organizationId/userId resolvidos antes.
///
/// Tolerante a contextless: se nao houver RequestContext ativo (ex.:
/// worker/queue que perdeu o ALS por travessia de boundary), apenas
/// executa `fn` sem sobrescrever ator. NAO joga erro — isso quebrava
/// o fluxo de criacao de lead via webhook inbound do WhatsApp (worker
/// chamava runAutomationInline sem envolver em withSystemContext).
/// Sem ctx, `logEvent` ja faz fallback pra SYSTEM por conta propria.
export function runWithActor<T>(
  actor: ContextActor,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const current = storage.getStore();
  if (!current) {
    return fn();
  }
  return storage.run({ ...current, actor }, fn);
}
