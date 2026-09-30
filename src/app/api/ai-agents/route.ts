import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

/**
 * Lista os agentes IA da organização. Usado pelos seletores de agente
 * (automações, inbox). Criação e edição ficam em `/api/ai-agents-v2`.
 */
export async function GET() {
  return withOrgContext(async () => {
    try {
      const rows = await prisma.aIAgentConfig.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          _count: { select: { knowledgeDocs: true } },
        },
      });
      return NextResponse.json(
        rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          name: r.user.name,
          email: r.user.email,
          avatarUrl: r.user.avatarUrl,
          archetype: r.archetype,
          model: r.model,
          autonomyMode: r.autonomyMode,
          enabledTools: r.enabledTools,
          active: r.active,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          knowledgeDocsCount: r._count.knowledgeDocs,
        })),
      );
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
