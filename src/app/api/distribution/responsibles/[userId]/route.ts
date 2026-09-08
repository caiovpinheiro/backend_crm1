/**
 * PATCH /api/distribution/responsibles/[userId]
 * Atualiza a config administrativa de um responsável (participa, limite de
 * fila, volume, tipo, pausa, pré-almoço) e, opcionalmente, o expediente
 * (`AgentSchedule`). Online/offline NÃO é alterado aqui — isso vai por
 * `PUT /api/agents/[id]/status`. Exige `distribution:manage` e o widget
 * `smart_distribution` ativo.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { scheduleProcessPendingDistributionQueue } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

type RouteContext = { params: Promise<{ userId: string }> };

const hhmm = z
  .string()
  .regex(/^\d{1,2}:\d{2}$/, "Horário inválido (use HH:MM).");

const bodySchema = z
  .object({
    participates: z.boolean().optional(),
    visibleInCoverage: z.boolean().optional(),
    paused: z.boolean().optional(),
    queueLimit: z.number().int().min(0).max(100_000).optional(),
    volume: z.number().int().min(1).max(100_000).optional(),
    type: z.string().trim().max(100).nullable().optional(),
    /** Minutos antes do almoço em que para de receber leads (0–180). */
    preLunchStopMinutes: z.number().int().min(0).max(180).optional(),
    /** Sincroniza os departamentos do responsável (substitui o conjunto). */
    departmentIds: z.array(z.string().min(1)).max(100).optional(),
    /** Upsert parcial do AgentSchedule (almoço / expediente). */
    schedule: z
      .object({
        startTime: hhmm.optional(),
        lunchStart: hhmm.optional(),
        lunchEnd: hhmm.optional(),
        endTime: hhmm.optional(),
        timezone: z.string().min(1).max(64).optional(),
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
        /** Expediente de sábado por consultor. */
        saturdayEnabled: z.boolean().optional(),
        saturdayStart: hhmm.optional(),
        saturdayEnd: hhmm.optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "Nenhum campo para atualizar.",
  });

