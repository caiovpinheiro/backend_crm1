import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

import { UserRole } from "@prisma/client";

import { requireAdmin, userOrgFilter } from "@/lib/auth-helpers";
import { clearLoginLockout } from "@/lib/auth/lockout";
import { syncUserRoleAssignment } from "@/lib/authz/sync-user-role";
import { prisma } from "@/lib/prisma";
import { disableTelephony } from "@/services/api4com/provisioning";

const MIN_PASSWORD_LENGTH = 6;

type RouteContext = { params: Promise<{ id: string }> };

const ROLES: UserRole[] = [UserRole.ADMIN, UserRole.MANAGER, UserRole.MEMBER];

function isUserRole(v: string): v is UserRole {
  return ROLES.includes(v as UserRole);
}

function isP2025(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025";
}

function isP2002(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
}

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  phone: true,
  avatarUrl: true,
} as const;

/** Trim + "" → null, alinhado com PUT /api/profile. */
function nullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    // Editar qualquer usuário (incluindo trocar role pra ADMIN) é
    // operação privilegiada. Para o usuário editar o próprio perfil
    // existe `/api/me` (não exige admin).
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    // Tenancy (fix 29/mai/26 — IDOR P0): o update abaixo usava `where: { id }`
    // sem escopo de org, entao um admin podia editar (nome/email/role/senha)
    // um usuario de OUTRA organizacao apenas conhecendo o id. Espelha a
    // checagem que o DELETE ja fazia. `userOrgFilter` agora escopa tambem
    // super-admin com org ativa, fechando o vetor cross-org.
    const scopedTarget = await prisma.user.findFirst({
      where: { id, ...userOrgFilter(r.session) },
      select: { id: true },
    });
    if (!scopedTarget) {
      return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
    }

    const b = body as Record<string, unknown>;
    const data: {
      name?: string;
      email?: string;
      role?: UserRole;
      hashedPassword?: string;
      phone?: string | null;
      avatarUrl?: string | null;
    } = {};

    if (b.name !== undefined) {
      if (typeof b.name !== "string" || b.name.trim().length < 1) {
        return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
      }
      data.name = b.name.trim();
    }

    if (b.email !== undefined) {
      if (typeof b.email !== "string" || b.email.trim().length < 1) {
        return NextResponse.json({ message: "E-mail inválido." }, { status: 400 });
      }
      data.email = b.email.trim().toLowerCase();
    }

    if (b.phone !== undefined) {
      if (b.phone !== null && typeof b.phone !== "string") {
        return NextResponse.json({ message: "Telefone inválido." }, { status: 400 });
      }
      if (typeof b.phone === "string" && b.phone.trim().length > 80) {
        return NextResponse.json({ message: "Telefone inválido." }, { status: 400 });
      }
      data.phone = nullableString(b.phone) ?? null;
    }

    if (b.avatarUrl !== undefined) {
      if (b.avatarUrl !== null && typeof b.avatarUrl !== "string") {
        return NextResponse.json({ message: "Avatar inválido." }, { status: 400 });
      }
      if (typeof b.avatarUrl === "string" && b.avatarUrl.trim().length > 2000) {
        return NextResponse.json({ message: "Avatar inválido." }, { status: 400 });
      }
      data.avatarUrl = nullableString(b.avatarUrl) ?? null;
    }

    if (b.role !== undefined) {
      if (typeof b.role !== "string" || !isUserRole(b.role)) {
        return NextResponse.json({ message: "Função inválida." }, { status: 400 });
      }
      data.role = b.role;
    }

    // Troca de senha pelo ADMIN — não exige senha atual (é reset
    // administrativo, não troca via perfil próprio). O /api/profile é
    // quem cuida da troca em self-service e exige `currentPassword`.
    //
    // Agentes de IA (`type=AI`) não têm credencial de login, então
    // recusamos alterar senha pra evitar criar estado inválido.
    if (b.password !== undefined) {
      if (typeof b.password !== "string" || b.password.length < MIN_PASSWORD_LENGTH) {
        return NextResponse.json(
          {
            message: `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
          },
          { status: 400 },
        );
      }
      const target = await prisma.user.findUnique({
        where: { id },
        select: { type: true },
      });
      if (!target) {
        return NextResponse.json(
          { message: "Usuário não encontrado." },
          { status: 404 },
        );
      }
      if (target.type !== "HUMAN") {
        return NextResponse.json(
          { message: "Agentes de IA não possuem senha de acesso." },
          { status: 400 },
        );
      }
      data.hashedPassword = await bcrypt.hash(b.password, 10);
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    try {
      const user = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
          where: { id },
          data,
          select: { ...userSelect, organizationId: true },
        });
        if (data.role && updated.organizationId) {
          await syncUserRoleAssignment(tx, {
            userId: updated.id,
            organizationId: updated.organizationId,
            role: data.role,
            assignedById: r.session.user.id,
          });
        }
        const { organizationId: _omit, ...rest } = updated;
        void _omit;
        return rest;
      });
      if (data.hashedPassword) {
        // Reset administrativo de senha tambem destrava o login: o
        // hard-lock de 24h (login_attempts) nao pode sobreviver a ele,
        // senao o admin troca a senha e o usuario segue bloqueado.
        await clearLoginLockout(user.email);
      }
      return NextResponse.json(user);
    } catch (e) {
      if (isP2025(e)) {
        return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
      }
      if (isP2002(e)) {
        // User.email eh @unique global — colisao pode ser cross-org.
        // Mesmo raciocinio do POST: mensagem que diferencia ajuda o admin
        // a entender por que o email "esta em uso" se ele nao consegue ver.
        if (data.email) {
          const existing = await prisma.user.findFirst({
            where: { email: data.email, id: { not: id } },
            select: {
              organizationId: true,
              organization: { select: { name: true } },
            },
          });
          if (
            existing &&
            existing.organizationId &&
            existing.organizationId !== r.session.user.organizationId
          ) {
            const orgName = existing.organization?.name;
            return NextResponse.json(
              {
                message: orgName
                  ? `E-mail já em uso em outra organização ("${orgName}").`
                  : "E-mail já em uso em outra organização.",
              },
              { status: 409 },
            );
          }
        }
        return NextResponse.json({ message: "E-mail já em uso." }, { status: 409 });
      }
      throw e;
    }
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao atualizar usuário." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const target = await prisma.user.findFirst({
      where: { id, type: "HUMAN", ...userOrgFilter(r.session) },
      select: { id: true, role: true, organizationId: true },
    });
    if (!target) {
      return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
    }
    if (target.id === r.session.user.id) {
      return NextResponse.json({ message: "Você não pode excluir seu próprio usuário." }, { status: 400 });
    }
    if (target.role === "ADMIN") {
      const adminCount = await prisma.user.count({
        where: { type: "HUMAN", role: "ADMIN", ...userOrgFilter(r.session) },
      });
      if (adminCount <= 1) {
        return NextResponse.json(
          { message: "Não é possível excluir o último administrador da organização." },
          { status: 400 },
        );
      }
    }

    if (target.organizationId) {
      const deprov = await disableTelephony(target.id, target.organizationId);
      if (!deprov.success) {
        return NextResponse.json(
          {
            message:
              deprov.error ??
              "Falha ao remover ramal/usuário na API4Comm. Tente novamente antes de excluir o usuário.",
          },
          { status: 500 },
        );
      }
    }

    try {
      const reassignToId = r.session.user.id;
      // Desassocia / reatribui FKs RESTRICT antes do DELETE.
      // Feito fora de interactive transaction longa: updateMany grandes
      // (centenas de notes) + delete com cascades ficam mais estáveis.
      await prisma.deal.updateMany({
        where: { ownerId: target.id },
        data: { ownerId: null },
      });
      await prisma.contact.updateMany({
        where: { assignedToId: target.id },
        data: { assignedToId: null },
      });
      await prisma.conversation.updateMany({
        where: { assignedToId: target.id },
        data: { assignedToId: null },
      });
      await prisma.activity.updateMany({
        where: { userId: target.id },
        data: { userId: null },
      });
      await prisma.activityEvent.updateMany({
        where: { actorUserId: target.id },
        data: { actorUserId: null },
      });
      await prisma.supportTicket.updateMany({
        where: { assignedToId: target.id },
        data: { assignedToId: null },
      });
      await prisma.supportTicketMessage.updateMany({
        where: { authorId: target.id },
        data: { authorId: null },
      });

      // FKs obrigatórias (RESTRICT no Postgres): reatribui ao admin.
      await prisma.note.updateMany({
        where: { userId: target.id },
        data: { userId: reassignToId },
      });
      await prisma.campaign.updateMany({
        where: { createdById: target.id },
        data: { createdById: reassignToId },
      });
      await prisma.scheduledMessage.updateMany({
        where: { createdById: target.id },
        data: { createdById: reassignToId },
      });
      // Tabela legada do catálogo (sem model Prisma ativo) — RESTRICT NOT NULL.
      try {
        await prisma.$executeRaw`
          UPDATE discount_requests
          SET requested_by_id = ${reassignToId}
          WHERE requested_by_id = ${target.id}
        `;
      } catch (rawErr) {
        console.warn("[users.delete] discount_requests reassign skipped", rawErr);
      }

      try {
        await prisma.user.delete({ where: { id: target.id } });
        return NextResponse.json({ ok: true });
      } catch (delErr) {
        // Fallback: se ainda houver FK obscura, anonimiza e esconde da Equipe
        // (mesmo padrão LGPD) em vez de 500 genérico.
        const code =
          typeof delErr === "object" &&
          delErr !== null &&
          "code" in delErr
            ? String((delErr as { code: string }).code)
            : null;
        if (code === "P2003" || code === "P2014") {
          const placeholderEmail = `erased+${target.id}@anon.local`;
          await prisma.user.update({
            where: { id: target.id },
            data: {
              name: "Usuario removido",
              email: placeholderEmail,
              hashedPassword: null,
              phone: null,
              avatarUrl: null,
              signature: null,
              closingMessage: null,
              mfaSecret: null,
              mfaEnabledAt: null,
              isErased: true,
              erasedAt: new Date(),
              role: "MEMBER",
            },
          });
          await prisma.distributionResponsible
            .deleteMany({ where: { userId: target.id } })
            .catch(() => null);
          await prisma.departmentMember
            .deleteMany({ where: { userId: target.id } })
            .catch(() => null);
          await prisma.agentStatus
            .deleteMany({ where: { userId: target.id } })
            .catch(() => null);
          console.warn(
            "[users.delete] hard delete blocked by FK; soft-erased user",
            { userId: target.id, code },
          );
          return NextResponse.json({ ok: true, softDeleted: true });
        }
        throw delErr;
      }
    } catch (e) {
      if (isP2025(e)) {
        return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
      }
      const code =
        typeof e === "object" && e !== null && "code" in e
          ? String((e as { code: string }).code)
          : null;
      if (code === "P2003" || code === "P2014") {
        return NextResponse.json(
          {
            message:
              "Não é possível excluir: ainda existem registros vinculados a este usuário que não podem ser desassociados automaticamente.",
          },
          { status: 409 },
        );
      }
      console.error("[users.delete] failed", e);
      const detail = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { message: `Erro ao excluir usuário: ${detail.slice(0, 300)}` },
        { status: 500 },
      );
    }
  } catch (e) {
    console.error(e);
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { message: `Erro ao excluir usuário: ${detail.slice(0, 300)}` },
      { status: 500 },
    );
  }
}
