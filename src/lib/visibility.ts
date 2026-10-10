import { Prisma } from "@prisma/client";

import type { AppUserRole } from "@/lib/auth-types";
import type { AuthzContext } from "@/lib/authz";
import {
  authzContextOnce,
  featureEnabledOnce,
  orgSettingsByPrefixOnce,
} from "@/lib/authz/request-prechecks";
import { prisma } from "@/lib/prisma";
import { automationQueueDelayAgo } from "@/lib/inbox-automation-queue";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { memoized, type RequestMemo } from "@/lib/request-memo";

export type VisibilityMode = "all" | "own";

export type VisibilityResult = {
  canSeeAll: boolean;
  dealWhere: Prisma.DealWhereInput;
  conversationWhere: Prisma.ConversationWhereInput;
  /**
   * O papel enxerga o pool livre (sem responsável)? Precisa viajar junto com
   * o `where` porque as filas da Inbox injetam conversas não atribuídas por
   * fora dele (`withInboxQueueVisibility`) e também precisam respeitar o eixo.
   */
  includeUnassigned: boolean;
};

type SessionUser = { id: string; role: AppUserRole };

const DEFAULTS: Record<AppUserRole, VisibilityMode> = {
  ADMIN: "all",
  MANAGER: "all",
  MEMBER: "own",
};

/**
 * Eixo ORTOGONAL a own/all: o papel enxerga itens SEM responsável (o pool
 * livre — deal com `ownerId` null, conversa com `assignedToId` null)?
 *
 * Defaults preservam o comportamento anterior à introdução do toggle:
 *   - MEMBER: `false` — operador nunca via "Sem responsável" nem em all.
 *   - MANAGER/ADMIN: `true` — em all já enxergavam o pool.
 * Combina com own/all: own + pool = próprios + sem dono; all + pool = tudo.
 */
const UNASSIGNED_DEFAULTS: Record<AppUserRole, boolean> = {
  ADMIN: true,
  MANAGER: true,
  MEMBER: false,
};

/**
 * Lê settings da org corrente.
 *
 * Multi-tenancy v0 cutover: antes lia de `SystemSetting` (global, vazava
 * config entre tenants). Agora le de `OrganizationSetting` via
 * `getOrgSettingsByPrefix`, que é cacheado por (orgId, prefixo) e
 * invalidado em `setVisibilityForRole`.
 */
async function loadVisibilityMap(memo?: RequestMemo): Promise<Map<string, string>> {
  return orgSettingsByPrefixOnce(memo, "visibility.");
}

async function loadUnassignedMap(memo?: RequestMemo): Promise<Map<string, string>> {
  return orgSettingsByPrefixOnce(memo, "unassigned.");
}

function getUnassignedForRole(
  settings: Map<string, string>,
  role: AppUserRole,
): boolean {
  if (role === "ADMIN") return true;
  const val = settings.get(`unassigned.${role}`);
  if (val === "true") return true;
  if (val === "false") return false;
  return UNASSIGNED_DEFAULTS[role];
}

function getModeForRole(
  settings: Map<string, string>,
  role: AppUserRole
): VisibilityMode {
  if (role === "ADMIN") return "all";
  const val = settings.get(`visibility.${role}`);
  if (val === "all" || val === "own") return val;
  return DEFAULTS[role];
}

/**
 * Compõe o escopo de departamento (isolamento) com o `where` base de
 * conversas via AND. Modelo opt-in e aditivo-restritivo:
 * - `deptIds === null` → sem restrição de departamento (comportamento legado).
 * - `deptIds` não-vazio → conversa DEVE pertencer a um dos departamentos.
 * O escopo é sempre combinado com AND para não afrouxar a visibilidade base
 * (own/all/grupos) — só restringe, nunca expande.
 */
