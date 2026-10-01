import { NextResponse } from "next/server";

import { isTrustedTenantOriginSlug } from "@/lib/cors-tenant-origin";
import {
  CORS_LOOKUP_KEY_HEADER,
  deriveCorsLookupKey,
} from "@/lib/cors-tenant-lookup-edge";
import { getLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = getLogger("cors-origin-lookup");

/**
 * GET /api/internal/cors-origin?slug=acme → `{ trusted: boolean }`
 *
 * Rota INTERNA: só o middleware deste mesmo processo chama (loopback),
 * para decidir o CORS de `https://{slug}.{TENANT_BASE_DOMAIN}`. Exige o
 * header `x-crm-internal-key` (HMAC do `AUTH_SECRET`); qualquer outra
 * chamada recebe 404, igual a uma rota inexistente.
 */

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function notFound(): NextResponse {
  return NextResponse.json({ message: "Not found" }, { status: 404 });
}

export async function GET(request: Request) {
  const expected = await deriveCorsLookupKey();
  const provided = request.headers.get(CORS_LOOKUP_KEY_HEADER) ?? "";
  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    return notFound();
  }

  const slug = new URL(request.url).searchParams.get("slug")?.trim().toLowerCase() ?? "";
  try {
    const trusted = await isTrustedTenantOriginSlug(slug);
    return NextResponse.json(
      { trusted },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (err) {
    log.error({ err, slug }, "consulta de origem de tenant falhou");
    return NextResponse.json({ message: "lookup failed" }, { status: 503 });
  }
}
