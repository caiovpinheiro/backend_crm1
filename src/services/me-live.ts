/**
 * Voláteis da ORG para `GET /api/me/live`: o que saiu das variantes estáveis
 * (`x-bootstrap-version: 2`) de `GET /api/users` e
 * `GET /api/settings/departments`.
 *
 * ## `usersPresence` — `{ [userId]: UserPresence }`
 *
 * Os 3 campos que a lista estável de usuários não traz, com o MESMO formato
 * da lista legada. Reconstrução no frontend:
 *
 *   legado = { ...estavel, ...(usersPresence[estavel.id] ?? USER_PRESENCE_DEFAULT) }
 *
 * Inclui todo usuário não anonimizado da org (humanos e agentes de IA), para
 * servir tanto a `/api/users` quanto a `/api/users?includeAi=1`. Quem não
 * aparece = `USER_PRESENCE_DEFAULT` (offline, nunca visto, sem status).
 *
 * Custo: 1 `findMany` de usuários (id + status) + a presença
 * (`getSystemPresenceMap`, 2 consultas), em cache por org no Redis por
 * `USERS_PRESENCE_TTL_SEC` e versionado por `rc_agent_status` — troca de
 * status aparece na hora; presença de uso em até 30 s (a lista legada tinha
 * 60 s). Todas as abas da org compartilham a mesma entrada.
 *
 * ## `departmentCounts` — `{ [departmentId]: { openConversations } }`
 *
 * Só para ADMIN/MANAGER (quem recebe `_count.conversations` hoje).
 * Reconstrução:
 *
 *   legado = { ...estavel, _count: { ...estavel._count,
 *              conversations: departmentCounts[estavel.id]?.openConversations ?? 0 } }
 *
 * Departamento sem conversa aberta não aparece (= 0). Custo: 1 `groupBy`, em
 * cache por org versionado por `inbox_tab_counts` (a mesma família que já
 * invalidava a variante legada da rota), TTL 10 min.
 */
import { cache } from "@/lib/cache";
import { cacheVersionName, getCacheVersion } from "@/lib/cache/versions";
import { prisma } from "@/lib/prisma";
import { RESPONSE_FAMILIES } from "@/lib/cache/response-families";
import { getSystemPresenceMap } from "@/services/system-presence";

export type UserPresence = {
  systemOnline: boolean;
  /** ISO 8601 ou `null`. */
  lastSeenAt: string | null;
  /** Mesmo `select` da lista legada; `null` = sem linha de status. */
  agentStatus: { status: string; availableForVoiceCalls: boolean; updatedAt: string } | null;
};

export const USER_PRESENCE_DEFAULT: UserPresence = {
  systemOnline: false,
  lastSeenAt: null,
  agentStatus: null,
};

export type DepartmentCount = { openConversations: number };

export const USERS_PRESENCE_TTL_SEC = 30;
const DEPARTMENT_COUNTS_TTL_SEC = 600;

function isManagerUp(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "MANAGER";
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

async function loadUsersPresenceFromDb(orgId: string): Promise<Record<string, UserPresence>> {
  const users = await prisma.user.findMany({
    where: { organizationId: orgId, isErased: false },
    select: {
      id: true,
      agentStatus: { select: { status: true, availableForVoiceCalls: true, updatedAt: true } },
    },
  });
  let presence: Awaited<ReturnType<typeof getSystemPresenceMap>> = new Map();
  try {
    presence = await getSystemPresenceMap({
      organizationId: orgId,
      userIds: users.map((u) => u.id),
    });
  } catch {
    // Igual à lista legada: sem presença em erro transiente/migration.
  }
  const out: Record<string, UserPresence> = {};
  for (const u of users) {
    const p = presence.get(u.id);
    out[u.id] = {
      systemOnline: p?.systemOnline ?? false,
      lastSeenAt: iso(p?.lastSeenAt),
      agentStatus: u.agentStatus
        ? {
            status: u.agentStatus.status,
            availableForVoiceCalls: u.agentStatus.availableForVoiceCalls,
            updatedAt: iso(u.agentStatus.updatedAt) as string,
          }
        : null,
    };
  }
  return out;
}

/** Presença da org (`null` sem org — super-admin puro, como `/api/users`). */
export async function loadUsersPresence(
  orgId: string | null,
): Promise<Record<string, UserPresence> | null> {
  if (!orgId) return null;
  const version = await getCacheVersion(
    cacheVersionName(RESPONSE_FAMILIES.agentStatus, orgId),
  );
  return cache.wrap(`me_live:presence:${orgId}:v${version}`, USERS_PRESENCE_TTL_SEC, () =>
    loadUsersPresenceFromDb(orgId),
  );
}

async function loadDepartmentCountsFromDb(orgId: string): Promise<Record<string, DepartmentCount>> {
  const rows = await prisma.conversation.groupBy({
    by: ["departmentId"],
    where: { organizationId: orgId, status: "OPEN", departmentId: { not: null } },
    _count: { _all: true },
  });
  const out: Record<string, DepartmentCount> = {};
  for (const r of rows) {
    if (r.departmentId) out[r.departmentId] = { openConversations: r._count._all };
  }
  return out;
}

/** Abertas por departamento; `null` para quem não é ADMIN/MANAGER ou sem org. */
export async function loadDepartmentCounts(user: {
  organizationId: string | null;
  role?: string | null;
}): Promise<Record<string, DepartmentCount> | null> {
  const orgId = user.organizationId;
  if (!orgId || !isManagerUp(user.role)) return null;
  const version = await getCacheVersion(
    cacheVersionName(RESPONSE_FAMILIES.inboxTabCounts, orgId),
  );
  return cache.wrap(`me_live:dept_open:${orgId}:v${version}`, DEPARTMENT_COUNTS_TTL_SEC, () =>
    loadDepartmentCountsFromDb(orgId),
  );
}