export function composeDepartmentScope(
  base: Prisma.ConversationWhereInput,
  deptIds: string[] | null
): Prisma.ConversationWhereInput {
  if (!deptIds || deptIds.length === 0) return base;
  const deptWhere: Prisma.ConversationWhereInput = {
    departmentId: { in: deptIds },
  };
  if (!base || Object.keys(base).length === 0) return deptWhere;
  return { AND: [deptWhere, base] };
}

/**
 * Resolve os departamentos que o usuário pode ver, a partir de
 * `AgentPermission.allowedDepartmentIds`. Isolamento de dados por
 * departamento (fecha o gap em que o campo era persistido mas não aplicado).
 *
 * - ADMIN → `null` (vê todos os departamentos, sem restrição).
 * - Demais papéis → `allowedDepartmentIds` se configurado; senão `null`
 *   (opt-in: enquanto o admin não escopar o agente, nada muda).
 *
 * `memo` (opcional): memo da requisição — a mesma leitura serve a todos os
 * pré-checks do request.
 */
export async function getDepartmentScopeForConversations(
  user: SessionUser,
  memo?: RequestMemo,
): Promise<string[] | null> {
  if (user.role === "ADMIN") return null;
  return memoized(memo, `dept-scope:${user.id}`, async () => {
    try {
      const perm = await prisma.agentPermission.findUnique({
        where: { userId: user.id },
        select: { allowedDepartmentIds: true },
      });
      const ids = perm?.allowedDepartmentIds ?? [];
      return ids.length > 0 ? ids : null;
    } catch {
      // Tabela/coluna ausente (migração pendente) ou fora de contexto — sem restrição.
      return null;
    }
  });
}

/**
 * Filtro de visibilidade (own/all, pool livre, departamento) do usuário.
 *
 * Os insumos são independentes entre si e saem juntos: escopo de
 * departamento (Postgres), as duas famílias de settings, o contexto authz
 * e — só para papéis que podem cair no "own" compartilhado — a flag de
 * escopo granular (Redis). Antes eram 4 a 6 idas em série.
 *
 * `opts.memo`: memo da requisição. Com ele, authz/flag/settings/departamento
 * são lidos uma vez por request mesmo que a rota também os peça.
 */
