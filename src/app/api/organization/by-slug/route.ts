import { NextResponse } from "next/server";

import { cache } from "@/lib/cache";
import { getClientIp, withRateLimit } from "@/lib/rate-limit";
import { prismaBase } from "@/lib/prisma-base";

/**
 * Lookup público leve: o middleware FE valida se o subdomain Host
 * corresponde a uma Organization ACTIVE antes de deixar o app carregar.
 *
 * Não exige sessão. Payload mínimo (slug + name) — sem ids internos
 * nem dados sensíveis. Rate-limit por IP (`auth.public`).
 *
 * GET /api/organization/by-slug?slug=acme
 */

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Cache curto (60s) da resposta positiva "org existe e está ACTIVE".
 * Clientes sem cookie de tenant (app mobile/WebView, scripts) chamavam
 * esta rota em TODA request — storm de 28/ago/26. Só cacheamos sucesso:
 * slug inexistente segue consultando o banco (signup de org nova não
 * pode herdar um 404 cacheado). Suspensão de org leva até 60s para
 * refletir aqui — trade-off aceito (suspensão nunca é urgente ao segundo).
 */
const ORG_CACHE_TTL_SEC = 60;
type ActiveOrgBySlug = { slug: string; name: string };

export async function GET(request: Request) {
  const ip = getClientIp(request);
  const rl = await withRateLimit({
    route: "organization.by-slug",
    profile: "auth.public",
    scope: "ip",
    id: ip,
  });
  if (!rl.ok) return rl.response;

  const slug = new URL(request.url).searchParams.get("slug")?.trim().toLowerCase() ?? "";
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json(
      { message: "Slug inválido.", code: "INVALID_SLUG" },
      { status: 400, headers: rl.headers },
    );
  }

  const cacheKey = `org_active_slug:${slug}`;
  let org = await cache.get<ActiveOrgBySlug>(cacheKey);
  if (org === undefined) {
    const row = await prismaBase.organization.findUnique({
      where: { slug },
      select: { slug: true, name: true, status: true },
    });
    if (row && row.status === "ACTIVE") {
      org = { slug: row.slug, name: row.name };
      await cache.set(cacheKey, org, ORG_CACHE_TTL_SEC);
    }
  }

  if (!org) {
    return NextResponse.json(
      { message: "Organização não encontrada.", code: "ORG_NOT_FOUND" },
      { status: 404, headers: rl.headers },
    );
  }

  return NextResponse.json(
    { ok: true as const, slug: org.slug, name: org.name },
    { status: 200, headers: rl.headers },
  );
}