export async function PATCH(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const ctx = await loadAuthzContext({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!can(ctx, "distribution:manage")) {
      return NextResponse.json(
        { message: "Acesso negado.", required: "distribution:manage" },
        { status: 403 },
      );
    }

    try {
      await assertSmartDistributionEnabled();
    } catch (e) {
      if (e instanceof WidgetNotEnabledError) {
        return NextResponse.json(
          {
            message: "Módulo de Distribuição não habilitado para esta organização.",
            code: "SMART_DISTRIBUTION_NOT_ENABLED",
          },
          { status: 403 },
        );
      }
      throw e;
    }

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
        { message: "Dados inválidos.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const orgId = getOrgIdOrThrow();

    // Garante que o alvo é um operador humano desta organização.
    const target = await prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, type: "HUMAN" },
      select: { id: true },
    });
    if (!target) {
      return NextResponse.json(
        { message: "Usuário não encontrado nesta organização." },
        { status: 404 },
      );
    }

    try {
      const { departmentIds, schedule: schedulePatch, ...respData } = parsed.data;

      // Sincroniza os departamentos do responsável (substitui o conjunto),
      // validando que pertencem à org. Isolado em try para não derrubar a
      // rota caso a tabela `department_members` ainda não exista no ambiente.
      if (departmentIds) {
        try {
          const validDepts = await prisma.department.findMany({
            where: { id: { in: departmentIds }, organizationId: orgId },
            select: { id: true },
          });
          const desired = new Set(validDepts.map((d) => d.id));
          const current = await prisma.departmentMember.findMany({
            where: { userId, organizationId: orgId },
            select: { departmentId: true },
          });
          const currentIds = new Set(current.map((c) => c.departmentId));
          const toAdd = [...desired].filter((id) => !currentIds.has(id));
          const toRemove = [...currentIds].filter((id) => !desired.has(id));
          const savedIds = [...desired];
          await prisma.$transaction([
            ...(toRemove.length
              ? [
                  prisma.departmentMember.deleteMany({
                    where: { userId, organizationId: orgId, departmentId: { in: toRemove } },
                  }),
                ]
              : []),
            ...toAdd.map((departmentId) =>
              prisma.departmentMember.create({
                data: { organizationId: orgId, userId, departmentId },
              }),
            ),
            prisma.agentPermission.upsert({
              where: {
                organizationId_userId: { organizationId: orgId, userId },
              },
              create: {
                organizationId: orgId,
                userId,
                allowedDepartmentIds: savedIds,
              },
              update: { allowedDepartmentIds: savedIds },
            }),
          ]);
        } catch (e) {
          console.error("[PATCH responsibles] falha ao sincronizar departamentos", e);
          return NextResponse.json(
            { message: "Erro ao atualizar departamentos do responsável." },
            { status: 500 },
          );
        }
      }

      let schedule = null as null | {
        startTime: string;
        lunchStart: string;
        lunchEnd: string;
        endTime: string;
        timezone: string;
        weekdays: number[];
        saturdayEnabled: boolean;
        saturdayStart: string;
        saturdayEnd: string;
      };
      if (schedulePatch) {
        const baseSelect = {
          startTime: true,
          lunchStart: true,
          lunchEnd: true,
          endTime: true,
          timezone: true,
          weekdays: true,
        } as const;
        const satSelect = {
          ...baseSelect,
          saturdayEnabled: true,
          saturdayStart: true,
          saturdayEnd: true,
        } as const;

        try {
          const existing = await prisma.agentSchedule.findUnique({
            where: { userId },
            select: satSelect,
          });
          const data = {
            startTime: schedulePatch.startTime ?? existing?.startTime ?? "08:00",
            lunchStart: schedulePatch.lunchStart ?? existing?.lunchStart ?? "12:00",
            lunchEnd: schedulePatch.lunchEnd ?? existing?.lunchEnd ?? "13:00",
            endTime: schedulePatch.endTime ?? existing?.endTime ?? "18:00",
            timezone:
              schedulePatch.timezone ?? existing?.timezone ?? "America/Sao_Paulo",
            weekdays: schedulePatch.weekdays ?? existing?.weekdays ?? [1, 2, 3, 4, 5],
            saturdayEnabled:
              schedulePatch.saturdayEnabled ?? existing?.saturdayEnabled ?? false,
            saturdayStart:
              schedulePatch.saturdayStart ?? existing?.saturdayStart ?? "09:00",
            saturdayEnd:
              schedulePatch.saturdayEnd ?? existing?.saturdayEnd ?? "13:00",
          };
          schedule = await prisma.agentSchedule.upsert({
            where: { userId },
            create: withOrgFromCtx({ userId, ...data }),
            update: data,
            select: satSelect,
          });
        } catch (e) {
          // Fallback: colunas de sábado ainda não migradas neste ambiente
          // (P2022). Salva o expediente sem os campos de sábado para não
          // quebrar a edição do consultor; sábado assume desligado.
          console.warn(
            "[PATCH responsibles] AgentSchedule sem colunas de sábado — " +
              "salvando sem elas (aplique a migration 20260801130000).",
            e,
          );
          const existing = await prisma.agentSchedule.findUnique({
            where: { userId },
            select: baseSelect,
          });
          const data = {
            startTime: schedulePatch.startTime ?? existing?.startTime ?? "08:00",
            lunchStart: schedulePatch.lunchStart ?? existing?.lunchStart ?? "12:00",
            lunchEnd: schedulePatch.lunchEnd ?? existing?.lunchEnd ?? "13:00",
            endTime: schedulePatch.endTime ?? existing?.endTime ?? "18:00",
            timezone:
              schedulePatch.timezone ?? existing?.timezone ?? "America/Sao_Paulo",
            weekdays: schedulePatch.weekdays ?? existing?.weekdays ?? [1, 2, 3, 4, 5],
          };
          const saved = await prisma.agentSchedule.upsert({
            where: { userId },
            create: withOrgFromCtx({ userId, ...data }),
            update: data,
            select: baseSelect,
          });
          schedule = {
            ...saved,
            saturdayEnabled: false,
            saturdayStart: "09:00",
            saturdayEnd: "13:00",
          };
        }
      }

      // Só faz upsert da config quando houver campo de config no corpo.
      let responsible = null as null | {
        userId: string;
        participates: boolean;
        visibleInCoverage: boolean;
        queueLimit: number;
        volume: number;
        type: string | null;
        paused: boolean;
        preLunchStopMinutes: number;
        lastExecutionAt: Date | null;
      };

      const prev =
        Object.keys(respData).length > 0 || departmentIds || schedulePatch
          ? await prisma.distributionResponsible.findUnique({
              where: {
                organizationId_userId: { organizationId: orgId, userId },
              },
              select: {
                participates: true,
                paused: true,
                queueLimit: true,
              },
            })
          : null;

      if (Object.keys(respData).length > 0) {
        responsible = await prisma.distributionResponsible.upsert({
          where: {
            organizationId_userId: { organizationId: orgId, userId },
          },
          update: respData,
          create: { organizationId: orgId, userId, ...respData },
          select: {
            userId: true,
            participates: true,
            visibleInCoverage: true,
            queueLimit: true,
            volume: true,
            type: true,
            paused: true,
            preLunchStopMinutes: true,
            lastExecutionAt: true,
          },
        });
      }

      // Voltou a ficar elegível (despausa / passa a participar / sobe limite /
      // ganha departamento / muda expediente) → drena a fila de espera.
      const becameEligible =
        (typeof respData.paused === "boolean" &&
          respData.paused === false &&
          prev?.paused !== false) ||
        (typeof respData.participates === "boolean" &&
          respData.participates === true &&
          prev?.participates !== true) ||
        (typeof respData.queueLimit === "number" &&
          respData.queueLimit > (prev?.queueLimit ?? 0)) ||
        Boolean(departmentIds) ||
        Boolean(schedulePatch);
      if (becameEligible) {
        scheduleProcessPendingDistributionQueue({
          trigger: "agent_eligible",
          delayMs: 300,
          userId,
        });
      }

      return NextResponse.json({
        responsible: responsible
          ? {
              ...responsible,
              lastExecutionAt: responsible.lastExecutionAt
                ? responsible.lastExecutionAt.toISOString()
                : null,
            }
          : null,
        schedule,
      });
    } catch (e) {
      console.error("[PATCH /api/distribution/responsibles/[userId]]", e);
      return NextResponse.json(
        { message: "Erro ao atualizar responsável." },
        { status: 500 },
      );
    }
  });
}