export async function getVisibilityFilter(
  user: SessionUser,
  opts: { memo?: RequestMemo } = {},
): Promise<VisibilityResult> {
  const role = user.role;
  const memo = opts.memo;

  if (!role || !DEFAULTS[role]) {
    const deptScope = await getDepartmentScopeForConversations(user, memo);
    return {
      canSeeAll: true,
      dealWhere: {},
      conversationWhere: composeDepartmentScope({}, deptScope),
      includeUnassigned: true,
    };
  }

  // Papel personalizado pode ampliar (nunca reduzir) a visibilidade do
  // papel legado. Fora de RequestContext (jobs) ou se a leitura falhar,
  // permanece a visibilidade do papel legado — `null` aqui.
  let orgId: string | null = null;
  if (role !== "ADMIN") {
    try {
      orgId = getOrgIdOrThrow();
    } catch {
      orgId = null;
    }
  }
  const authzPromise: Promise<AuthzContext | null> = orgId
    ? authzContextOnce(memo, {
        userId: user.id,
        organizationId: orgId,
        isSuperAdmin: false,
      }).catch(() => null)
    : Promise.resolve(null);
  // A flag só decide o "own estrito" de quem não é MEMBER (MEMBER já é
  // estrito) nem ADMIN (sempre "all").
  const granularPromise: Promise<boolean> =
    orgId && role !== "MEMBER"
      ? featureEnabledOnce(memo, "rbac_granular_scope_v1", orgId).catch(() => false)
      : Promise.resolve(false);

  const [deptScope, settings, unassignedSettings, authzCtx, granularScope] =
    await Promise.all([
      getDepartmentScopeForConversations(user, memo),
      loadVisibilityMap(memo),
      loadUnassignedMap(memo),
      authzPromise,
      granularPromise,
    ]);
  let mode = getModeForRole(settings, role);
  // Ver ou não os itens SEM responsável (pool livre). Eixo ortogonal a own/all.
  let includeUnassigned = getUnassignedForRole(unassignedSettings, role);

  // OR entre os papéis atribuídos; default false não muda nada.
  if (authzCtx) {
    if (authzCtx.seeTeam) mode = "all";
    if (authzCtx.seeUnassigned) includeUnassigned = true;
  }

  // Deal sem dono só aparece quando o papel pode ver o pool livre; caso
  // contrário exige `ownerId` presente. `{}` = todos (dono ou não).
  const dealWhereAll: Prisma.DealWhereInput = includeUnassigned
    ? {}
    : { ownerId: { not: null } };

  // Conversas atribuídas dentro do escopo (base para o modo "all" sem pool).
  const assignedInScope = composeDepartmentScope(
    { assignedToId: { not: null } },
    deptScope,
  );
  // Tudo dentro do escopo (com pool). No modo "all" com pool o recorte é o
  // departamento — não o dono.
  const anythingInScope = composeDepartmentScope({}, deptScope);

  if (mode === "all") {
    // Conversa ATRIBUÍDA ao agente é sempre visível a ele — inclusive fora do
    // seu departamento. Sem o `OR assignedToMe`, um escopo de departamento
    // (AND) escondia até as próprias conversas do agente quando chegavam sem
    // `departmentId` (ex.: recém-distribuídas), e a fila aparecia vazia.
    const scopedConversations = includeUnassigned ? anythingInScope : assignedInScope;
    return {
      canSeeAll: true,
      dealWhere: dealWhereAll,
      conversationWhere: deptScope
        ? { OR: [{ assignedToId: user.id }, scopedConversations] }
        : scopedConversations,
      includeUnassigned,
    };
  }

  /**
   * Modo "own" do papel.
   *
   * MEMBER: default estrito (só atribuídas a ele). Filas compartilhadas
   * (Entrada / Automação) NÃO usam mais `sharedInbox` — liberar via
   * `inbox:tab:entrada` + `conversation:claim` e `inbox:tab:automacao`,
   * aplicadas em `withInboxQueueVisibility` na listagem da inbox.
   *
   * Demais papéis (com flag `rbac_granular_scope_v1`):
   *   - sharedInbox=true (default) → próprias + não atribuídas ligadas a
   *     contatos que o agente acompanha.
   *   - sharedInbox=false → estritamente as atribuídas a ele.
   */
  let strictOwnInbox = role === "MEMBER";
  if (
    !strictOwnInbox &&
    granularScope &&
    authzCtx &&
    !authzCtx.isAdmin &&
    !authzCtx.sharedInbox
  ) {
    strictOwnInbox = true;
  }

  // Conversa ATRIBUÍDA ao agente é SEMPRE visível — inclusive sem departamento
  // ou de outro departamento. Sem isso, uma conversa distribuída para o agente
  // (que chega sem `departmentId`) era escondida pelo isolamento por
  // departamento (AND), e o agente "não via a conversa distribuída".
  const assignedToMe: Prisma.ConversationWhereInput = { assignedToId: user.id };

  // Com o eixo "sem responsável" ligado, o own passa a incluir o pool livre:
  // próprios + itens sem dono (o modelo de distribuição em que o operador
  // puxa da fila). Sem ele, own segue estrito (só os próprios).
  const ownDealWhere: Prisma.DealWhereInput = includeUnassigned
    ? { OR: [{ ownerId: user.id }, { ownerId: null }] }
    : { ownerId: user.id };
  // Pool livre de conversas respeita o isolamento por departamento; as
  // próprias (`assignedToMe`) permanecem sempre visíveis, dentro ou fora dele.
  const unassignedPool = composeDepartmentScope({ assignedToId: null }, deptScope);

  if (strictOwnInbox) {
    return {
      canSeeAll: false,
      dealWhere: ownDealWhere,
      conversationWhere: includeUnassigned
        ? { OR: [assignedToMe, unassignedPool] }
        : assignedToMe,
      includeUnassigned,
    };
  }

  // Pool compartilhado (não atribuídas ligadas a contatos que o agente
  // acompanha): AQUI sim vale o isolamento por departamento. Com o eixo
  // "sem responsável" ligado, o pool deixa de exigir vínculo com o contato —
  // o agente vê TODA a fila não atribuída (dentro do escopo).
  const sharedUnassigned: Prisma.ConversationWhereInput = includeUnassigned
    ? unassignedPool
    : composeDepartmentScope(
        {
          assignedToId: null,
          contact: {
            OR: [
              { deals: { some: { ownerId: user.id } } },
              { assignedToId: user.id },
            ],
          },
        },
        deptScope,
      );

  return {
    canSeeAll: false,
    dealWhere: ownDealWhere,
    conversationWhere: {
      OR: [assignedToMe, sharedUnassigned],
    },
    includeUnassigned,
  };
}

