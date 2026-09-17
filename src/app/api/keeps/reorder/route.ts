import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { keepFail } from "@/services/keeps/keep-http";
import { reorderKeepNotes } from "@/services/keeps/keeps";

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
  const items: Array<{
    id: string;
    position: number;
    pinned?: boolean;
    categoryId?: string | null;
  }> = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.position !== "number") {
      return NextResponse.json({ message: "Lista de ordem inválida." }, { status: 400 });
    }
    const item: {
      id: string;
      position: number;
      pinned?: boolean;
      categoryId?: string | null;
    } = { id: rec.id, position: rec.position };
    if ("pinned" in rec) {
      if (typeof rec.pinned !== "boolean") {
        return NextResponse.json({ message: "Lista de ordem inválida." }, { status: 400 });
      }
      item.pinned = rec.pinned;
    }
    if ("categoryId" in rec) {
      if (rec.categoryId !== null && typeof rec.categoryId !== "string") {
        return NextResponse.json({ message: "Lista de ordem inválida." }, { status: 400 });
      }
      item.categoryId = rec.categoryId as string | null;
    }
    items.push(item);
  }

  try {
    await reorderKeepNotes({ userId: r.session.user.id, items });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return keepFail(err);
  }
}
