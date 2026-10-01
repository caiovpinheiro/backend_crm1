import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  addDepartmentMember,
  listDepartmentMembers,
  removeDepartmentMember,
  setDepartmentMembers,
} from "@/services/department-members";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/departments/[id]/members");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Membros de um departamento (associação organizacional N:N).
 *   GET    → lista membros (ADMIN/MANAGER)
 *   PUT    → substitui o conjunto de membros ({ userIds }) (ADMIN)
 *   POST   → adiciona um membro ({ userId }) (ADMIN)
 *   DELETE → remove um membro (?userId=) (ADMIN)
 */

export async function GET(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }
    const { id } = await context.params;
    try {
      const members = await listDepartmentMembers(id);
      return NextResponse.json(members);
    } catch {
      // Tabela ainda não existe (migração pendente) → lista vazia.
      return NextResponse.json([]);
    }
  });
}

const PutSchema = z.object({ userIds: z.array(z.string().min(1)).max(500) });

export async function PUT(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ message: "Apenas administradores." }, { status: 403 });
    }
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const parsed = PutSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ message: "Dados inválidos." }, { status: 400 });
    }
    try {
      const members = await setDepartmentMembers(id, parsed.data.userIds);
      if (!members) {
        return NextResponse.json({ message: "Departamento não encontrado." }, { status: 404 });
      }
      return NextResponse.json(members);
    } catch (e) {
      log.error({ err: e }, "[PUT /settings/departments/[id]/members]");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao salvar membros." },
        { status: 400 },
      );
    }
  });
}

const PostSchema = z.object({ userId: z.string().min(1) });

export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ message: "Apenas administradores." }, { status: 403 });
    }
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ message: "Dados inválidos." }, { status: 400 });
    }
    try {
      const members = await addDepartmentMember(id, parsed.data.userId);
      if (!members) {
        return NextResponse.json({ message: "Departamento não encontrado." }, { status: 404 });
      }
      return NextResponse.json(members, { status: 201 });
    } catch (e) {
      log.error({ err: e }, "[POST /settings/departments/[id]/members]");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao adicionar membro." },
        { status: 400 },
      );
    }
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ message: "Apenas administradores." }, { status: 403 });
    }
    const { id } = await context.params;
    const userId = new URL(request.url).searchParams.get("userId")?.trim();
    if (!userId) {
      return NextResponse.json({ message: "userId é obrigatório." }, { status: 400 });
    }
    const result = await removeDepartmentMember(id, userId);
    if (!result) {
      return NextResponse.json({ message: "Membro não encontrado." }, { status: 404 });
    }
    return NextResponse.json(result);
  });
}
