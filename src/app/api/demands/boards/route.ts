import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { denyUnless, jsonError } from "../_guard";
import { createBoard, listAssignableUsers, listBoards } from "@/services/demands";

export async function GET() {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:view");
    if (denied) return denied;
    try {
      const [boards, users] = await Promise.all([
        listBoards(),
        listAssignableUsers(),
      ]);
      return NextResponse.json({ boards, users });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Não foi possível carregar os boards.";
      return jsonError(message, 500);
    }
  });
}

const CreateBoard = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.string().trim().max(40).optional(),
  description: z.string().trim().max(500).optional(),
  color: z.string().trim().max(20).optional(),
});

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:manage_board");
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    const parsed = CreateBoard.safeParse(body);
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const board = await createBoard(parsed.data);
    return NextResponse.json(board, { status: 201 });
  });
}
