/**
 * Blocos do `GET /api/me/bootstrap` — o campo `blocks`.
 *
 * ## Contrato
 *
 * ```ts
 * blocks: { [url: BootstrapBlockUrl]: <corpo idêntico ao de GET url> }
 * blockErrors: BootstrapBlockUrl[]
 * ```
 *
 * - A chave é EXATAMENTE a URL (path + query) que o frontend chama hoje ao
 *   abrir uma aba (`BOOTSTRAP_BLOCK_URLS`). O valor é o mesmo JSON que a
 *   rota individual devolveria a este usuário — mesma função de cache
 *   (`services/startup-cache.ts`), mesma entrada no Redis.
 * - URL ausente de `blocks` = o usuário não pode ver (a rota daria 403) ou
 *   não há org (super-admin puro): o frontend chama a rota individual como
 *   antes. URL em `blockErrors` = o bloco falhou: idem.
 * - Exemplo (resumido):
 *
 * ```json
 * {
 *   "version": 1, "user": {...}, "profile": {...}, ..., "failedBlocks": [],
 *   "blocks": {
 *     "/api/team-chat/rooms": { "rooms": [...] },
 *     "/api/pipelines": [{ "id": "p1", "name": "Vendas", "stages": [...] }],
 *     "/api/settings/org?prefix=conversation.": { "conversation.signature": "true" },
 *     "/api/channels": { "channels": [...] },
 *     "/api/users": [{ "id": "u1", "name": "Ana", ... }],
 *     "/api/field-layout?context=deal_panel_v2&forUser=true": { "admin": null, "agent": null }
 *   },
 *   "blockErrors": []
 * }
 * ```
 *
 * Bootstrap v2 (`stable`): `/api/users` e `/api/settings/departments` saem
 * na variante estável — o mesmo corpo que a rota devolve com
 * `x-bootstrap-version: 2` (sem presença/status de agente/contagem de
 * abertas; esses vêm de `GET /api/me/live`).
 *
 * Os blocos não custam consultas novas com o cache quente: cada um é lido do
 * Redis (texto já serializado, sem `JSON.parse`) e entra no corpo por
 * concatenação. Exceção: `/api/team-chat/rooms` é por usuário e muda a cada
 * mensagem — sai da MESMA consulta que o payload base já faz
 * (`teamChatRooms`), sem cache, e entra no ETag pelo hash do corpo.
 *
 * Fora de propósito: `/api/activities/alerts` (o GET marca o alerta como
 * entregue — efeito colateral).
 */
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  computeResponseEtag,
  loadCachedResponse,
  peekResponseEtag,
  responseCacheKey,
  type CachedResponseSpec,
} from "@/lib/cache/response-cache";
import { getLogger } from "@/lib/logger";
import {
  cardExtensionSpec,
  channelsSpec,
  departmentsSpec,
  fieldLayoutSpec,
  orgSettingSpec,
  pipelinesSpec,
  quickReplyGroupsSpec,
  settingsQuickRepliesSpec,
  usersSpec,
  visibilitySpec,
  type StartupCacheUser,
} from "@/services/startup-cache";

const log = getLogger("bootstrap-blocks");

/**
 * URLs exatas que o frontend chama na abertura da aba (inventário do fe #202,
 * 13/10/2026; `/api/settings/departments` medido na DEV em 14/10) e ao abrir
 * `/pipeline?deal=<n>`. Ordem estável — é a ordem das
 * chaves em `blocks` e entra no ETag.
 */
export const BOOTSTRAP_BLOCK_URLS = [
  "/api/team-chat/rooms",
  "/api/pipelines",
  "/api/settings/org?prefix=conversation.",
  "/api/settings/visibility",
  "/api/channels",
  "/api/users",
  "/api/settings/quick-replies",
  "/api/settings/quick-replies/groups",
  "/api/custom-fields/card-extension",
  "/api/field-layout?context=deal_panel_v2&forUser=true",
  // Chamada por toda aba (inbox / `/pipeline?deal=`), sem query string.
  "/api/settings/departments",
] as const;

export type BootstrapBlockUrl = (typeof BOOTSTRAP_BLOCK_URLS)[number];

/** Bloco por usuário, montado da consulta do payload base (sem cache). */
export const TEAM_CHAT_ROOMS_URL = "/api/team-chat/rooms" satisfies BootstrapBlockUrl;

/** Blocos servidos do cache de inicialização. */
type CachedBlockUrl = Exclude<BootstrapBlockUrl, typeof TEAM_CHAT_ROOMS_URL>;

const CACHED_BLOCK_URLS = BOOTSTRAP_BLOCK_URLS.filter(
  (u): u is CachedBlockUrl => u !== TEAM_CHAT_ROOMS_URL,
);

const ORDER = new Map<string, number>(BOOTSTRAP_BLOCK_URLS.map((u, i) => [u, i]));

/** Ordena pela ordem do contrato (chaves de `blocks` e ETag). */
export function inContractOrder<T extends { url: BootstrapBlockUrl }>(items: T[]): T[] {
  return [...items].sort((a, b) => (ORDER.get(a.url) ?? 0) - (ORDER.get(b.url) ?? 0));
}

