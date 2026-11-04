/**
 * GET /api/distribution/leads/department-rules/summary
 * Resumo por departamento (membros, ativos, inativos, elegíveis, disponível
 * agora, próxima mudança) + estado da setting. `distribution:view` + widget.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { getLeadsDepartmentRulesSummary } from "@/services/distribution/leads/department-rules-service";

import { guardLeadsDepartmentRules } from "../_guard";

const log = getLogger("distribution.leads.departmentRules");

/** Prisma P2021 = tabela ausente (migration ainda não aplicada neste banco). */
function isMissingTable(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2021";
}

export const dynamic = "force-dynamic";

export async function GET() {
  return withOrgContext(async (session) => {
    const denied = await guardLeadsDepartmentRules(session.user, "distribution:view");
    if (denied) return denied;
    try {
      return NextResponse.json(await getLeadsDepartmentRulesSummary());
    } catch (e) {
      log.error({ err: e }, "Falha ao montar o resumo das regras por departamento");
      const message = isMissingTable(e)
        ? "Tabela de regras por departamento não encontrada. Aplique a migration 20261104120000_distribution_leads_department_rules."
        : `Erro ao carregar os departamentos: ${e instanceof Error ? e.message.split("\n").pop()?.trim() || e.name : String(e)}`;
      return NextResponse.json({ message }, { status: 500 });
    }
  });
}
