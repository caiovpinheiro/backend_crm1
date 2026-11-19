/**
 * "Trocar de organização" sem logout.
 *
 * Modelo: o mesmo e-mail pode ter um `User` em cada organização — registros
 * independentes (id, papel, permissões, `sessionVersion`, MFA). Trocar de
 * organização = a sessão atual passa a ser a do `User` REAL da org de
 * destino. Nada no banco muda de dono: nenhum `userId`/`organizationId` é
 * alterado; só o cookie de sessão é reemitido.
 *
 * Segurança
 * ─────────
 * 1. Coincidência de e-mail NÃO autoriza nada. A primeira troca para uma
 *    conta exige a senha (+ MFA, se ligado) DELA, com o mesmo lockout por
 *    e-mail do login (`/api/me/organizations/switch`). Validada, grava um
 *    vínculo (`UserAccountLink`) entre as duas contas.
 * 2. O vínculo vale enquanto os dois lados mantêm a `sessionVersion`
 *    gravada nele (`isLinkCurrent`): troca de senha, "sair de todos os
 *    dispositivos", revogação pelo admin ou erase em qualquer lado o
 *    invalidam, e a próxima troca volta a pedir senha/MFA.
 * 3. O frontend nunca escreve claims. A rota devolve um TICKET de uso
 *    único (60 s), ligado ao usuário e ao `sid` da sessão que pediu e à
 *    conta de destino. O cliente chama `update({ orgSwitch: ticket })`
 *    (`POST /api/auth/session`, com CSRF) e o callback `jwt` de `auth.ts`
 *    chama `consumeOrgSwitch`, que relê o banco (origem e destino ativos,
 *    org ACTIVE, mesmo e-mail, vínculo vigente) e só então devolve as
 *    claims do destino — `id`, papel, org, slug, `sessionVersion` e um
 *    `sid` novo. Qualquer falha devolve `null` e o token fica como estava:
 *    a sessão da org atual continua intacta.
 * 4. Só contas elegíveis ao login: humano, com senha, e-mail confirmado,
 *    não apagado, org ACTIVE. Super-admin (origem ou destino) fica de fora
 *    — entra pelo login normal.
 *
 * O ticket mora no Redis do cache (o `update()` pode cair em outra
 * réplica); sem Redis, na memória do processo — mesmo desenho de
 * `session-renewal.ts`. Consumo atômico (`MULTI GET+DEL`).
 */
import { createHash, randomBytes } from "node:crypto";

import { logAuditAsync } from "@/lib/audit/log";
import { getCacheClient } from "@/lib/cache/redis-client";
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";

import type { AppUserRole } from "../auth-types";
import { sessionVersionFromClaim } from "./session-version";

const log = getLogger("auth");

export const ORG_SWITCH_TTL_MS = 60_000;
/** Campo do corpo do `update()` que leva o ticket. */
export const ORG_SWITCH_FIELD = "orgSwitch";

const KEY_PREFIX = "auth:org-switch:";
const MAX_MEMORY_ENTRIES = 5_000;
/** 32 bytes em base64url = 43 caracteres. */
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

// ─── Contas ──────────────────────────────────────────────────────────────

export type SourceAccount = {
  id: string;
  email: string;
  organizationId: string;
  sessionVersion: number;
};

const SOURCE_SELECT = {
  id: true,
  email: true,
  type: true,
  isErased: true,
  isSuperAdmin: true,
  organizationId: true,
  sessionVersion: true,
  organization: { select: { status: true } },
} as const;

/**
 * Conta da sessão atual, lida do banco (nunca do JWT). `null` quando ela
 * não pode trocar de organização: apagada, IA, super-admin, sem org ou org
 * fora de ACTIVE.
 */
export async function loadSourceAccount(userId: string): Promise<SourceAccount | null> {
  const row = await prismaBase.user.findUnique({ where: { id: userId }, select: SOURCE_SELECT });
  if (
    !row ||
    row.isErased ||
    row.type !== "HUMAN" ||
    row.isSuperAdmin ||
    !row.organizationId ||
    row.organization?.status !== "ACTIVE"
  ) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    organizationId: row.organizationId,
    sessionVersion: sessionVersionFromClaim(row.sessionVersion),
  };
}

