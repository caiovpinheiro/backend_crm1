import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { requirePipelineScope } from "@/lib/authz/resource-policy";
import { getLogger } from "@/lib/logger";
import { getAllowDuplicateDeals } from "@/services/pipelines";

const log = getLogger("pipeline-duplicate-deals");

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "pipeline:view");
    if (denied) return denied;

    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const scoped = await requirePipelineScope(session.user, "view", id);
    if (scoped) return scoped;

    try {
      const allowDuplicateDeals = await getAllowDuplicateDeals(id);
      if (allowDuplicateDeals === null) {
        return NextResponse.json({ message: "Funil não encontrado." }, { status: 404 });
      }
      return NextResponse.json({ allowDuplicateDeals });
    } catch (err) {
      log.error({ err }, "falha ao ler allowDuplicateDeals");
      return NextResponse.json(
        { message: "Erro ao ler a opção do funil." },
        { status: 500 },
      );
    }
  });
}
