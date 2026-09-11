import { NextResponse } from "next/server";
import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { scheduleProcessPendingDistributionQueue, syncHoursOpenDrainFromDb } from "@/services/distribution";

type Ctx = { params: Promise<{ id: string }> };

// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function GET(_req: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    const { id } = await ctx.params;
    const schedule = await prisma.agentSchedule.findUnique({ where: { userId: id } });

    return NextResponse.json(
      schedule ?? {
        userId: id,
        startTime: "08:00",
        lunchStart: "12:00",
        lunchEnd: "13:00",
        endTime: "18:00",
        timezone: "America/Sao_Paulo",
        weekdays: [1, 2, 3, 4, 5],
      },
    );
  });
}

export async function PUT(req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id } = await ctx.params;
    const body = await req.json();

    const data = {
      startTime: String(body.startTime ?? "08:00"),
      lunchStart: String(body.lunchStart ?? "12:00"),
      lunchEnd: String(body.lunchEnd ?? "13:00"),
      endTime: String(body.endTime ?? "18:00"),
      timezone: String(body.timezone ?? "America/Sao_Paulo"),
      weekdays: Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [1, 2, 3, 4, 5],
    };

    const schedule = await prisma.agentSchedule.upsert({
      where: { userId: id },
      create: withOrgFromCtx({ userId: id, ...data }),
      update: data,
    });

    let participates: boolean | undefined;
    let visibleInCoverage: boolean | undefined;
    const patchParticipates = typeof body.participates === "boolean";
    const patchVisible = typeof body.visibleInCoverage === "boolean";
    if (patchParticipates || patchVisible) {
      const orgId = session.user.organizationId;
      if (orgId) {
        const row = await prisma.distributionResponsible.upsert({
          where: { organizationId_userId: { organizationId: orgId, userId: id } },
          update: {
            ...(patchParticipates ? { participates: body.participates } : {}),
            ...(patchVisible ? { visibleInCoverage: body.visibleInCoverage } : {}),
          },
          create: withOrgFromCtx({
            userId: id,
            participates: patchParticipates ? body.participates : true,
            visibleInCoverage: patchVisible ? body.visibleInCoverage : true,
          }),
        });
        participates = row.participates;
        visibleInCoverage = row.visibleInCoverage;
        if (patchParticipates && body.participates) {
          scheduleProcessPendingDistributionQueue({
            trigger: "agent_eligible",
            delayMs: 300,
            userId: id,
          });
        }
      }
    }

    void syncHoursOpenDrainFromDb();

    return NextResponse.json({ ...schedule, participates, visibleInCoverage });
  });
}
