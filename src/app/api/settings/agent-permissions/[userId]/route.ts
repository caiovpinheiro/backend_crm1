import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { bumpMeBootstrap } from "@/lib/cache/response-families";
import { prisma } from "@/lib/prisma";

const DEFAULT_PERMISSIONS = {
  canViewOtherAgentsConversations: false,
  disableConversationsWithoutAgent: false,
  canTransferConversation: true,
  canCloseConversation: true,
  canDeleteConversation: false,
  canManageQuickMessages: false,
  canConfigureFieldVisibility: false,
  allowedConnectionIds: [] as string[],
  allowedDepartmentIds: [] as string[],
};

const PermissionsSchema = z.object({
  canViewOtherAgentsConversations: z.boolean().optional(),
  disableConversationsWithoutAgent: z.boolean().optional(),
  canTransferConversation: z.boolean().optional(),
  canCloseConversation: z.boolean().optional(),
  canDeleteConversation: z.boolean().optional(),
  canManageQuickMessages: z.boolean().optional(),
  canConfigureFieldVisibility: z.boolean().optional(),
  allowedConnectionIds: z.array(z.string()).optional(),
  allowedDepartmentIds: z.array(z.string()).optional(),
});

// GET /api/settings/agent-permissions/[userId]
// Returns the AgentPermission record or default values if none exists.
// Auth: ADMIN or MANAGER.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN" && session.user.role !== "MANAGER") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }

    const { userId } = await params;

    const targetUser = await prisma.user.findFirst({
      where: { id: userId, organizationId: session.user.organizationId!, isErased: false },
      select: { id: true },
    });
    if (!targetUser) {
      return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
    }

    let permission = null;
    try {
      permission = await prisma.agentPermission.findUnique({ where: { userId } });
    } catch {
      // Table doesn't exist yet (migration pending) — return defaults.
    }

    return NextResponse.json(permission ?? { userId, ...DEFAULT_PERMISSIONS });
  });
}

// PUT /api/settings/agent-permissions/[userId]
// Upserts the user's AgentPermission and writes an AuditLog entry.
// Auth: ADMIN only.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }

    const { userId } = await params;

    const targetUser = await prisma.user.findFirst({
      where: { id: userId, organizationId: session.user.organizationId! },
    });
    if (!targetUser) {
      return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = PermissionsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", errors: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const before = await prisma.agentPermission.findUnique({ where: { userId } });

    let updated;
    try {
      updated = await prisma.agentPermission.upsert({
        where: { userId },
        create: {
          organizationId: session.user.organizationId!,
          userId,
          ...DEFAULT_PERMISSIONS,
          ...parsed.data,
        },
        update: parsed.data,
      });
    } catch {
      // Fallback: canConfigureFieldVisibility column might not exist yet — retry without it.
      const { canConfigureFieldVisibility: _omit, ...safeData } = parsed.data;
      const { canConfigureFieldVisibility: _omitDef, ...safeDefaults } = DEFAULT_PERMISSIONS;
      updated = await prisma.agentPermission.upsert({
        where: { userId },
        create: { organizationId: session.user.organizationId!, userId, ...safeDefaults, ...safeData },
        update: safeData,
      });
    }

    // `canConfigureFieldVisibility` entra nas permissões efetivas do
    // bootstrap v2 do usuário (cache por usuário).
    await bumpMeBootstrap(session.user.organizationId, userId);

    await prisma.auditLog.create({
      data: {
        organizationId: session.user.organizationId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        entity: "AgentPermission",
        entityId: updated.id,
        action: "upsert",
        before: before ? ({ ...before } as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        after: { ...updated } as unknown as Prisma.InputJsonValue,
      },
    });

    return NextResponse.json(updated);
  });
}
