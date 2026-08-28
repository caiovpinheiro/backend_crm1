import { NextResponse } from "next/server";

import { getClientIp, withRateLimit } from "@/lib/rate-limit";
import { prismaBase } from "@/lib/prisma-base";

/**
 * Identifica a org do e-mail no login do apex (bwipo.com) para
 * redirecionar a senha para `{slug}.bwipo.com`.
 *
 * Não revela se o e-mail existe além de ok/404 genérico.
 * POST /api/auth/tenant-lookup  { email }
 */

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rl = await withRateLimit({
    route: "auth.tenant-lookup",
    profile: "auth.public",
    scope: "ip",
    id: ip,
  });
  if (!rl.ok) return rl.response;

  let email = "";
  try {
    const body = (await request.json()) as { email?: unknown };
    email = String(body?.email ?? "")
      .trim()
      .toLowerCase();
  } catch {
    email = "";
  }

  if (!email.includes("@") || email.length > 320) {
    return NextResponse.json(
      { ok: false as const },
      { status: 400, headers: rl.headers },
    );
  }

  const user = await prismaBase.user.findUnique({
    where: { email },
    select: {
      type: true,
      isSuperAdmin: true,
      organization: { select: { slug: true, status: true } },
    },
  });

  if (!user || user.type === "AI") {
    return NextResponse.json(
      { ok: false as const },
      { status: 404, headers: rl.headers },
    );
  }

  if (user.isSuperAdmin && !user.organization) {
    return NextResponse.json(
      { ok: true as const, slug: null, apex: true as const },
      { status: 200, headers: rl.headers },
    );
  }

  if (!user.organization || user.organization.status !== "ACTIVE") {
    return NextResponse.json(
      { ok: false as const },
      { status: 404, headers: rl.headers },
    );
  }

  return NextResponse.json(
    { ok: true as const, slug: user.organization.slug, apex: false as const },
    { status: 200, headers: rl.headers },
  );
}
