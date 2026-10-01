/**
 * CORS do browser para rotas Node que montam a própria `Response` (SSE,
 * storage). Mesma política do middleware (`browser-api-cors.ts`), com a
 * consulta de tenant direto no cache/banco — sem o loopback do Edge.
 */
import {
  resolveBrowserApiCorsOrigin,
  writeBrowserApiCorsHeaders,
} from "@/lib/browser-api-cors";
import { isTrustedTenantOriginSlug } from "@/lib/cors-tenant-origin";

export async function applyBrowserApiCors(
  request: { headers: Headers; url: string },
  res: { headers: Headers },
): Promise<void> {
  let pathname = "/api/";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    /* URL relativa/ inválida — vale a política padrão de /api */
  }
  const allowed = await resolveBrowserApiCorsOrigin(
    request.headers.get("origin"),
    pathname,
    isTrustedTenantOriginSlug,
  );
  writeBrowserApiCorsHeaders(request, res, allowed);
}
