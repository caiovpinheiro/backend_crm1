import { NextResponse } from "next/server";

import { bumpResponseFamilies, RESPONSE_FAMILIES } from "@/lib/cache/response-families";
import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { assertLeafInDepartment } from "@/services/tabulations";
import { z } from "zod";

const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/, "Horário inválido (use HH:MM).");

const OperatingHoursSchema = z.object({
  start: hhmm,
  end: hhmm,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  icon: z.string().min(1).max(40).optional(),
  requireTabulationOnClose: z.boolean().optional(),
  /** Folha usada no encerramento automático (IA / finish_conversation). */
  autoCloseTabulationId: z.string().min(1).nullable().optional(),
  isSupport: z.boolean().optional(),
  distributionEnabled: z.boolean().optional(),
  operatingHours: OperatingHoursSchema.nullable().optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }
    const { id } = await params;
    const dept = await prisma.department.findFirst({
      where: { id, organizationId: session.user.organizationId! },
    });
    if (!dept)
      return NextResponse.json(
        { message: "Departamento não encontrado." },
        { status: 404 },
      );

    const body = await request.json();
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ message: "Dados inválidos." }, { status: 400 });
    }
    // Manager só edita a janela operacional (cobertura). Demais campos = admin.
    if (role === "MANAGER") {
      const keys = Object.keys(parsed.data);
      if (keys.length === 0 || keys.some((k) => k !== "operatingHours")) {
        return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
      }
    }
    // A tabulação de encerramento automático precisa ser folha DESTE
    // departamento — senão o bot gravaria um motivo de outra árvore.
    if (parsed.data.autoCloseTabulationId) {
      try {
        await assertLeafInDepartment(parsed.data.autoCloseTabulationId, id);
      } catch (e) {
        return NextResponse.json(
          {
            message: (e as Error).message,
            code: (e as { code?: string }).code ?? "TABULATION_INVALID",
          },
          { status: 400 },
        );
      }
    }

    // Apenas um departamento de suporte por org: ao ligar a flag,
    // desliga nos demais.
    if (parsed.data.isSupport === true) {
      await prisma.department.updateMany({
        where: {
          organizationId: session.user.organizationId!,
          isSupport: true,
          id: { not: id },
        },
        data: { isSupport: false },
      });
    }

    const updated = await prisma.department.update({
      where: { id },
      data: parsed.data,
    });
    await prisma.auditLog.create({
      data: {
        organizationId: session.user.organizationId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        entity: "Department",
        entityId: updated.id,
        action: "update",
        before: { name: dept.name, color: dept.color },
        after: { name: updated.name, color: updated.color },
      },
    });
    await bumpResponseFamilies(session.user.organizationId, RESPONSE_FAMILIES.departments);
    return NextResponse.json(updated);
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }
    const { id } = await params;
    const dept = await prisma.department.findFirst({
      where: { id, organizationId: session.user.organizationId! },
      include: {
        _count: { select: { conversations: { where: { status: "OPEN" } } } },
      },
    });
    if (!dept)
      return NextResponse.json(
        { message: "Departamento não encontrado." },
        { status: 404 },
      );

    if (dept._count.conversations > 0) {
      return NextResponse.json(
        {
          message: `Este departamento possui ${dept._count.conversations} conversa(s) ativa(s). Reatribua-as antes de excluir.`,
          code: "HAS_ACTIVE_CONVERSATIONS",
        },
        { status: 409 },
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.department.delete({ where: { id } });

      // Clean up stale allowedDepartmentIds references in AgentPermission.
      // Cannot use FK here because allowedDepartmentIds is a String[] array.
      await tx.$executeRaw`
        UPDATE agent_permissions
        SET "allowedDepartmentIds" = array_remove("allowedDepartmentIds", ${dept.id})
        WHERE ${dept.id} = ANY("allowedDepartmentIds")
          AND "organizationId" = ${session.user.organizationId}
      `;
    });

    await prisma.auditLog.create({
      data: {
        organizationId: session.user.organizationId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        entity: "Department",
        entityId: dept.id,
        action: "delete",
        before: { name: dept.name, color: dept.color },
      },
    });
    await bumpResponseFamilies(session.user.organizationId, RESPONSE_FAMILIES.departments);
    return NextResponse.json({ ok: true });
  });
}
