import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { deleteDistributionRule, updateDistributionRule } from "@/services/lead-distribution";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/distribution/[id]");

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
    }

    const b = body as Record<string, unknown>;
    if (typeof b.isActive !== "boolean") {
      return NextResponse.json({ message: "isActive é obrigatório." }, { status: 400 });
    }

    const updated = await updateDistributionRule(id, { isActive: b.isActive });
    return NextResponse.json(updated);
  } catch (e: unknown) {
    log.error({ err: e }, "PATCH falhou");
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2025") {
      return NextResponse.json({ message: "Regra não encontrada." }, { status: 404 });
    }
    return NextResponse.json({ message: "Erro ao atualizar regra." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    await deleteDistributionRule(id);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    log.error({ err: e }, "DELETE falhou");
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2025") {
      return NextResponse.json({ message: "Regra não encontrada." }, { status: 404 });
    }
    return NextResponse.json({ message: "Erro ao excluir regra." }, { status: 500 });
  }
}
