/**
 * Lado Node da consulta "este subdomínio de organização é origem confiável
 * no CORS?" (ver `browser-api-cors.ts`).
 *
 * Confiável = a org existe, está ACTIVE e tem ao menos um usuário com
 * e-mail verificado. O signup self-service (`signupOrganizationWithAdmin`)
 * cria a org ACTIVE com o admin de `emailVerifiedAt` nulo: enquanto ele não
 * confirma o código, o subdomínio não ganha CORS com credenciais. Usuários
 * anteriores à verificação de e-mail foram marcados como verificados na
 * migration `20260901010000_auth_email_tokens`; convite aceito e usuário
 * criado pelo admin já nascem verificados.
 *
 * Cache (Redis, com fallback em memória de `lib/cache`): positivo 60 s,
 * negativo 30 s, chave com versão por slug — quem muda a resposta chama
 * `invalidateCorsTenantOrigin`. Erro de banco não é cacheado e propaga
 * (o chamador nega a origem).
 */
import { cache } from "@/lib/cache";
import { corsTenantOriginKey } from "@/lib/cache/keys";
import { prismaBase } from "@/lib/prisma-base";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const TRUSTED_TTL_SEC = 60;
const UNTRUSTED_TTL_SEC = 30;

type Cached = { trusted: boolean };

export async function isTrustedTenantOriginSlug(slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) return false;

  const key = await corsTenantOriginKey(slug);
  const hit = await cache.get<Cached>(key);
  if (hit && typeof hit.trusted === "boolean") return hit.trusted;

  const row = await prismaBase.organization.findFirst({
    where: {
      slug,
      status: "ACTIVE",
      users: { some: { emailVerifiedAt: { not: null } } },
    },
    select: { id: true },
  });
  const trusted = Boolean(row);
  await cache.set<Cached>(
    key,
    { trusted },
    trusted ? TRUSTED_TTL_SEC : UNTRUSTED_TTL_SEC,
  );
  return trusted;
}
