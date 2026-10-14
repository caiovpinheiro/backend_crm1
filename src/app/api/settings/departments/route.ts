import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { isBootstrapV2 } from "@/lib/bootstrap-version";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { z } from "zod";
import {
  bumpResponseFamilies,
  RESPONSE_FAMILIES,
  respondWithCachedJson,
} from "@/lib/cache/response-cache";
import { getLogger } from "@/lib/logger";
import { ServerTiming } from "@/lib/server-timing";
import { departmentsSpec, loadDepartments } from "@/services/startup-cache";

const log = getLogger("api/settings/departments");

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#6366f1"),
  icon: z.string().min(1).max(40).default("IconBuilding"),
});

export async function GET(request: Request) {
  const timing = new ServerTiming();
  return withOrgContext(async (session) => {
    timing.add("auth", timing.totalMs());
    // Listagem (id/nome) é necessária no inbox para "Distribuir p/ departamento".
    // Mutações (POST/PATCH) continuam restritas a ADMIN/MANAGER.
    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json(
        { message: "Organização não definida na sessão." },
        { status: 400 },
      );
    }
    // Corpo por papel (MEMBER: só id/nome; ADMIN/MANAGER: com contagens) —
    // cache por org + papel, com ETag/304 (`services/startup-cache.ts`).
    // `x-bootstrap-version: 2`: ADMIN/MANAGER sem `_count.conversations`
    // (vem de `GET /api/me/live`, `departmentCounts`).
    const stable = isBootstrapV2(request);
    const spec = departmentsSpec(session.user, { stable });
    if (spec) return respondWithCachedJson(request, spec, timing);
    const role = session.user.role;
    return NextResponse.json(
      await loadDepartments(orgId, role === "ADMIN" || role === "MANAGER", {
        openCounts: !stable,
      }),
    );
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const role = session.user.role;
    if (role !== "ADMIN") {
      return NextResponse.json(
        { message: "Apenas administradores podem criar departamentos." },
        { status: 403 },
      );
    }
    const body = await request.json();
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", errors: parsed.error.flatten() },
        { status: 400 },
      );
    }
    try {
      const department = await prisma.department.create({
        data: withOrgFromCtx({
          ...parsed.data,
          // Departamento novo já entra na Distribuição Inteligente.
          // O admin desliga no cadastro se quiser fila manual.
          distributionEnabled: true,
        }),
      });
      await bumpResponseFamilies(session.user.organizationId, RESPONSE_FAMILIES.departments);
      await prisma.auditLog.create({
        data: {
          organizationId: session.user.organizationId,
          actorId: session.user.id,
          actorEmail: session.user.email,
          entity: "Department",
          entityId: department.id,
          action: "create",
          after: { name: department.name, color: department.color, icon: department.icon },
        },
      });
      return NextResponse.json(department, { status: 201 });
    } catch (err) {
      log.error({ err }, "[POST /settings/departments] falhou");
      const message =
        err instanceof Error && err.message.includes("does not exist")
          ? "A tabela de departamentos ainda não existe. Aguarde a migração ser aplicada."
          : "Erro ao criar departamento. Tente novamente.";
      return NextResponse.json({ message }, { status: 503 });
    }
  });
}
