import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { createWorkItem, listRoomWorkItems, WORK_ITEM_TYPES } from "@/services/team-chat-work-items";
import { denyUnless, jsonError, viewerOf } from "../_guard";

const Entry = z.object({
  text: z.string().min(1).max(500),
  assigneeId: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
});

const Create = z.object({
  type: z.enum(WORK_ITEM_TYPES),
  title: z.string().trim().min(1).max(200),
  originType: z.enum(["room", "meeting", "message"]),
  originId: z.string().min(1),
  roomId: z.string().nullable().optional(),
  visibility: z.enum(["canal", "privado", "participantes"]).optional(),
  anchor: z.object({ type: z.string(), id: z.string() }).nullable().optional(),
  entries: z.array(Entry).max(40).optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  callUrl: z.string().max(500).nullable().optional(),
  recurrenceKey: z.string().max(120).nullable().optional(),
  participantIds: z.array(z.string()).max(40).optional(),
  postMessage: z.boolean().optional(),
});

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const roomId = new URL(request.url).searchParams.get("roomId");
    if (!roomId) return jsonError("Informe a conversa.", 400);
    const result = await listRoomWorkItems(viewerOf(session), roomId);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result);
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:work_item");
    if (denied) return denied;
    const parsed = Create.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await createWorkItem(viewerOf(session), parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.workItem, { status: 201 });
  });
}
