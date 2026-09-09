import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { KeepError, reorderKeepNotes } from "@/services/keeps/keeps";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:edit");
  if (denied) return denied;
  if (!r.session.user.organizationId) {
    return NextResponse.json({ message: "Organização obrigatória." }, { status: 403 });
  }

  let body: { items?: unknown };
  try {
    body = (await request.json()) as { items?: unknown };
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const raw = Array.isArray(body.items) ? body.items : [];
  const items: Array<{ id: string; pinned: boolean; position: number }> = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.pinned !== "boolean" || typeof rec.position !== "number") {
      return NextResponse.json({ message: "Lista de ordem inválida." }, { status: 400 });
    }
    items.push({ id: rec.id, pinned: rec.pinned, position: rec.position });
  }

  try {
    await reorderKeepNotes({ userId: r.session.user.id, items });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof KeepError) {
      return NextResponse.json({ message: err.message }, { status: err.status });
    }
    throw err;
  }
}
