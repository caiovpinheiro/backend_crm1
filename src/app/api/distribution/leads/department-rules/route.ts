/**
 * GET  /api/distribution/leads/department-rules  → { rules }
 * POST /api/distribution/leads/department-rules  → { rule }
 *
 * Regras de horário por departamento do modo "leads". Só valem no motor com
 * `departmentRulesEnabled` ligado em `/api/distribution/leads/settings`.
 * Corpo: { departmentId, startMinute, endMinute, weekdays[0..6], enabled? }.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { parseLeadsDepartmentRuleInput } from "@/services/distribution/leads/department-rules";
import {
  createLeadsDepartmentRule,
  listLeadsDepartmentRules,
} from "@/services/distribution/leads/department-rules-service";

import { guardLeadsDepartmentRules } from "./_guard";

const log = getLogger("api/distribution/leads/department-rules");

export async function GET() {
  return withOrgContext(async (session) => {
    const denied = await guardLeadsDepartmentRules(session.user, "distribution:view");
    if (denied) return denied;
    return NextResponse.json({ rules: await listLeadsDepartmentRules() });
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await guardLeadsDepartmentRules(session.user, "distribution:manage");
    if (denied) return denied;
    const body = await request.json().catch(() => null);
    const parsed = parseLeadsDepartmentRuleInput(body);
    if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });
    const value = parsed.value;
    try {
      const rule = await createLeadsDepartmentRule({
        departmentId: value.departmentId!,
        startMinute: value.startMinute!,
        endMinute: value.endMinute!,
        weekdays: value.weekdays!,
        enabled: value.enabled ?? true,
      });
      if (!rule) {
        return NextResponse.json({ message: "Departamento não encontrado." }, { status: 404 });
      }
      return NextResponse.json({ rule }, { status: 201 });
    } catch (e) {
      log.error({ err: e }, "POST falhou");
      return NextResponse.json({ message: "Erro ao criar a regra." }, { status: 500 });
    }
  });
}
