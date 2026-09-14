import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { addMembers, leaveRoom } from "@/services/team-chat";
import { denyUnless, jsonError, viewerOf } from "../../../_guard";

const AddMembers = z.object({
  memberIds: z.array(z.string().min(1)).min(1).max(80),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:create_room");
    if (denied) return denied;
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const parsed = AddMembers.safeParse(body);
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await addMembers(viewerOf(session), id, parsed.data.memberIds);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.room);
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const { id } = await params;
    const result = await leaveRoom(viewerOf(session), id);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result);
  });
}
