import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import type { AppUserRole } from "@/lib/auth-types";
import { loadAuthzContext } from "@/lib/authz";
import { listAllowedChannelIds } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { getVisibilityFilter, withInboxQueueVisibility } from "@/lib/visibility";

type SessionUser = {
  id: string;
  role: AppUserRole;
  organizationId?: string | null;
  isSuperAdmin?: boolean;
};

const PG_INT4_MAX = 2_147_483_647;

/**
 * Dígitos → CUID da conversa na org; senão devolve o próprio id.
 * Bookmarks `?c=<number>` e o 1º frame do inbox (antes de normalizar).
 */
export async function resolveConversationId(
  idOrNumber: string,
): Promise<string | null> {
  if (!/^\d+$/.test(idOrNumber)) return idOrNumber;
  const n = Number(idOrNumber);
  if (!Number.isInteger(n) || n < 1 || n > PG_INT4_MAX) return null;
  const orgId = getOrgIdOrThrow();
  const row = await prisma.conversation.findUnique({
    where: { organizationId_number: { organizationId: orgId, number: n } },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** Verifica se o usuário pode listar/ver esta conversa (mesma regra da API GET /conversations). */
export async function userHasConversationAccess(
  user: SessionUser,
  conversationId: string
): Promise<boolean> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId },
    select: { id: true, assignedToId: true, channelId: true },
  });
  if (!conv) return false;

  // Quem está atribuído precisa responder — mesmo se o recorte de canal
  // / fila compartilhada da listagem estiver mais estreito que o GET :id.
  if (conv.assignedToId === user.id) return true;

  const { conversationWhere, includeUnassigned } = await getVisibilityFilter(user);
  let where = conversationWhere;
  try {
    const orgId = user.organizationId ?? getOrgIdOrThrow();
    const authz = await loadAuthzContext({
      userId: user.id,
      organizationId: orgId,
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });
    const perms: ReadonlySet<string> =
      authz.isSuperAdmin || authz.isAdmin ? new Set(["*"]) : authz.permissions;
    where = withInboxQueueVisibility(conversationWhere, {
      permissions: perms,
      includeUnassigned,
    });
  } catch {
    // Sem authz (jobs / contexto incompleto) — mantém where base.
  }
  const conditions: Prisma.ConversationWhereInput[] = [{ id: conversationId }];
  if (where && Object.keys(where).length > 0) {
    conditions.push(where);
  }
  // Escopo de canais por usuário (mesma regra do GET /conversations).
  const allowedChannelIds = await listAllowedChannelIds({
    id: user.id,
    role: user.role,
    organizationId: user.organizationId ?? getOrgIdOrThrow(),
  });
  if (allowedChannelIds) {
    // Mesmo predicado do GET /conversations — ticket sem canal não passa no `in`.
    conditions.push({ channelId: { in: allowedChannelIds } });
  }
  const n = await prisma.conversation.count({ where: { AND: conditions } });
  return n > 0;
}

/**
 * Retorna null se OK; caso contrário NextResponse 401/404 (404 para não vazar existência).
 */
export async function requireConversationAccess(
  session: {
    user?: {
      id?: string;
      role?: AppUserRole | string;
      organizationId?: string | null;
      isSuperAdmin?: boolean;
    };
  } | null,
  conversationId: string
): Promise<NextResponse | null> {
  if (!session?.user?.id) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }
  const role = session.user.role as AppUserRole | undefined;
  if (!role) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }
  const user: SessionUser = {
    id: session.user.id,
    role,
    organizationId: session.user.organizationId ?? undefined,
    isSuperAdmin: session.user.isSuperAdmin,
  };
  const resolvedId = await resolveConversationId(conversationId);
  if (!resolvedId) {
    return NextResponse.json(
      { message: "Conversa não encontrada ou sem permissão." },
      { status: 404 }
    );
  }
  const ok = await userHasConversationAccess(user, resolvedId);
  if (!ok) {
    return NextResponse.json(
      { message: "Conversa não encontrada ou sem permissão." },
      { status: 404 }
    );
  }
  return null;
}
