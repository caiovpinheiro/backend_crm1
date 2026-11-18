/**
 * Gestão das conexões MCP (tela `/settings/mcp`). Todas as consultas
 * filtram `organizationId` explicitamente (tabelas MCP não estão na
 * extension tenant — o fluxo OAuth roda sem RequestContext).
 *
 * Regra de alcance: quem tem `mcp:manage` vê e revoga as conexões da org;
 * os demais, só as próprias.
 */
import { logAudit } from "@/lib/audit/log";
import { intersectScopes, sanitizeScopes } from "@/lib/mcp/scopes";
import { prismaBase } from "@/lib/prisma-base";
import { revokeConnection } from "@/services/mcp/oauth";

export type McpViewer = { id: string; organizationId: string; canManage: boolean };

const CONNECTION_SELECT = {
  id: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  lastError: true,
  lastErrorAt: true,
  revokedAt: true,
  userId: true,
  user: { select: { id: true, name: true, email: true } },
  client: { select: { clientName: true, clientUri: true, logoUri: true, redirectUris: true } },
} as const;

function redirectHost(uris: string[]): string | null {
  try {
    const u = new URL(uris[0] ?? "");
    return u.host || u.protocol.replace(":", "");
  } catch {
    return null;
  }
}

export async function listConnections(
  viewer: McpViewer,
  opts: { all?: boolean; includeRevoked?: boolean } = {},
) {
  const rows = await prismaBase.mcpConnection.findMany({
    where: {
      organizationId: viewer.organizationId,
      ...(opts.all && viewer.canManage ? {} : { userId: viewer.id }),
      ...(opts.includeRevoked ? {} : { revokedAt: null }),
    },
    orderBy: [{ revokedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
    take: 200,
    select: CONNECTION_SELECT,
  });
  // Teto de cada conexão = escopos do último consentimento (último CODE).
  const codes = rows.length
    ? await prismaBase.mcpToken.findMany({
        where: { organizationId: viewer.organizationId, kind: "CODE", connectionId: { in: rows.map((r) => r.id) } },
        orderBy: { createdAt: "desc" },
        select: { connectionId: true, scopes: true },
      })
    : [];
  const consented = new Map<string, string[]>();
  for (const c of codes) if (!consented.has(c.connectionId)) consented.set(c.connectionId, c.scopes);
  return rows.map((r) => ({
    id: r.id,
    consentedScopes: consented.get(r.id) ?? r.scopes,
    clientName: r.client.clientName,
    clientUri: r.client.clientUri,
    redirectHost: redirectHost(r.client.redirectUris),
    scopes: r.scopes,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt,
    revokedAt: r.revokedAt,
    user: r.user,
    isMine: r.userId === viewer.id,
  }));
}

async function loadOwned(viewer: McpViewer, connectionId: string) {
  const row = await prismaBase.mcpConnection.findFirst({
    where: { id: connectionId, organizationId: viewer.organizationId },
    select: { id: true, userId: true, scopes: true, revokedAt: true },
  });
  if (!row) return null;
  if (row.userId !== viewer.id && !viewer.canManage) return null;
  return row;
}

export async function revokeConnectionAsViewer(viewer: McpViewer, connectionId: string) {
  const row = await loadOwned(viewer, connectionId);
  if (!row) return { ok: false as const, status: 404 };
  await revokeConnection(viewer.organizationId, connectionId, viewer.id);
  return { ok: true as const };
}

/**
 * Ajusta os escopos de uma conexão. Só REDUZ (ou restaura dentro do que já
 * foi consentido): ampliar exige novo consentimento pelo assistente.
 */
export async function updateConnectionScopes(
  viewer: McpViewer,
  connectionId: string,
  scopes: unknown,
  consentedScopes?: string[],
) {
  const row = await loadOwned(viewer, connectionId);
  if (!row || row.revokedAt) return { ok: false as const, status: 404, message: "Conexão não encontrada." };
  const requested = sanitizeScopes(scopes);
  // Teto = escopos consentidos no último consentimento (último CODE emitido).
  const lastCode = await prismaBase.mcpToken.findFirst({
    where: { connectionId, organizationId: viewer.organizationId, kind: "CODE" },
    orderBy: { createdAt: "desc" },
    select: { scopes: true },
  });
  const ceiling = consentedScopes ?? lastCode?.scopes ?? row.scopes;
  const next = intersectScopes(requested, ceiling);
  if (next.length === 0) {
    return { ok: false as const, status: 400, message: "Mantenha ao menos uma permissão ou revogue a conexão." };
  }
  await prismaBase.mcpConnection.update({ where: { id: connectionId }, data: { scopes: next } });
  await logAudit({
    entity: "mcp_connection",
    action: "update",
    entityId: connectionId,
    organizationId: viewer.organizationId,
    actorId: viewer.id,
    before: { scopes: row.scopes },
    after: { scopes: next },
  });
  return { ok: true as const, scopes: next, consentedScopes: ceiling };
}

export async function listAuditLogs(
  viewer: McpViewer,
  opts: { connectionId?: string; cursor?: string; limit?: number; all?: boolean },
) {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const scopeMine = !(opts.all && viewer.canManage);
  const rows = await prismaBase.mcpAuditLog.findMany({
    where: {
      organizationId: viewer.organizationId,
      ...(scopeMine ? { userId: viewer.id } : {}),
      ...(opts.connectionId ? { connectionId: opts.connectionId } : {}),
      ...(opts.cursor ? { createdAt: { lt: new Date(opts.cursor) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    select: {
      id: true,
      tool: true,
      status: true,
      args: true,
      resultCount: true,
      durationMs: true,
      errorCode: true,
      createdAt: true,
      connectionId: true,
      userId: true,
      connection: { select: { client: { select: { clientName: true } } } },
    },
  });
  const page = rows.slice(0, limit);
  const userIds = [...new Set(page.map((r) => r.userId).filter((v): v is string => Boolean(v)))];
  const users = userIds.length
    ? await prismaBase.user.findMany({
        where: { id: { in: userIds }, organizationId: viewer.organizationId },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return {
    items: page.map((r) => ({
      id: r.id,
      tool: r.tool,
      status: r.status,
      args: r.args,
      resultCount: r.resultCount,
      durationMs: r.durationMs,
      errorCode: r.errorCode,
      createdAt: r.createdAt,
      connectionId: r.connectionId,
      clientName: r.connection?.client.clientName ?? null,
      userName: r.userId ? (names.get(r.userId) ?? null) : null,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].createdAt.toISOString() : null,
  };
}

/** Resumo para o cartão de status da tela. */
export async function getMcpStatus(organizationId: string) {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [activeConnections, calls24h, errors24h, lastCall, lastError] = await Promise.all([
    prismaBase.mcpConnection.count({ where: { organizationId, revokedAt: null } }),
    prismaBase.mcpAuditLog.count({ where: { organizationId, createdAt: { gte: since }, tool: { not: { startsWith: "oauth." } } } }),
    prismaBase.mcpAuditLog.count({ where: { organizationId, createdAt: { gte: since }, status: "error" } }),
    prismaBase.mcpAuditLog.findFirst({
      where: { organizationId, tool: { not: { startsWith: "oauth." } } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prismaBase.mcpAuditLog.findFirst({
      where: { organizationId, status: "error" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, tool: true, errorCode: true },
    }),
  ]);
  return {
    activeConnections,
    calls24h,
    errors24h,
    lastCallAt: lastCall?.createdAt ?? null,
    lastError: lastError ?? null,
  };
}
