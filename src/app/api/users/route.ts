import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

import { requireAdmin, requireAuth, userOrgFilter } from "@/lib/auth-helpers";
import { syncUserRoleAssignment } from "@/lib/authz/sync-user-role";
import { prisma } from "@/lib/prisma";
import { nextUserNumber } from "@/lib/public-id";
import { getSystemPresenceMap } from "@/services/system-presence";

const VALID_ROLES = ["ADMIN", "MANAGER", "MEMBER"] as const;

export async function GET(request: Request) {
  try {
    const r = await requireAuth();
    if (!r.ok) return r.response;

    const includeAi =
      new URL(request.url).searchParams.get("includeAi") === "1" ||
      new URL(request.url).searchParams.get("includeAi") === "true";

    const users = await prisma.user.findMany({
      // Por padrão só humanos (Equipe / filtros). Com ?includeAi=1 inclui
      // agentes IA ativos — usado nos seletores de responsável (1º atendimento).
      // Exclui anonimizados (soft-delete da Equipe / LGPD).
      where: includeAi
        ? {
            ...userOrgFilter(r.session),
            isErased: false,
            OR: [
              { type: "HUMAN" },
              { type: "AI", aiAgentConfig: { active: true } },
            ],
          }
        : { type: "HUMAN", isErased: false, ...userOrgFilter(r.session) },
      orderBy: { name: "asc" },
      select: {
        id: true,
        number: true,
        name: true,
        email: true,
        role: true,
        type: true,
        avatarUrl: true,
        phone: true,
        // Roles RBAC atribuídas (modelo novo). Usado pela tela de Equipe
        // para exibir a "função" como role customizada (mantendo só ADMIN
        // como preset). NÃO substitui `role` legado — coexistem.
        roleAssignments: {
          select: {
            role: { select: { id: true, name: true, systemPreset: true } },
          },
        },
        agentStatus: {
          select: {
            status: true,
            availableForVoiceCalls: true,
            updatedAt: true,
          },
        },
      },
    });

    // Presença de USO (aba do CRM aberta) — SEPARADA de agentStatus.
    // agentStatus continua refletindo apenas a disponibilidade manual
    // da Distribuição. Nunca combinar esses dois conceitos.
    const orgId = r.session.user.organizationId;
    let presence: Awaited<ReturnType<typeof getSystemPresenceMap>> = new Map();
    if (orgId) {
      try {
        presence = await getSystemPresenceMap({
          organizationId: orgId,
          userIds: users.map((u) => u.id),
        });
      } catch {
        // Migration ainda não aplicada / erro transiente: seguimos sem presença.
      }
    }

    // Achata `roleAssignments` em `assignedRoles` (lista limpa pra UI).
    const shaped = users.map((u) => {
      const { roleAssignments, ...rest } = u;
      const p = presence.get(u.id);
      return {
        ...rest,
        assignedRoles: roleAssignments.map((a) => a.role),
        systemOnline: p?.systemOnline ?? false,
        lastSeenAt: p?.lastSeenAt ? p.lastSeenAt.toISOString() : null,
      };
    });

    return NextResponse.json(shaped);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao listar usuários." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const body = await request.json();
    const { name, email, password, role } = body as {
      name?: string;
      email?: string;
      password?: string;
      role?: string;
    };

    if (!name || !email || !password) {
      return NextResponse.json({ message: "Nome, email e senha são obrigatórios." }, { status: 400 });
    }

    // Normalizacao alinhada com PUT /api/users/[id]: trim sempre, e
    // lowercase no email pra que "Email@x" e "email@x" colidam na
    // unique constraint global (em vez de criarem o mesmo user "duas vezes").
    const normalizedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();

    const validRole = role && VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])
      ? (role as (typeof VALID_ROLES)[number])
      : "MEMBER";

    const hashedPassword = await bcrypt.hash(password, 10);

    // Critico: novo user precisa nascer dentro da org de quem criou.
    // Super-admin sem org ainda assim nao pode criar user orfao — bloqueia.
    const orgId = r.session.user.organizationId;
    if (!orgId) {
      return NextResponse.json(
        { message: "Super-admin precisa criar usuario via /admin/organizations." },
        { status: 400 },
      );
    }

    try {
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name: trimmedName,
            email: normalizedEmail,
            hashedPassword,
            role: validRole,
            number: await nextUserNumber(orgId, tx),
            organization: { connect: { id: orgId } },
            emailVerifiedAt: new Date(),
          },
          select: { id: true, name: true, email: true, role: true },
        });
        await syncUserRoleAssignment(tx, {
          userId: created.id,
          organizationId: orgId,
          role: validRole,
          assignedById: r.session.user.id,
        });
        return created;
      });
      return NextResponse.json(user, { status: 201 });
    } catch (e: unknown) {
      const prismaErr = e as { code?: string };
      if (prismaErr.code === "P2002") {
        return NextResponse.json(
          { message: "E-mail já cadastrado nesta organização." },
          { status: 409 },
        );
      }
      throw e;
    }
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao criar usuário." }, { status: 500 });
  }
}