const TARGET_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  avatarUrl: true,
  hashedPassword: true,
  mfaSecret: true,
  mfaEnabledAt: true,
  sessionVersion: true,
  organizationId: true,
  organization: { select: { id: true, slug: true, name: true, logoUrl: true } },
} as const;

/**
 * Filtro de conta de destino elegível — o mesmo critério do login
 * (`authorize()`): mesmo e-mail, humano, com senha, e-mail confirmado, não
 * apagado, org ACTIVE. Super-admin fica de fora.
 */
function eligibleTargetWhere(source: SourceAccount) {
  return {
    email: source.email,
    id: { not: source.id },
    type: "HUMAN" as const,
    isErased: false,
    isSuperAdmin: false,
    hashedPassword: { not: null },
    emailVerifiedAt: { not: null },
    organizationId: { not: null },
    organization: { status: "ACTIVE" as const },
  };
}

export type TargetAccount = {
  id: string;
  name: string;
  email: string;
  role: AppUserRole;
  avatarUrl: string | null;
  hashedPassword: string | null;
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
  sessionVersion: number;
  organizationId: string;
  organization: { id: string; slug: string; name: string; logoUrl: string | null };
};

type TargetRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
  hashedPassword: string | null;
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
  sessionVersion: number;
  organizationId: string | null;
  organization: { id: string; slug: string; name: string; logoUrl: string | null } | null;
};

function toTarget(row: TargetRow): TargetAccount | null {
  if (!row.organizationId || !row.organization) return null;
  return {
    ...row,
    role: row.role as AppUserRole,
    organizationId: row.organizationId,
    organization: row.organization,
    sessionVersion: sessionVersionFromClaim(row.sessionVersion),
  };
}

export async function listEligibleTargets(source: SourceAccount): Promise<TargetAccount[]> {
  const rows = (await prismaBase.user.findMany({
    where: eligibleTargetWhere(source),
    select: TARGET_SELECT,
  })) as TargetRow[];
  return rows.map(toTarget).filter((t): t is TargetAccount => t !== null);
}

/** Conta elegível do mesmo e-mail na org pedida (ou com o id pedido). */
export async function findEligibleTarget(
  source: SourceAccount,
  by: { organizationId: string } | { userId: string },
): Promise<TargetAccount | null> {
  const row = (await prismaBase.user.findFirst({
    where: {
      ...eligibleTargetWhere(source),
      ...("userId" in by ? { id: by.userId } : {}),
      ...("organizationId" in by ? { organizationId: by.organizationId } : {}),
    },
    select: TARGET_SELECT,
  })) as TargetRow | null;
  if (!row) return null;
  // Defesa extra: `id: { not }` do filtro geral e o `id` pedido se
  // sobrepõem no objeto — confere de novo aqui.
  if (row.id === source.id) return null;
  return toTarget(row);
}

// ─── Vínculo ─────────────────────────────────────────────────────────────

type Versioned = { id: string; sessionVersion: number };

export type LinkRow = {
  userAId: string;
  userBId: string;
  userAVersion: number;
  userBVersion: number;
};

/** Par canônico (`userAId < userBId`) com a versão de cada lado. */
export function canonicalPair(x: Versioned, y: Versioned) {
  const [a, b] = x.id < y.id ? [x, y] : [y, x];
  return {
    userAId: a.id,
    userBId: b.id,
    userAVersion: a.sessionVersion,
    userBVersion: b.sessionVersion,
  };
}

/** O vínculo ainda vale: mesmos usuários e nenhuma revogação em nenhum lado. */
export function isLinkCurrent(link: LinkRow | null | undefined, x: Versioned, y: Versioned): boolean {
  if (!link) return false;
  const want = canonicalPair(x, y);
  return (
    link.userAId === want.userAId &&
    link.userBId === want.userBId &&
    link.userAVersion === want.userAVersion &&
    link.userBVersion === want.userBVersion
  );
}

