import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { createRoom, listRooms } from "@/services/team-chat";
import { denyUnless, isServiceError, jsonError, viewerOf } from "../_guard";

const CreateRoom = z.object({
  memberIds: z.array(z.string().min(1)).min(1).max(80),
  name: z.string().trim().max(80).optional(),
  topic: z.string().trim().max(200).optional(),
});

export async function GET() {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const rooms = await listRooms(viewerOf(session));
    return NextResponse.json({ rooms });
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:create_room");
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    const parsed = CreateRoom.safeParse(body);
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await createRoom(viewerOf(session), parsed.data);
    if (isServiceError(result)) return jsonError(result.error, result.status);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  });
}
