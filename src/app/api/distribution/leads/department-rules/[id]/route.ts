/**
 * PUT    /api/distribution/leads/department-rules/[id] → { rule }
 * DELETE /api/distribution/leads/department-rules/[id] → { ok: true }
 * Exige `distribution:manage` + widget. Campos parciais no PUT.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { parseLeadsDepartmentRuleInput } from "@/services/distribution/leads/department-rules";
import {
  deleteLeadsDepartmentRule,
  updateLeadsDepartmentRule,
} from "@/services/distribution/leads/department-rules-service";

import { guardLeadsDepartmentRules } from "../_guard";

const log = getLogger("api/distribution/leads/department-rules/[id]");

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await guardLeadsDepartmentRules(session.user, "distribution:manage");
    if (denied) return denied;
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const parsed = parseLeadsDepartmentRuleInput(body, { partial: true });
    if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });
    if (Object.keys(parsed.value).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }
    try {
      const result = await updateLeadsDepartmentRule(id, parsed.value);
      if (result === null) {
        return NextResponse.json({ message: "Regra não encontrada." }, { status: 404 });
      }
      if (result === "DEPARTMENT_NOT_FOUND") {
        return NextResponse.json({ message: "Departamento não encontrado." }, { status: 404 });
      }
      if (result === "SAME_MINUTES") {
        return NextResponse.json(
          { message: "Hora inicial e final não podem ser iguais." },
          { status: 400 },
        );
      }
      return NextResponse.json({ rule: result });
    } catch (e) {
      log.error({ err: e }, "PUT falhou");
      return NextResponse.json({ message: "Erro ao salvar a regra." }, { status: 500 });
    }
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await guardLeadsDepartmentRules(session.user, "distribution:manage");
    if (denied) return denied;
    const { id } = await context.params;
    const removed = await deleteLeadsDepartmentRule(id);
    if (!removed) {
      return NextResponse.json({ message: "Regra não encontrada." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  });
}
