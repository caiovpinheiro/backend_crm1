import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { deleteRole, getRoleById, updateRole } from "@/services/roles";

type RouteContext = { params: Promise<{ id: string }> };

const sidebarItemSchema = z.object({
  key: z.string().min(1).max(100),
  enabled: z.boolean(),
  order: z.number().int().min(0).max(1000),
});

const stageGrantSchema = z.object({
  stageId: z.string().min(1),
  canView: z.boolean(),
  canEdit: z.boolean(),
});

const pipelineGrantSchema = z.object({
  pipelineId: z.string().min(1),
  canView: z.boolean(),
});

const fieldGrantSchema = z.object({
  entity: z.string().min(1).max(60),
  fieldKey: z.string().min(1).max(120),
  canView: z.boolean(),
  canEdit: z.boolean(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    permissions: z.array(z.string()).optional(),
    inheritsFrom: z.string().min(1).nullable().optional(),
    // `null` ou array vazio remove o override (papel volta ao catalogo padrao).
    sidebarItems: z.array(sidebarItemSchema).max(100).nullable().optional(),
    sharedInbox: z.boolean().optional(),
    mediaAccess: z.boolean().optional(),
    stageGrants: z.array(stageGrantSchema).max(500).nullable().optional(),
    pipelineGrants: z.array(pipelineGrantSchema).max(200).nullable().optional(),
    fieldGrants: z.array(fieldGrantSchema).max(500).nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "Nenhum campo para atualizar.",
  });

export async function GET(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const ctx = await loadAuthzContext({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!can(ctx, "settings:permissions")) {
      return NextResponse.json(
        { message: "Acesso negado.", required: "settings:permissions" },
        { status: 403 },
      );
    }

    const { id } = await context.params;
    try {
      const role = await getRoleById(id);
      if (!role) {
        return NextResponse.json({ message: "Role não encontrado." }, { status: 404 });
      }
      return NextResponse.json(role);
    } catch (e) {
      console.error("[GET /api/roles/[id]]", e);
      return NextResponse.json(
        { message: "Erro ao buscar role." },
        { status: 500 },
      );
    }
  });
}

export async function PUT(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const ctx = await loadAuthzContext({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!can(ctx, "settings:permissions")) {
      return NextResponse.json(
        { message: "Acesso negado.", required: "settings:permissions" },
        { status: 403 },
      );
    }

    const { id } = await context.params;
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const parsed = updateSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    try {
      const role = await updateRole(id, parsed.data);
      if (!role) {
        return NextResponse.json({ message: "Role não encontrado." }, { status: 404 });
      }
      return NextResponse.json(role);
    } catch (e) {
      console.error("[PUT /api/roles/[id]]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao atualizar role." },
        { status: 400 },
      );
    }
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const ctx = await loadAuthzContext({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!can(ctx, "settings:permissions")) {
      return NextResponse.json(
        { message: "Acesso negado.", required: "settings:permissions" },
        { status: 403 },
      );
    }

    const { id } = await context.params;
    try {
      const result = await deleteRole(id);
      if (!result) {
        return NextResponse.json({ message: "Role não encontrado." }, { status: 404 });
      }
      return NextResponse.json(result);
    } catch (e) {
      console.error("[DELETE /api/roles/[id]]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao excluir role." },
        { status: 400 },
      );
    }
  });
}
