import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { createRole, listRoles } from "@/services/roles";

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

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  permissions: z.array(z.string()).default([]),
  inheritsFrom: z.string().min(1).nullable().optional(),
  sidebarItems: z.array(sidebarItemSchema).max(100).nullable().optional(),
  sharedInbox: z.boolean().optional(),
  mediaAccess: z.boolean().optional(),
  stageGrants: z.array(stageGrantSchema).max(500).nullable().optional(),
  pipelineGrants: z.array(pipelineGrantSchema).max(200).nullable().optional(),
  fieldGrants: z.array(fieldGrantSchema).max(500).nullable().optional(),
});

export async function GET() {
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

    try {
      const roles = await listRoles();
      return NextResponse.json(roles);
    } catch (e) {
      console.error("[GET /api/roles]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao listar roles." },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: Request) {
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

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const parsed = createSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    try {
      const role = await createRole(parsed.data);
      return NextResponse.json(role, { status: 201 });
    } catch (e) {
      console.error("[POST /api/roles]", e);
      const msg = e instanceof Error ? e.message : "Erro ao criar role.";
      const status = msg.includes("Unique constraint") ? 409 : 500;
      return NextResponse.json({ message: msg }, { status });
    }
  });
}
