import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { softDeleteLossReason, updateLossReason } from "@/services/loss-reasons";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/loss-reasons/[id]");

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    try {
      const { id } = await ctx.params;
      const body = (await request.json()) as Record<string, unknown>;
      const updated = await updateLossReason(id, {
        label: typeof body.label === "string" ? body.label : undefined,
        position: typeof body.position === "number" ? body.position : undefined,
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      });
      return NextResponse.json(updated);
    } catch (e) {
      if (e instanceof Error && e.message === "EMPTY_UPDATE") {
        return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
      }
      log.error({ err: e }, "PUT falhou");
      return NextResponse.json({ message: "Erro ao atualizar motivo." }, { status: 500 });
    }
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    try {
      const { id } = await ctx.params;
      await softDeleteLossReason(id);
      return NextResponse.json({ ok: true });
    } catch (e) {
      log.error({ err: e }, "DELETE falhou");
      return NextResponse.json({ message: "Erro ao desativar motivo." }, { status: 500 });
    }
  });
}
