/**
 * Origem do frontend (para `postMessage`, redirects e afins) — SEC-22.
 *
 * Ordem: `NEXT_PUBLIC_APP_URL` / `APP_URL` explícitas → URL do tenant
 * (`https://{slug}.{TENANT_BASE_DOMAIN}`) a partir da org → `null`.
 * Nunca devolve `"*"`: o caller decide o que fazer sem origem.
 */
import { prismaBase } from "@/lib/prisma-base";
import { buildTenantUrl } from "@/lib/tenant-url";

function originOf(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/** Origem configurada por env (sem consultar o banco). */
export function explicitAppOrigin(): string | null {
  return originOf(process.env.NEXT_PUBLIC_APP_URL) ?? originOf(process.env.APP_URL);
}

/** Origem do app para uma org (env explícita ou URL do tenant pelo slug). */
export async function resolveAppOriginForOrg(orgId: string | null): Promise<string | null> {
  const explicit = explicitAppOrigin();
  if (explicit) return explicit;
  if (!orgId) return null;
  try {
    const org = await prismaBase.organization.findUnique({
      where: { id: orgId },
      select: { slug: true },
    });
    if (!org?.slug) return null;
    return originOf(buildTenantUrl(org.slug));
  } catch {
    return null;
  }
}