export type BootstrapBlockEntry = { url: BootstrapBlockUrl; body: string; etag: string };

/**
 * Bloco `/api/team-chat/rooms`: o corpo da rota (`{ rooms }`) a partir da
 * lista completa que o payload base já carregou. ETag = hash do corpo.
 */
export function teamChatRoomsBlock(orgId: string, rooms: unknown[]): BootstrapBlockEntry {
  const body = JSON.stringify({ rooms });
  return { url: TEAM_CHAT_ROOMS_URL, body, etag: computeResponseEtag(orgId, body) };
}

/** Especificação do bloco para o usuário; `null` = rota daria 403 / sem org. */
async function specFor(
  url: CachedBlockUrl,
  user: StartupCacheUser,
  stable: boolean,
): Promise<CachedResponseSpec | null> {
  switch (url) {
    case "/api/pipelines": {
      if (!user.organizationId) return null;
      const denied = await requirePermissionForUser(
        { ...user, organizationId: user.organizationId },
        "pipeline:view",
      );
      if (denied) return null;
      return pipelinesSpec(user);
    }
    case "/api/settings/org?prefix=conversation.":
      // `conversation.` é legível por qualquer papel (MEMBER inclusive).
      return orgSettingSpec(user, { prefix: "conversation." });
    case "/api/settings/visibility":
      return visibilitySpec(user);
    case "/api/channels":
      return channelsSpec(user);
    case "/api/users":
      return usersSpec(user, false, { stable });
    case "/api/settings/quick-replies":
      return settingsQuickRepliesSpec(user);
    case "/api/settings/quick-replies/groups":
      return quickReplyGroupsSpec(user);
    case "/api/custom-fields/card-extension":
      return cardExtensionSpec(user);
    case "/api/field-layout?context=deal_panel_v2&forUser=true":
      return fieldLayoutSpec(user, "deal_panel_v2", true);
    case "/api/settings/departments":
      // A rota só exige org (sem permission); corpo por papel (MEMBER sem
      // contagens), mesma variante da rota.
      return departmentsSpec(user, { stable });
  }
}

export type BootstrapBlockRef = {
  url: CachedBlockUrl;
  spec: CachedResponseSpec;
  key: string;
  /** ETag já guardado para a chave (memória/Redis); `undefined` = frio. */
  knownEtag: string | undefined;
};

/**
 * Resolve chave + ETag guardado de cada bloco — sem ler corpos e sem banco
 * (permissões e versões vêm de cache). Bloco cuja resolução falha fica de
 * fora (o frontend cai na rota individual).
 */
export async function resolveBootstrapBlocks(
  user: StartupCacheUser,
  { stable = false }: { stable?: boolean } = {},
): Promise<BootstrapBlockRef[]> {
  const refs = await Promise.all(
    CACHED_BLOCK_URLS.map(async (url): Promise<BootstrapBlockRef | null> => {
      try {
        const spec = await specFor(url, user, stable);
        if (!spec) return null;
        const key = await responseCacheKey(spec);
        return { url, spec, key, knownEtag: await peekResponseEtag(key, spec.ttlSec) };
      } catch (err) {
        log.warn({ err, url }, "[bootstrap-blocks] bloco não resolvido");
        return null;
      }
    }),
  );
  return refs.filter((r): r is BootstrapBlockRef => r !== null);
}

export type LoadedBootstrapBlocks = {
  entries: BootstrapBlockEntry[];
  errors: BootstrapBlockUrl[];
};

/** Lê (ou carrega no miss) o corpo de cada bloco. Falha vira `errors`. */
export async function loadBootstrapBlocks(
  refs: readonly BootstrapBlockRef[],
): Promise<LoadedBootstrapBlocks> {
  const errors: BootstrapBlockUrl[] = [];
  const loaded = await Promise.all(
    refs.map(async (ref) => {
      try {
        const res = await loadCachedResponse(ref.spec, ref.key);
        return { url: ref.url, body: res.body, etag: res.etag };
      } catch (err) {
        errors.push(ref.url);
        log.error({ err, url: ref.url }, "[bootstrap-blocks] bloco falhou");
        return null;
      }
    }),
  );
  return {
    entries: loaded.filter((e): e is NonNullable<typeof e> => e !== null),
    errors: BOOTSTRAP_BLOCK_URLS.filter((u) => errors.includes(u)),
  };
}

/**
 * Corpo final: o JSON do payload base + `blocks` + `blockErrors`, por
 * concatenação (os corpos dos blocos já são JSON e não são re-serializados).
 */
export function appendBlocksToBootstrapJson(
  baseJson: string,
  blocks: LoadedBootstrapBlocks,
): string {
  if (!baseJson.endsWith("}")) throw new Error("payload do bootstrap não é um objeto JSON");
  const entries = blocks.entries.map((e) => `${JSON.stringify(e.url)}:${e.body}`).join(",");
  const sep = baseJson === "{}" ? "" : ",";
  return `${baseJson.slice(0, -1)}${sep}"blocks":{${entries}},"blockErrors":${JSON.stringify(blocks.errors)}}`;
}
