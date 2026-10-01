import { createHash, randomBytes } from "crypto";

// validateToken resolve orgId a partir do token ANTES de qualquer
// contexto existir — usa o client base. Dentro de routes autenticadas
// (listTokens/revokeToken) ja tem contexto, mas mantemos prismaBase pra
// consistencia e porque a extension exigiria contexto tambem nessas
// operacoes (o filtro por organizationId ja e feito explicitamente).
import { prismaBase as prisma } from "@/lib/prisma-base";
import { logAudit } from "@/lib/audit/log";

const TOKEN_PREFIX = "eduit_";

/**
 * Expiração padrão OPCIONAL (desligada por default): com
 * `API_TOKEN_DEFAULT_EXPIRY_DAYS=<dias>` no env, token criado sem
 * `expiresAt` expira em N dias. Sem a env, o token não expira —
 * comportamento histórico, mantido a pedido do produto.
 */
export const API_TOKEN_DEFAULT_EXPIRY_ENV = "API_TOKEN_DEFAULT_EXPIRY_DAYS";

/** RT-13: cache em memória do token validado (por hash) — evita 1 SELECT por request. */
export const API_TOKEN_CACHE_TTL_MS = 60 * 1000;
/** RT-13: `lastUsedAt` gravado no máximo 1×/min por token. */
export const API_TOKEN_LAST_USED_MIN_INTERVAL_MS = 60 * 1000;
const API_TOKEN_CACHE_MAX_ENTRIES = 5_000;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * `null` quando `API_TOKEN_DEFAULT_EXPIRY_DAYS` não está definida (ou é
 * inválida/≤ 0): token sem `expiresAt` não expira.
 */
export function defaultApiTokenExpiry(now: Date = new Date()): Date | null {
  const raw = process.env[API_TOKEN_DEFAULT_EXPIRY_ENV]?.trim();
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export async function generateToken(
  userId: string,
  organizationId: string,
  name: string,
  expiresAt?: Date | null
): Promise<{ id: string; token: string; prefix: string; expiresAt: Date | null }> {
  const raw = TOKEN_PREFIX + randomBytes(24).toString("hex");
  const tokenHash = hashToken(raw);
  const tokenPrefix = raw.slice(0, 12);
  // Expiração é opcional: sem `expiresAt` o token não expira, salvo se a
  // env `API_TOKEN_DEFAULT_EXPIRY_DAYS` estiver ligada.
  const effectiveExpiresAt =
    expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())
      ? expiresAt
      : defaultApiTokenExpiry();

  const record = await prisma.apiToken.create({
    data: {
      name: name.trim(),
      tokenHash,
      tokenPrefix,
      userId,
      organizationId,
      expiresAt: effectiveExpiresAt,
    },
    select: { id: true },
  });

  await logAudit({
    entity: "api_token",
    action: "token_create",
    entityId: record.id,
    organizationId,
    actorId: userId,
    after: {
      id: record.id,
      name: name.trim(),
      tokenPrefix,
      expiresAt: effectiveExpiresAt,
    },
  });

  return { id: record.id, token: raw, prefix: tokenPrefix, expiresAt: effectiveExpiresAt };
}

type ValidatedTokenRecord = {
  id: string;
  name: string;
  userId: string;
  organizationId: string;
  expiresAt: Date | null;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    organizationId: string | null;
    isSuperAdmin: boolean;
    organization: { status: string } | null;
  };
};

type CacheEntry = {
  record: ValidatedTokenRecord;
  cachedAt: number;
  lastUsedTouchedAt: number;
};

const tokenCache = new Map<string, CacheEntry>();

function cacheGet(tokenHash: string, now: number): CacheEntry | null {
  const hit = tokenCache.get(tokenHash);
  if (!hit) return null;
  if (now - hit.cachedAt > API_TOKEN_CACHE_TTL_MS) {
    tokenCache.delete(tokenHash);
    return null;
  }
  return hit;
}

function cacheSet(tokenHash: string, entry: CacheEntry): void {
  if (tokenCache.size >= API_TOKEN_CACHE_MAX_ENTRIES) {
    // Map preserva ordem de inserção: descarta o mais antigo.
    const oldest = tokenCache.keys().next().value;
    if (oldest) tokenCache.delete(oldest);
  }
  tokenCache.set(tokenHash, entry);
}

/** Remove o token do cache local (revogação). Só vale neste processo. */
export function invalidateApiTokenCache(tokenId?: string): void {
  if (!tokenId) {
    tokenCache.clear();
    return;
  }
  for (const [hash, entry] of tokenCache) {
    if (entry.record.id === tokenId) tokenCache.delete(hash);
  }
}

function isRecordUsable(record: ValidatedTokenRecord, now: Date): boolean {
  if (record.expiresAt && record.expiresAt < now) return false;
  // Bloqueio se a organizacao do token nao estiver ATIVA. Super-admin
  // ignora o check — token dele nao depende de org.
  if (
    record.user.organization &&
    record.user.organization.status !== "ACTIVE" &&
    !record.user.isSuperAdmin
  ) {
    return false;
  }
  return true;
}

export async function validateToken(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  const nowMs = Date.now();
  const now = new Date(nowMs);

  let entry = cacheGet(tokenHash, nowMs);
  if (!entry) {
    const record = (await prisma.apiToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        name: true,
        userId: true,
        organizationId: true,
        expiresAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            organizationId: true,
            isSuperAdmin: true,
            organization: { select: { status: true } },
          },
        },
      },
    })) as ValidatedTokenRecord | null;

    if (!record) return null;
    if (!isRecordUsable(record, now)) return null;

    entry = { record, cachedAt: nowMs, lastUsedTouchedAt: 0 };
    cacheSet(tokenHash, entry);
  } else if (!isRecordUsable(entry.record, now)) {
    // Expirou dentro da janela do cache.
    tokenCache.delete(tokenHash);
    return null;
  }

  const record = entry.record;

  if (nowMs - entry.lastUsedTouchedAt >= API_TOKEN_LAST_USED_MIN_INTERVAL_MS) {
    entry.lastUsedTouchedAt = nowMs;
    prisma.apiToken
      .update({ where: { id: record.id }, data: { lastUsedAt: now } })
      .catch(() => {});
  }

  return {
    tokenId: record.id,
    tokenHash,
    tokenName: record.name,
    organizationId: record.organizationId,
    user: record.user,
  };
}

export async function listTokens(userId: string, organizationId: string) {
  return prisma.apiToken.findMany({
    where: { userId, organizationId },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeToken(
  tokenId: string,
  userId: string,
  organizationId: string,
) {
  const existing = await prisma.apiToken.findFirst({
    where: { id: tokenId, userId, organizationId },
    select: { id: true, name: true, tokenPrefix: true, createdAt: true },
  });
  const result = await prisma.apiToken.deleteMany({
    where: { id: tokenId, userId, organizationId },
  });
  invalidateApiTokenCache(tokenId);
  if (existing) {
    await logAudit({
      entity: "api_token",
      action: "token_revoke",
      entityId: tokenId,
      organizationId,
      actorId: userId,
      before: existing,
    });
  }
  return result;
}
