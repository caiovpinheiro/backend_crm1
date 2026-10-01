import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations/[id]/stats");

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:view");
    if (denied) return denied;
    try {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const automation = await prisma.automation.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!automation) {
        return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
      }

      // Trigger-level stats (logs without stepId = automation-level events)
      const triggerStats = await prisma.automationLog.groupBy({
        by: ["status"],
        where: { automationId: id, stepId: null },
        _count: { id: true },
      });

      const trigger: Record<string, number> = {};
      for (const row of triggerStats) {
        trigger[row.status] = row._count.id;
      }

      // Step-level stats
      const stepStats = await prisma.automationLog.groupBy({
        by: ["stepId", "stepType", "status"],
        where: { automationId: id, stepId: { not: null } },
        _count: { id: true },
      });

      const steps: Record<string, { stepType: string; success: number; failed: number; skipped: number }> = {};
      for (const row of stepStats) {
        const sid = row.stepId!;
        if (!steps[sid]) {
          steps[sid] = { stepType: row.stepType ?? "", success: 0, failed: 0, skipped: 0 };
        }
        if (row.status === "SUCCESS") steps[sid].success += row._count.id;
        else if (row.status === "FAILED" || row.status === "FAILED_HANDLED")
          steps[sid].failed += row._count.id;
        else if (row.status === "SKIPPED") steps[sid].skipped += row._count.id;
      }

      // Recent errors for quick diagnosis (inclui falhas com fallback conectado)
      const recentErrors = await prisma.automationLog.findMany({
        where: { automationId: id, status: { in: ["FAILED", "FAILED_HANDLED"] } },
        orderBy: { executedAt: "desc" },
        take: 10,
        select: {
          id: true,
          stepId: true,
          stepType: true,
          status: true,
          message: true,
          contactId: true,
          executedAt: true,
        },
      });

      return NextResponse.json({ trigger, steps, recentErrors });
    } catch (e) {
      log.error({ err: e }, "Error fetching automation stats");
      return NextResponse.json({ message: "Erro ao buscar estatísticas." }, { status: 500 });
    }
  });
}
