/**
 * Cache POR USUÁRIO do payload estável do bootstrap (v2).
 *
 * `GET /api/me/bootstrap` com `x-bootstrap-version: 2` devolve só o que é
 * estável (`buildMeBootstrapStable`) + `blocks`. O payload estável é guardado
 * no Redis como texto, com o ETag (hash do corpo, salgado com a org) numa
 * chave pequena ao lado — o mesmo envelope de `lib/cache/response-cache.ts`.
 * Com `If-None-Match` igual, a rota responde 304 lendo só versões e ETags:
 * nenhuma consulta Prisma.
 *
 * ## Chave
 *
 * `cache:resp:me_boot:<org>:v<versões>:<usuário>` — a org e o usuário vão
 * na chave, e o ETag é salgado com a org: usuário A nunca lê a entrada de B,
 * e o mesmo id de usuário em orgs diferentes não colide.
 *
 * ## Versões (invalidação explícita, TTL 10 min de segurança)
 *
 * Família por usuário: `rc_me:<org>:<usuário>` (`bumpMeBootstrap`), sem
 * memória local da versão — o bump vale na outra réplica na próxima leitura.
 * Famílias da org de que o payload depende (`ME_BOOTSTRAP_ORG_FAMILIES`):
 *
 * - `authz`         papéis e permissões da org, menu (sidebar) do papel
 *                   (`invalidateAuthzForOrg`) — memória local ≤ 500 ms;
 * - `org_settings`  config de alertas do inbox (org/depto/usuário), escopo de
 *                   canais (`scopeGrants`) — memória local ≤ 500 ms;
 * - `rc_departments` membros de departamento (`alertConfig.departmentIds`);
 * - `rc_channels`   nomes dos canais liberados (`effectivePermissions.channelGrants`);
 * - `org_summary`   dados da organização (nome, marca, status) — ≤ 500 ms;
 * - `org_widgets`   widgets instalados (`widgets`, `preferences.availableKeys`) — ≤ 500 ms.
 *
 * Pior caso entre réplicas: 500 ms (`CACHE_VERSION_MEMO_MS`), abaixo dos 5 s
 * do requisito. Bump a mais só custa uma remontagem: o ETag é o hash do corpo,
 * então corpo igual dá o mesmo ETag (o cliente ainda recebe 304).
 *
 * Payload com bloco que falhou (`failedBlocks` não vazio) não fica no cache:
 * a próxima chamada tenta de novo.
 */
import {
  computeResponseEtag,
  peekResponseEtag,
  responseVariantFingerprint,
  RESPONSE_CACHE_TTL_SEC,
  type CachedResponse,
} from "@/lib/cache/response-cache";
import { meBootstrapVersionName } from "@/lib/cache/response-families";
import { cache } from "@/lib/cache";
import { cacheVersionName, getCacheVersions } from "@/lib/cache/versions";
import { getLogger } from "@/lib/logger";
import {
  buildMeBootstrapStable,
  type MeBootstrapUser,
} from "@/services/me-bootstrap";

const log = getLogger("me-bootstrap-cache");

/** Famílias de versão da org que entram na chave (ver cabeçalho). */
export const ME_BOOTSTRAP_ORG_FAMILIES = [
  "authz",
  "org_settings",
  "rc_departments",
  "rc_channels",
  "org_summary",
  "org_widgets",
] as const;

const KEY_PREFIX = "resp:me_boot:";
const ETAG_SUFFIX = ":etag";
/** Super-admin sem org ativa: escopo próprio (nenhuma família da org bate). */
const NO_ORG = "_sem_org";

function orgScope(user: MeBootstrapUser): string {
  return user.organizationId ?? NO_ORG;
}

/** Chave da entrada do usuário (lê só versões no Redis; nunca o banco). */
export async function meBootstrapCacheKey(user: MeBootstrapUser): Promise<string> {
  const org = orgScope(user);
  const versions = await getCacheVersions(
    ...ME_BOOTSTRAP_ORG_FAMILIES.map((f) => cacheVersionName(f, org)),
    meBootstrapVersionName(org, user.id),
  );
  // `isSuperAdmin` muda o corpo (permissões "*"): entra na variante.
  const variant = responseVariantFingerprint(
    JSON.stringify({ u: user.id, sa: Boolean(user.isSuperAdmin) }),
  );
  return `${KEY_PREFIX}${org}:v${versions.join(".")}:${variant}`;
}

/** ETag guardado para a chave (memória do processo, senão Redis). */
export function peekMeBootstrapEtag(key: string): Promise<string | undefined> {
  return peekResponseEtag(key, RESPONSE_CACHE_TTL_SEC);
}

function splitEnvelope(text: string): { etag: string; body: string } | null {
  const i = text.indexOf("\n");
  if (i <= 0) return null;
  return { etag: text.slice(0, i), body: text.slice(i + 1) };
}

/**
 * Corpo + ETag do payload estável, montando só no miss (singleflight no
 * processo + lock entre réplicas, via `cache.wrapText`). `onBuild` mede o
 * tempo da montagem (fase `query` do `Server-Timing`).
 */
export async function loadMeBootstrapStable(
  user: MeBootstrapUser,
  key: string,
  onBuild: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): Promise<CachedResponse> {
  const org = orgScope(user);
  let degraded = false;
  const { text, source } = await cache.wrapText(key, RESPONSE_CACHE_TTL_SEC, async () => {
    const payload = await onBuild(() => buildMeBootstrapStable(user));
    degraded = payload.failedBlocks.length > 0;
    const body = JSON.stringify(payload);
    const etag = computeResponseEtag(org, body);
    if (!degraded) await cache.setText(key + ETAG_SUFFIX, etag, RESPONSE_CACHE_TTL_SEC);
    return `${etag}\n${body}`;
  });
  if (degraded) {
    // Falha parcial não fica guardada por 10 min: a próxima chamada remonta.
    await cache.del(key, key + ETAG_SUFFIX);
  }
  const envelope = splitEnvelope(text);
  if (!envelope) {
    log.warn({ key }, "[me-bootstrap-cache] envelope inválido — remontando");
    const body = JSON.stringify(await onBuild(() => buildMeBootstrapStable(user)));
    return { key, etag: computeResponseEtag(org, body), body, source: "miss" };
  }
  return { key, ...envelope, source };
}
