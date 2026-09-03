import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withOrgContext(async () => {
  const { id } = await context.params;

  const conv = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true, contactId: true, status: true, updatedAt: true },
  });
  if (!conv) {
    return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
  }

  let fieldLastInboundAt: Date | null = null;
  try {
    const full = await prisma.conversation.findUnique({
      where: { id },
      select: { lastInboundAt: true },
    });
    fieldLastInboundAt = full?.lastInboundAt ?? null;
  } catch { /* column might not exist */ }

  const lastInMsg = await prisma.message.findFirst({
    where: { conversationId: id, direction: "in" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, content: true, senderName: true },
  });

  const allInbound = await prisma.message.findMany({
    where: { conversationId: id, direction: "in" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { createdAt: true, content: true, senderName: true },
  });

  const totalMessages = await prisma.message.count({
    where: { conversationId: id },
  });
  const inboundCount = await prisma.message.count({
    where: { conversationId: id, direction: "in" },
  });

  const now = new Date();
  const SESSION_MS = 24 * 60 * 60 * 1000;

  const queryLastInbound = lastInMsg?.createdAt ?? null;
  const diffFieldMs = fieldLastInboundAt ? now.getTime() - fieldLastInboundAt.getTime() : null;
  const diffQueryMs = queryLastInbound ? now.getTime() - queryLastInbound.getTime() : null;

  return NextResponse.json({
    serverNow: now.toISOString(),
    conversationId: id,
    contactId: conv.contactId,
    totalMessages,
    inboundMessages: inboundCount,
    field_lastInboundAt: fieldLastInboundAt?.toISOString() ?? null,
    field_diffHours: diffFieldMs !== null ? +(diffFieldMs / 3_600_000).toFixed(2) : null,
    field_sessionActive: diffFieldMs !== null ? diffFieldMs < SESSION_MS : null,
    query_lastInboundAt: queryLastInbound?.toISOString() ?? null,
    query_lastContent: lastInMsg?.content?.slice(0, 50) ?? null,
    query_lastSender: lastInMsg?.senderName ?? null,
    query_diffHours: diffQueryMs !== null ? +(diffQueryMs / 3_600_000).toFixed(2) : null,
    query_sessionActive: diffQueryMs !== null ? diffQueryMs < SESSION_MS : null,
    recentInbound: allInbound.map((m) => ({
      at: m.createdAt.toISOString(),
      content: m.content?.slice(0, 40),
      sender: m.senderName,
      hoursAgo: +((now.getTime() - m.createdAt.getTime()) / 3_600_000).toFixed(2),
    })),
  });
  });
}
