import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

import { requireAdmin, requireAuth } from "@/lib/auth-helpers";
import { syncUserRoleAssignment } from "@/lib/authz/sync-user-role";
import { prisma } from "@/lib/prisma";
import { nextUserNumber } from "@/lib/public-id";
import { bumpResponseFamilies, RESPONSE_FAMILIES, respondWithCachedJson } from "@/lib/cache/response-cache";
import { getLogger } from "@/lib/logger";
import { loadUsersList, usersSpec } from "@/services/startup-cache";

const log = getLogger("api/users");

const VALID_ROLES = ["ADMIN", "MANAGER", "MEMBER"] as const;

export async function GET(request: Request) {
  try {
    const r = await requireAuth();
    if (!r.ok) return r.response;

    const includeAi =
      new URL(request.url).searchParams.get("includeAi") === "1" ||
      new URL(request.url).searchParams.get("includeAi") === "true";

    // Cache por org + variante (ETag/304), TTL 60 s por causa da presença.
    const spec = usersSpec(r.session.user, includeAi);
    if (spec) return await respondWithCachedJson(request, spec);
    return NextResponse.json(await loadUsersList(r.session.user, includeAi));
  } catch (e) {
    log.error({ err: e }, "GET falhou");
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
      await bumpResponseFamilies(orgId, RESPONSE_FAMILIES.users);
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
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao criar usuário." }, { status: 500 });
  }
}
