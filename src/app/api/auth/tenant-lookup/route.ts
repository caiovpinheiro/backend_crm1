import { NextResponse } from "next/server";

import { getClientIp, withRateLimit } from "@/lib/rate-limit";
import { prismaBase } from "@/lib/prisma-base";

/**
 * Identifica a(s) org(s) do e-mail no login do apex (bwipo.com) para
 * redirecionar a senha para `{slug}.bwipo.com`.
 *
 * 0 orgs → 404 genérico (não enumerar).
 * 1 org ACTIVE → `slug` (fluxo atual; front redireciona direto).
 * 2+ orgs → `orgs[]` sem `slug` (front mostra o seletor).
 * Super-admin sem org → `apex: true`.
 *
 * Não muda unicidade de e-mail: users existentes continuam 0 ou 1 hit.
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

  const users = await prismaBase.user.findMany({
    where: { email, type: { not: "AI" } },
    select: {
      name: true,
      isSuperAdmin: true,
      organization: { select: { slug: true, name: true, status: true } },
    },
  });

  if (users.length === 0) {
    return NextResponse.json(
      { ok: false as const },
      { status: 404, headers: rl.headers },
    );
  }

  const orgs = users
    .filter((u) => u.organization)
    .map((u) => ({
      slug: u.organization!.slug,
      name: u.organization!.name,
      status: u.organization!.status,
    }));
  const displayName = users[0]?.name ?? null;
  const apexOnly =
    orgs.length === 0 && users.some((u) => u.isSuperAdmin && !u.organization);

  if (apexOnly) {
    return NextResponse.json(
      {
        ok: true as const,
        slug: null,
        apex: true as const,
        orgs: [] as const,
        displayName,
      },
      { status: 200, headers: rl.headers },
    );
  }

  if (orgs.length === 1) {
    if (orgs[0].status !== "ACTIVE") {
      return NextResponse.json(
        { ok: false as const },
        { status: 404, headers: rl.headers },
      );
    }
    return NextResponse.json(
      {
        ok: true as const,
        slug: orgs[0].slug,
        apex: false as const,
        orgs,
        displayName,
      },
      { status: 200, headers: rl.headers },
    );
  }

  if (orgs.length > 1) {
    return NextResponse.json(
      {
        ok: true as const,
        slug: null,
        apex: false as const,
        orgs,
        displayName,
      },
      { status: 200, headers: rl.headers },
    );
  }

  return NextResponse.json(
    { ok: false as const },
    { status: 404, headers: rl.headers },
  );
}
