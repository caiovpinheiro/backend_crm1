import { NextResponse } from "next/server";

import { UserRole } from "@prisma/client";

import { requireAdmin, userOrgFilter } from "@/lib/auth-helpers";
import { invalidateAuthzForUser } from "@/lib/authz";
import { syncUserRoleAssignment } from "@/lib/authz/sync-user-role";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Define a "função primária" de um usuário (tela de Equipe — modelo híbrido).
 *
 * Modelo (decisão 2026-06):
 *   - ADMIN continua sendo o único preset exposto na UI ("Administrador").
 *   - Qualquer outra função é uma Role CUSTOMIZADA criada em /settings/permissions.
 *
 * Comportamento:
 *   - role.systemPreset === "ADMIN"  → User.role = ADMIN + assignment do preset
 *     (via syncUserRoleAssignment, que mantém a compat com o authz legado).
 *   - role customizada               → User.role = MEMBER (baseline não-admin,
 *     pra que checagens legadas tratem como operador) e as assignments do
 *     usuário passam a ser EXATAMENTE essa role (função primária = uma role).
 *
 * NÃO quebra usuários existentes: orgs sem este endpoint (ex.: MAIN/DNA)
 * continuam usando `User.role` legado. A coexistência é garantida pelo
 * fallback em `loadAuthzContext`.
 */
export async function PUT(request: Request, context: RouteContext) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const orgId = r.session.user.organizationId;
    if (!orgId) {
      return NextResponse.json(
        { message: "Operação requer organização ativa." },
        { status: 400 },
      );
    }

    const target = await prisma.user.findFirst({
      where: { id, type: "HUMAN", ...userOrgFilter(r.session) },
      select: { id: true, organizationId: true, role: true },
    });
    if (!target || !target.organizationId) {
      return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const roleId =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).roleId === "string"
        ? ((body as Record<string, unknown>).roleId as string)
        : "";
    if (!roleId) {
      return NextResponse.json({ message: "roleId é obrigatório." }, { status: 400 });
    }

    const role = await prisma.role.findFirst({
      where: { id: roleId, organizationId: target.organizationId },
      select: { id: true, name: true, systemPreset: true },
    });
    if (!role) {
      return NextResponse.json({ message: "Função não encontrada." }, { status: 404 });
    }

    const targetOrgId = target.organizationId;

    // Proteção: não rebaixar o ÚLTIMO admin da org (espelha o guard do DELETE).
    // Demote = era ADMIN e a nova função não é o preset ADMIN.
    const demotingAdmin = target.role === "ADMIN" && role.systemPreset !== "ADMIN";
    if (demotingAdmin) {
      const adminCount = await prisma.user.count({
        where: { type: "HUMAN", role: "ADMIN", organizationId: targetOrgId },
      });
      if (adminCount <= 1) {
        return NextResponse.json(
          { message: "Não é possível remover a função do último administrador da organização." },
          { status: 400 },
        );
      }
    }

    // Caminho PRESET (ADMIN/MANAGER/MEMBER): reaproveita o sync legado, que
    // já sincroniza User.role + assignment do preset de forma idempotente.
    if (
      role.systemPreset === "ADMIN" ||
      role.systemPreset === "MANAGER" ||
      role.systemPreset === "MEMBER"
    ) {
      const preset = role.systemPreset;
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: target.id },
          data: { role: preset as UserRole },
        });
        await syncUserRoleAssignment(tx, {
          userId: target.id,
          organizationId: targetOrgId,
          role: preset,
          assignedById: r.session.user.id,
        });
      });
      await invalidateAuthzForUser(targetOrgId, target.id);
      return NextResponse.json({ ok: true, role: { id: role.id, name: role.name } });
    }

    // Caminho ROLE CUSTOMIZADA: baseline não-admin + função primária única.
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: { role: UserRole.MEMBER },
      });
      await tx.userRoleAssignment.deleteMany({
        where: { userId: target.id, organizationId: targetOrgId },
      });
      await tx.userRoleAssignment.create({
        data: {
          userId: target.id,
          roleId: role.id,
          organizationId: targetOrgId,
          assignedById: r.session.user.id,
        },
      });
    });
    await invalidateAuthzForUser(targetOrgId, target.id);
    return NextResponse.json({ ok: true, role: { id: role.id, name: role.name } });
  } catch (e) {
    console.error("[PUT /api/users/[id]/primary-role]", e);
    return NextResponse.json({ message: "Erro ao definir função." }, { status: 500 });
  }
}
