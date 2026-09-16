import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  createKeepCategory,
  KeepError,
  listKeepCategories,
  serializeKeepCategory,
} from "@/services/keeps/keeps";

export const dynamic = "force-dynamic";

function keepFail(err: unknown) {
  if (err instanceof KeepError) {
    return NextResponse.json({ message: err.message }, { status: err.status });
  }
  const prismaCode =
    typeof err === "object" && err && "code" in err ? String((err as { code?: string }).code) : "";
  if (prismaCode === "P2021") {
    return NextResponse.json(
      { message: "Tabelas do Bwipo Keeps ainda não existem neste banco. Rode a migration." },
      { status: 503 },
    );
  }
  const message = err instanceof Error ? err.message : "Erro ao salvar a categoria.";
  return NextResponse.json({ message }, { status: 500 });
}

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
    const cat = await createKeepCategory({
      orgId: r.session.user.organizationId,
      userId: r.session.user.id,
      name: typeof body.name === "string" ? body.name : "",
    });
    return NextResponse.json({ category: serializeKeepCategory(cat) }, { status: 201 });
  } catch (err) {
    return keepFail(err);
  }
}
