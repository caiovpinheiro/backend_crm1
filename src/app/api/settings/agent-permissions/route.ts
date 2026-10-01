import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/agent-permissions");

// GET /api/settings/agent-permissions
// Returns all human users in the org with their AgentPermission (if any).
// Auth: ADMIN or MANAGER only.
export async function GET() {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN" && session.user.role !== "MANAGER") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }

    try {
      // Query users without agentPermission join — the agent_permissions table
      // may not exist yet if the migration hasn't run on this environment.
      const users = await prisma.user.findMany({
        where: {
          organizationId: session.user.organizationId!,
          type: "HUMAN",
          isErased: false,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          avatarUrl: true,
          agentStatus: {
            select: { status: true },
          },
        },
        orderBy: { name: "asc" },
      });

      // Fetch permissions separately so a missing table degrades gracefully.
      let permMap = new Map<string, object>();
      try {
        const perms = await prisma.agentPermission.findMany({
          where: { organizationId: session.user.organizationId! },
        });
        for (const p of perms) permMap.set(p.userId, p);
      } catch {
        // Table doesn't exist yet (migration pending) — permissions will be null.
      }

      const result = users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        avatarUrl: u.avatarUrl,
        isOnline: u.agentStatus?.status === "ONLINE",
        permissions: permMap.get(u.id) ?? null,
      }));

      return NextResponse.json(result);
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json({ message: "Erro ao listar agentes." }, { status: 500 });
    }
  });
}