async function findLink(x: Versioned, y: Versioned): Promise<LinkRow | null> {
  const pair = canonicalPair(x, y);
  return prismaBase.userAccountLink.findUnique({
    where: { userAId_userBId: { userAId: pair.userAId, userBId: pair.userBId } },
    select: { userAId: true, userBId: true, userAVersion: true, userBVersion: true },
  });
}

export async function hasCurrentLink(source: SourceAccount, target: TargetAccount): Promise<boolean> {
  return isLinkCurrent(await findLink(source, target), source, target);
}

/** Vínculos da conta de origem, por id da outra conta. */
export async function linksOf(source: SourceAccount): Promise<Map<string, LinkRow>> {
  const rows = await prismaBase.userAccountLink.findMany({
    where: { OR: [{ userAId: source.id }, { userBId: source.id }] },
    select: { userAId: true, userBId: true, userAVersion: true, userBVersion: true },
  });
  const out = new Map<string, LinkRow>();
  for (const row of rows) out.set(row.userAId === source.id ? row.userBId : row.userAId, row);
  return out;
}

/** Grava (ou revalida) o vínculo com as versões atuais dos dois lados. */
export async function upsertLink(source: SourceAccount, target: TargetAccount): Promise<void> {
  const pair = canonicalPair(source, target);
  await prismaBase.userAccountLink.upsert({
    where: { userAId_userBId: { userAId: pair.userAId, userBId: pair.userBId } },
    create: pair,
    update: { userAVersion: pair.userAVersion, userBVersion: pair.userBVersion },
  });
}

// ─── Ticket de uso único ─────────────────────────────────────────────────

type StoredTicket = { fromUserId: string; sid: string; toUserId: string };
type MemoryEntry = StoredTicket & { expiresAt: number };

const memory = new Map<string, MemoryEntry>();

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function decode(raw: string): StoredTicket | null {
  try {
    const v = JSON.parse(raw) as Partial<StoredTicket>;
    if (typeof v.fromUserId !== "string" || typeof v.toUserId !== "string") return null;
    return { fromUserId: v.fromUserId, toUserId: v.toUserId, sid: typeof v.sid === "string" ? v.sid : "" };
  } catch {
    return null;
  }
}

function memoryPut(hash: string, ticket: StoredTicket, now: number): void {
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(key);
  }
  memory.set(hash, { ...ticket, expiresAt: now + ORG_SWITCH_TTL_MS });
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

function memoryTake(hash: string, now: number): StoredTicket | null {
  const entry = memory.get(hash);
  if (!entry) return null;
  memory.delete(hash);
  if (entry.expiresAt <= now) return null;
  return { fromUserId: entry.fromUserId, sid: entry.sid, toUserId: entry.toUserId };
}

export type OrgSwitchTicket = { token: string; expiresInSec: number };

export async function issueOrgSwitchTicket(args: {
  fromUserId: string;
  sid: string | null | undefined;
  toUserId: string;
}): Promise<OrgSwitchTicket> {
  const token = randomBytes(32).toString("base64url");
  const hash = hashTicket(token);
  const stored: StoredTicket = { fromUserId: args.fromUserId, sid: args.sid ?? "", toUserId: args.toUserId };

  let saved = false;
  const client = getCacheClient();
  if (client) {
    try {
      const reply = await client.set(KEY_PREFIX + hash, JSON.stringify(stored), "PX", ORG_SWITCH_TTL_MS, "NX");
      saved = reply === "OK";
    } catch (err) {
      log.warn({ err, userId: args.fromUserId }, "[auth] ticket de troca de org: Redis falhou — usando memória");
    }
  }
  if (!saved) memoryPut(hash, stored, Date.now());
  return { token, expiresInSec: Math.floor(ORG_SWITCH_TTL_MS / 1000) };
}

