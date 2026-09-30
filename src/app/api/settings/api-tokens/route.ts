import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/authz";
import { generateToken, listTokens } from "@/services/api-tokens";

type TokenSessionUser = {
  id: string;
  organizationId: string;
  isSuperAdmin: boolean;
};

/**
 * SEC-18: sessão + permissão `api_token:manage` (ADMIN por padrão via `*`).
 * Antes qualquer usuário logado criava token que herdava o papel completo.
 */
async function requireTokenManager(): Promise<
  { ok: true; user: TokenSessionUser } | { ok: false; response: NextResponse }
> {
  const session = await auth();
  const user = session?.user as
    | { id?: string; organizationId?: string | null; isSuperAdmin?: boolean }
    | undefined;
  if (!user?.id || !user.organizationId) {
    return {
      ok: false,
      response: NextResponse.json({ message: "Não autorizado." }, { status: 401 }),
    };
  }
  const denied = await requirePermission(
    { id: user.id, organizationId: user.organizationId, isSuperAdmin: Boolean(user.isSuperAdmin) },
    "api_token:manage",
  );
  if (denied) return { ok: false, response: denied };
  return {
    ok: true,
    user: {
      id: user.id,
      organizationId: user.organizationId,
      isSuperAdmin: Boolean(user.isSuperAdmin),
    },
  };
}

export async function GET() {
  try {
    const r = await requireTokenManager();
    if (!r.ok) return r.response;
    const user = r.user;

    const tokens = await listTokens(user.id, user.organizationId);
    return NextResponse.json(tokens);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao listar tokens." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const r = await requireTokenManager();
    if (!r.ok) return r.response;
    const user = r.user;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const b = body as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) {
      return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
    }

    // `expiresAt` ausente/inválido → o serviço aplica o default de 90 dias.
    let expiresAt: Date | null = null;
    if (typeof b.expiresAt === "string" && b.expiresAt.trim()) {
      const d = new Date(b.expiresAt);
      if (Number.isNaN(d.getTime()) || d <= new Date()) {
        return NextResponse.json(
          { message: "expiresAt inválido: informe uma data futura (ISO 8601)." },
          { status: 400 },
        );
      }
      expiresAt = d;
    }

    const result = await generateToken(
      user.id,
      user.organizationId,
      name,
      expiresAt,
    );

    return NextResponse.json(
      {
        id: result.id,
        token: result.token,
        prefix: result.prefix,
        expiresAt: result.expiresAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao criar token." }, { status: 500 });
  }
}
