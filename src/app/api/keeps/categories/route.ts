import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { keepFail } from "@/services/keeps/keep-http";
import {
  createKeepCategory,
  listKeepCategories,
  serializeKeepCategory,
} from "@/services/keeps/keeps";
import { parseKeepCategoryColor } from "@/services/keeps/colors";

export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:view");
  if (denied) return denied;
  if (!r.session.user.organizationId) {
    return NextResponse.json({ message: "Organização obrigatória." }, { status: 403 });
  }

  try {
    const rows = await listKeepCategories({ userId: r.session.user.id });
    return NextResponse.json({ items: rows.map(serializeKeepCategory) });
  } catch (err) {
    return keepFail(err);
  }
}

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:edit");
  if (denied) return denied;
  if (!r.session.user.organizationId) {
    return NextResponse.json({ message: "Organização obrigatória." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  try {
    const color = parseKeepCategoryColor(body.color);
    if (!color) {
      return NextResponse.json({ message: "Cor da categoria obrigatória." }, { status: 400 });
    }
    const cat = await createKeepCategory({
      orgId: r.session.user.organizationId,
      userId: r.session.user.id,
      name: typeof body.name === "string" ? body.name : "",
      color,
    });
    return NextResponse.json({ category: serializeKeepCategory(cat) }, { status: 201 });
  } catch (err) {
    return keepFail(err);
  }
}
