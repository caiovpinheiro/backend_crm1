import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { getRoom, updateRoom } from "@/services/team-chat";
import { denyUnless, jsonError, viewerOf } from "../../_guard";

const PatchRoom = z
  .object({
    avatarUrl: z.union([z.string().trim().max(2000), z.null()]),
  })
  .strict();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const { id } = await params;
    const result = await getRoom(viewerOf(session), id);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.room);
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:create_room");
    if (denied) return denied;
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const parsed = PatchRoom.safeParse(body);
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await updateRoom(viewerOf(session), id, parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.room);
  });
}
