import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { listMessages, markRead, sendMessage } from "@/services/team-chat";
import { denyUnless, jsonError, viewerOf } from "../../../_guard";

const Attachment = z.object({
  url: z.string().max(500).optional().default(""),
  name: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(120),
  size: z.number().int().min(0).max(16 * 1024 * 1024),
  kind: z.enum(["image", "audio", "video", "file", "sticker"]),
  emoji: z.string().max(16).optional(),
});

const Send = z
  .object({
    content: z.string().max(4000).optional().default(""),
    attachments: z.array(Attachment).max(8).optional().default([]),
    anchor: z
      .object({
        type: z.enum(["deal", "conversation", "contact", "work_item"]),
        id: z.string().min(1),
      })
      .optional()
      .nullable(),
  })
  .refine(
    (d) => d.content.trim().length > 0 || d.attachments.length > 0 || !!d.anchor,
    { message: "Mensagem vazia." },
  );

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const { id } = await params;
    const url = new URL(request.url);
    const result = await listMessages(viewerOf(session), id, {
      before: url.searchParams.get("before") ?? undefined,
      take: url.searchParams.get("take")
        ? Number(url.searchParams.get("take"))
        : undefined,
    });
    if ("error" in result) return jsonError(result.error, result.status);
    await markRead(viewerOf(session), id);
    return NextResponse.json(result);
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:send");
    if (denied) return denied;
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const parsed = Send.safeParse(body);
    if (!parsed.success) return jsonError("Mensagem inválida.", 400);
    const result = await sendMessage(viewerOf(session), id, parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.message, { status: 201 });
  });
}
