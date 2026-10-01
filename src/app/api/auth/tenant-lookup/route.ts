import { NextResponse } from "next/server";

import { isTenantLookupStrict } from "@/lib/auth/tenant-lookup-mode";
import { waitForMinResponseTime } from "@/lib/auth/uniform-response";
import { prismaBase } from "@/lib/prisma-base";
import { getClientIp, hashRateLimitId, withRateLimit } from "@/lib/rate-limit";

/**
 * Descobre o subdomínio da empresa pelo e-mail, para o login do apex
 * (bwipo.com) redirecionar a senha para `{slug}.bwipo.com`.
 *
 * POST /api/auth/tenant-lookup  { email }
 *
 *   0 orgs ativas          → 404 `{ ok: false }`
 *   1 org ativa            → `{ ok: true, slug, apex: false, orgs: [org] }`
 *   2+ orgs ativas         → `{ ok: true, slug: null, apex: false, orgs }`
 *   super-admin sem org    → `{ ok: true, slug: null, apex: true, orgs: [] }`
 *   limite estourado       → 429 `{ ok: false, error: "rate_limit_exceeded" }`
 *
 * Superfície reduzida (pentest out/2026 — enumeração e-mail → empresa):
 *  - nada do titular (`displayName`) nem da empresa além do `slug`: o nome
 *    comercial e o status saíram; orgs não ativas não são listadas;
 *  - limite por IP (10/min + 120/h) E por e-mail (10/10 min), ambos
 *    consumidos antes do banco e iguais para e-mail cadastrado ou não,
 *    com 429 idêntico (não diz qual limite estourou);
 *  - piso de latência (`AUTH_MIN_RESPONSE_MS`): existente × inexistente
 *    respondem no mesmo tempo.
 *
 * A distinção 200/404 é inerente a este fluxo. `TENANT_LOOKUP_STRICT=true`
 * a elimina (resposta sempre idêntica) — ver `tenant-lookup-mode.ts`.
 */

/**
 * Compatibilidade com frontends anteriores a esta mudança: o seletor de
 * empresa lê `name` (rótulo) e bloqueia o item quando `status !== "ACTIVE"`.
 * Os dois campos seguem na resposta SEM informação nova — `name` repete o
 * slug e `status` é constante (só orgs ativas são listadas). Remover quando
 * o frontend que usa só `slug` estiver em produção.
 */
type LookupOrg = { slug: string; name: string; status: "ACTIVE" };

function toLookupOrg(slug: string): LookupOrg {
  return { slug, name: slug, status: "ACTIVE" };
}

const NOT_FOUND = { ok: false as const };

function tooManyRequests(retryAfter: string | undefined): Response {
  return NextResponse.json(
    {
      ok: false as const,
      error: "rate_limit_exceeded",
      message: "Muitas tentativas. Tente novamente em alguns minutos.",
    },
    { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} },
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const ip = getClientIp(request);

  const rl = await withRateLimit({
    route: "auth.tenant-lookup",
    profile: "auth.public",
    scope: "ip",
    id: ip,
  });
  if (!rl.ok) return tooManyRequests(rl.headers["Retry-After"]);
  const rlHourly = await withRateLimit({
    route: "auth.tenant-lookup",
    profile: "auth.lookup.hourly",
    scope: "ip",
    id: ip,
  });
  if (!rlHourly.ok) return tooManyRequests(rlHourly.headers["Retry-After"]);

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
    return NextResponse.json(NOT_FOUND, { status: 400 });
  }

  // Por e-mail: mesmo consumo para cadastrado ou não (antes do banco).
  const rlEmail = await withRateLimit({
    route: "auth.tenant-lookup",
    profile: "auth.lookup.email",
    scope: "email",
    id: hashRateLimitId(email),
  });
  if (!rlEmail.ok) return tooManyRequests(rlEmail.headers["Retry-After"]);

  if (isTenantLookupStrict()) {
    await waitForMinResponseTime(startedAt);
    return NextResponse.json(
      { ok: true as const, slug: null, apex: true as const, orgs: [] },
      { status: 200 },
    );
  }

  const users = await prismaBase.user.findMany({
    where: { email, type: { not: "AI" } },
    select: {
      isSuperAdmin: true,
      organization: { select: { slug: true, status: true } },
    },
  });

  const orgs = users
    .filter((u) => u.organization?.status === "ACTIVE")
    .map((u) => toLookupOrg(u.organization!.slug));
  const apexOnly =
    users.some((u) => u.isSuperAdmin && !u.organization) &&
    users.every((u) => !u.organization);

  await waitForMinResponseTime(startedAt);

  if (apexOnly) {
    return NextResponse.json(
      { ok: true as const, slug: null, apex: true as const, orgs: [] },
      { status: 200 },
    );
  }
  if (orgs.length === 0) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }
  return NextResponse.json(
    {
      ok: true as const,
      slug: orgs.length === 1 ? orgs[0].slug : null,
      apex: false as const,
      orgs,
    },
    { status: 200 },
  );
}