/**
 * O usuário pode VER/abrir este negócio, pela posse? Mesma regra do
 * `dealWhere` de `getVisibilityFilter` e do `GET /api/deals/:id`: quem vê
 * tudo (`canSeeAll`), o dono, ou — negócio sem dono — quem enxerga o pool
 * livre (`includeUnassigned`).
 *
 * Só a posse: etapa/funil negados são checados à parte (`requireStageScope`,
 * `requirePipelineScope`). Fonte única da rota de detalhe, do move e do
 * filtro SSE do `deal_moved`.
 */
export function canSeeDealByOwner(
  visibility: Pick<VisibilityResult, "canSeeAll" | "includeUnassigned">,
  userId: string,
  ownerId: string | null,
): boolean {
  if (visibility.canSeeAll) return true;
  if (ownerId === userId) return true;
  return ownerId === null && visibility.includeUnassigned;
}

export function permissionsAllowKey(
  perms: ReadonlySet<string>,
  key: string,
): boolean {
  if (perms.has("*") || perms.has(key)) return true;
  const colon = key.indexOf(":");
  if (colon > 0 && perms.has(`${key.slice(0, colon)}:*`)) return true;
  return false;
}

/**
 * Amplia o `conversationWhere` para filas compartilhadas da Inbox quando o
 * operador tem as chaves correspondentes:
 *   - `inbox:tab:entrada` + `conversation:claim` → pool OPEN não atribuído
 *   - `inbox:tab:automacao` → fila de automação (contexto vivo ou só robô)
 *   - `inbox:tab:agente_ia` → fila do Agente IA (assignee `type: AI`)
 *
 * Substitui o legado `sharedInbox` para MEMBER nas filas compartilhadas.
 * Seguro combinar com o filtro de aba (`tabToWhere`) — extras só aparecem
 * nas abas cujo predicado as inclui.
 *
 * `base` vazio = irrestrito (ADMIN/MANAGER “all”). Nesse caso NÃO aplicar
 * extras: senão a inbox inteira colapsa só para as filas compartilhadas.
 *
 * `includeUnassigned` vem de `getVisibilityFilter` e recorta o que estas
 * filas injetam: Entrada e Automação trazem conversa SEM responsável, então
 * sem esse gate o pool livre reaparecia na Inbox mesmo com o eixo desligado
 * nas permissões. A fila do Agente IA NÃO passa por esse gate: lá o
 * responsável existe (o usuário IA), não é pool livre.
 */
