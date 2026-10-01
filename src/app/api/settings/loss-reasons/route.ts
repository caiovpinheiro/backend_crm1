import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  createLossReason,
  listLossReasons,
  reorderLossReasons,
} from "@/services/loss-reasons";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/loss-reasons");

export async function GET() {
  return withOrgContext(async () => {
    try {
      const reasons = await listLossReasons();
      return NextResponse.json(reasons);
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json({ message: "Erro ao listar motivos." }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return withOrgContext(async () => {
    try {
      const body = (await request.json()) as Record<string, unknown>;

      // Reorder: { ids: string[] }
      if (Array.isArray(body.ids)) {
        const ids = body.ids.filter((x): x is string => typeof x === "string");
        await reorderLossReasons(ids);
        return NextResponse.json({ ok: true });
      }

      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label) {
        return NextResponse.json({ message: "Label é obrigatório." }, { status: 400 });
      }
      const reason = await createLossReason(label);
      return NextResponse.json(reason, { status: 201 });
    } catch (e) {
      if (e instanceof Error && e.message === "INVALID_LABEL") {
        return NextResponse.json({ message: "Label é obrigatório." }, { status: 400 });
      }
      log.error({ err: e }, "POST falhou");
      return NextResponse.json({ message: "Erro ao criar motivo." }, { status: 500 });
    }
  });
}