async function takeTicket(ticket: string): Promise<StoredTicket | null> {
  const hash = hashTicket(ticket);
  const client = getCacheClient();
  if (client) {
    try {
      const key = KEY_PREFIX + hash;
      const replies = await client.multi().get(key).del(key).exec();
      const raw = replies?.[0]?.[1];
      const deleted = replies?.[1]?.[1];
      if (typeof raw === "string" && deleted === 1) {
        memory.delete(hash);
        return decode(raw);
      }
    } catch (err) {
      log.warn({ err }, "[auth] ticket de troca de org: leitura no Redis falhou");
    }
  }
  return memoryTake(hash, Date.now());
}

/** Extrai o ticket do corpo do `update()`. Qualquer outra coisa = sem ticket. */
export function orgSwitchTicketFrom(updateData: unknown): string | null {
  if (typeof updateData !== "object" || updateData === null) return null;
  const value = (updateData as Record<string, unknown>)[ORG_SWITCH_FIELD];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Claims da sessão de destino (as únicas que a troca escreve no JWT). */
export type OrgSwitchClaims = {
  id: string;
  name: string;
  email: string;
  role: AppUserRole;
  organizationId: string;
  organizationSlug: string;
  picture: string | null;
  sessionVersion: number;
};

/**
 * Chamado pelo callback `jwt` (`trigger: "update"`) DEPOIS de a sessão
 * atual passar pelas checagens de revogação. Consome o ticket e relê tudo
 * do banco. `null` = não troca (o token fica como estava).
 */
export async function consumeOrgSwitch(args: {
  ticket: string;
  userId: string;
  sid: string | null | undefined;
}): Promise<OrgSwitchClaims | null> {
  const { ticket, userId } = args;
  if (!TICKET_RE.test(ticket)) return deny(userId, "malformed");
  const stored = await takeTicket(ticket);
  if (!stored) return deny(userId, "unknown_or_used");
  if (stored.fromUserId !== userId) return deny(userId, "other_user");
  if (stored.sid !== (args.sid ?? "")) return deny(userId, "other_session");

  try {
    const source = await loadSourceAccount(userId);
    if (!source) return deny(userId, "source_ineligible");
    const target = await findEligibleTarget(source, { userId: stored.toUserId });
    if (!target) return deny(userId, "target_ineligible");
    if (!(await hasCurrentLink(source, target))) return deny(userId, "link_not_current");

    const pair = canonicalPair(source, target);
    await prismaBase.userAccountLink
      .update({
        where: { userAId_userBId: { userAId: pair.userAId, userBId: pair.userBId } },
        data: { lastUsedAt: new Date() },
      })
      .catch((err: unknown) => log.warn({ err }, "[auth] org-switch: lastUsedAt falhou"));

    log.info(
      { fromUserId: source.id, toUserId: target.id, toOrganizationId: target.organizationId },
      "[auth] sessão trocada de organização",
    );
    logAuditAsync({
      entity: "user",
      action: "org_switch_out",
      entityId: source.id,
      organizationId: source.organizationId,
      actorId: source.id,
      actorEmail: source.email,
      metadata: { toOrganizationId: target.organizationId, toUserId: target.id },
    });
    logAuditAsync({
      entity: "user",
      action: "org_switch_in",
      entityId: target.id,
      organizationId: target.organizationId,
      actorId: target.id,
      actorEmail: target.email,
      metadata: { fromOrganizationId: source.organizationId, fromUserId: source.id },
    });

    return {
      id: target.id,
      name: target.name,
      email: target.email,
      role: target.role,
      organizationId: target.organizationId,
      organizationSlug: target.organization.slug,
      picture: target.avatarUrl ?? null,
      sessionVersion: target.sessionVersion,
    };
  } catch (err) {
    log.error({ err, userId }, "[auth] org-switch: falha ao consumir o ticket");
    return null;
  }
}

function deny(userId: string, reason: string): null {
  log.warn({ userId, reason }, "[auth] troca de organização recusada");
  return null;
}

/** Só testes. */
export function clearOrgSwitchTicketsForTests(): void {
  memory.clear();
}
