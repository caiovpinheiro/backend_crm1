import { type NextRequest, NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getAutomationById, getAutomationLogs } from "@/services/automations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations/[id]/logs");

type RouteContext = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

function parseIntParam(v: string | null, fallback: number) {
  if (v === null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Aceita `status`, `statuses` e `logStatus` (CSV ou repetido). */
function parseLogStatuses(searchParams: URLSearchParams): string[] | undefined {
  const raw = [
    ...searchParams.getAll("status"),
    ...searchParams.getAll("statuses"),
    ...searchParams.getAll("logStatus"),
  ].flatMap((v) => v.split(/[,|]/).map((s) => s.trim()).filter(Boolean));
  return raw.length ? raw : undefined;
}

export async function GET(request: NextRequest, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:view");
    if (denied) return denied;
    try {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const automation = await getAutomationById(id);
      if (!automation) {
        return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
      }

      const searchParams = request.nextUrl.searchParams;
      const page = parseIntParam(searchParams.get("page"), 1);
      const perPage = parseIntParam(searchParams.get("perPage"), 20);
      const stepId = searchParams.get("stepId") ?? undefined;
      const statuses = parseLogStatuses(searchParams);

      const result = await getAutomationLogs(id, { page, perPage, stepId, statuses });
      return NextResponse.json(result, {
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json({ message: "Erro ao listar logs da automação." }, { status: 500 });
    }
  });
}
