import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

/**
 * Resumo de um agente IA para quem só precisa identificá-lo (inbox).
 * Nunca devolve chave de provedor. Edição fica em `/api/ai-agents-v2/:id`.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async () => {
    const { id } = await params;
    const row = await prisma.aIAgentConfig.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        active: true,
        archetype: true,
        autonomyMode: true,
        inboxPolicy: true,
        user: { select: { name: true } },
      },
    });
    if (!row) {
      return NextResponse.json(
        { message: "Agente não encontrado." },
        { status: 404 },
      );
    }
    const { user, ...rest } = row;
    return NextResponse.json({ ...rest, name: user.name });
  });
}
