/**
 * POST   /api/distribution/leads/participants/[userId]/eligibility
 *        `{ eligible: boolean, until: "HH:MM" }` — libera (true) ou pausa
 *        (false) o consultor no modo leads, a partir de agora até o próximo
 *        `until` em São Paulo (máx. 24 h). Substitui a liberação/pausa vigente.
 * DELETE /api/distribution/leads/participants/[userId]/eligibility
 *        Encerra agora a liberação/pausa vigente (volta à regra do departamento).
 *
 * `distribution:manage` + widget `smart_distribution`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { guardLeadsDepartmentRules } from "@/app/api/distribution/leads/department-rules/_guard";
import { withOrgContext } from "@/lib/auth-helpers";
import {
  endLeadsEligibilityOverride,
  setLeadsEligibilityOverride,
} from "@/services/distribution/leads/eligibility-overrides";

type RouteContext = { params: Promise<{ userId: string }> };

const bodySchema = z.object({
  eligible: z.boolean(),
  until: z.string().min(1).max(5),
});

export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await guardLeadsDepartmentRules(session.user, "distribution:manage");
    if (denied) return denied;
    const { userId } = await context.params;
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Informe se libera ou pausa e o horário de fim (HH:MM)." },
        { status: 400 },
      );
    }
    const result = await setLeadsEligibilityOverride({
      userId,
      eligible: parsed.data.eligible,
      until: parsed.data.until,
      createdById: session.user.id,
    });
    if (!result.ok) {
      return NextResponse.json({ message: result.message }, { status: result.status });
    }
    const o = result.override;
    return NextResponse.json(
      {
        override: {
          userId: o.userId,
          eligible: o.eligible,
          startsAt: o.startsAt.toISOString(),
          endsAt: o.endsAt.toISOString(),
        },
      },
      { status: 201 },
    );
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await guardLeadsDepartmentRules(session.user, "distribution:manage");
    if (denied) return denied;
    const { userId } = await context.params;
    const ended = await endLeadsEligibilityOverride(userId);
    return NextResponse.json({ ok: true, ended });
  });
}