export function withInboxQueueVisibility(
  base: Prisma.ConversationWhereInput,
  args: {
    permissions: ReadonlySet<string> | readonly string[];
    tabs?: Array<"entrada" | "automacao" | "agente_ia">;
    includeUnassigned?: boolean;
  },
): Prisma.ConversationWhereInput {
  // Irrestrito: não restringir às filas compartilhadas.
  if (!base || Object.keys(base).length === 0) {
    return base ?? {};
  }

  const perms =
    args.permissions instanceof Set
      ? args.permissions
      : new Set(args.permissions);
  const tabs = args.tabs ?? (["entrada", "automacao", "agente_ia"] as const);
  const includeUnassigned = args.includeUnassigned ?? true;
  const extras: Prisma.ConversationWhereInput[] = [];

  if (
    includeUnassigned &&
    tabs.includes("entrada") &&
    permissionsAllowKey(perms, "inbox:tab:entrada") &&
    permissionsAllowKey(perms, "conversation:claim")
  ) {
    extras.push({ assignedToId: null, status: "OPEN" });
  }

  if (
    includeUnassigned &&
    tabs.includes("automacao") &&
    permissionsAllowKey(perms, "inbox:tab:automacao")
  ) {
    extras.push({
      status: "OPEN",
      assignedToId: null,
      hasError: false,
      AND: [
        {
          OR: [
            {
              contact: {
                automationContexts: {
                  some: {
                    status: { in: ["RUNNING", "PAUSED"] },
                    createdAt: { lte: automationQueueDelayAgo() },
                  },
                },
              },
            },
            {
              hasAgentReply: true,
              hasHumanReply: false,
              lastMessageDirection: "out",
            },
          ],
        },
        {
          NOT: {
            contact: {
              automationContexts: {
                some: { createdAt: { gt: automationQueueDelayAgo() } },
              },
            },
          },
        },
      ],
    });
  }

  // Rollout: roles gravadas antes da aba existir não têm a chave nova, mas já
  // viam essas conversas pelas filas Entrada/Automação. O fallback espelha
  // `canSeeInboxTab` — sem ele a aba aparecia vazia para o operador.
  const canSeeAiQueue =
    permissionsAllowKey(perms, "inbox:tab:agente_ia") ||
    permissionsAllowKey(perms, "inbox:tab:entrada") ||
    permissionsAllowKey(perms, "inbox:tab:automacao");
  if (tabs.includes("agente_ia") && canSeeAiQueue) {
    extras.push({ status: "OPEN", assignedTo: { is: { type: "AI" } } });
  }

  if (extras.length === 0) return base;
  return { OR: [base, ...extras] };
}

export async function getVisibilitySettings(): Promise<
  Record<string, VisibilityMode>
> {
  const settings = await loadVisibilityMap();
  return {
    ADMIN: "all",
    MANAGER: getModeForRole(settings, "MANAGER"),
    MEMBER: getModeForRole(settings, "MEMBER"),
  };
}

export async function setVisibilityForRole(
  role: "MANAGER" | "MEMBER",
  mode: VisibilityMode
) {
  // setOrgSetting já invalida o cache (chave + prefixo) automaticamente.
  const { setOrgSetting } = await import("@/lib/org-settings");
  await setOrgSetting(`visibility.${role}`, mode);
}

export async function getUnassignedSettings(): Promise<Record<string, boolean>> {
  const settings = await loadUnassignedMap();
  return {
    ADMIN: true,
    MANAGER: getUnassignedForRole(settings, "MANAGER"),
    MEMBER: getUnassignedForRole(settings, "MEMBER"),
  };
}

export async function setUnassignedForRole(
  role: "MANAGER" | "MEMBER",
  include: boolean,
) {
  const { setOrgSetting } = await import("@/lib/org-settings");
  await setOrgSetting(`unassigned.${role}`, include ? "true" : "false");
}

/**
 * @deprecated O cache agora é gerenciado em `lib/org-settings.ts` via
 * Redis + invalidação automática em `setOrgSetting`. Esta função
 * permanece como no-op para manter compatibilidade com chamadas
 * antigas (ex.: testes).
 */
export function clearVisibilityCache() {
  // no-op — cache movido para `lib/cache` org-aware.
}
