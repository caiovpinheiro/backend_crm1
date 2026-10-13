/**
 * Respostas JSON da inicialização do app em cache, com ETag e 304.
 *
 * Contexto (produção, 13/10/2026): cada aba nova reinicia o app e dispara
 * ~35 GETs de dados globais (canais, funis, respostas rápidas, usuários…).
 * O banco fica ocioso; o gargalo é o volume de requisições no Node. Aqui
 * cada uma dessas respostas:
 *
 *   1. é guardada como TEXTO (o corpo exato da rota) no Redis, numa chave
 *      versionada por organização — `resp:<bloco>:<org>:v<versões>:<variante>`;
 *   2. leva um ETag fraco (hash do corpo, salgado com a org) guardado junto
 *      (no envelope do corpo e numa chave pequena `…:etag`, mais uma memória
 *      curta por processo);
 *   3. com `If-None-Match` igual ao ETag guardado sob a chave versionada,
 *      responde 304 SEM ler o corpo, sem serializar e sem tocar no banco.
 *
 * ## Versões (invalidação explícita)
 *
 * A chave embute as versões das famílias de que o corpo depende (ver
 * `versions.ts`: `cache:v:<família>:<org>`). Quem escreve o dado chama
 * `bumpResponseFamilies(org, …)` — um INCR — e a próxima leitura cai numa
 * chave nova: corpo novo, ETag novo. O TTL (10 min) é só a rede de
 * segurança para escritor esquecido. Famílias e escritores: ver
 * `RESPONSE_FAMILIES` em `response-families.ts`.
 *
 * ## Variante (isolamento por perfil)
 *
 * Quando o corpo depende de quem pede (permissões, escopo de funil, papel,
 * o próprio usuário), quem monta a especificação passa em `variant` as
 * ENTRADAS exatas que mudam o corpo (ex.: ids de funil permitidos + negações
 * de etapa). Dois usuários com as mesmas entradas compartilham a entrada;
 * entradas diferentes nunca. A org vai sempre na chave e no sal do ETag:
 * org A nunca lê chave nem casa ETag da org B, mesmo com variante igual.
 *
 * ## Por que o 304 não toca no banco
 *
 * O caminho é: `requireAuth` (JWT + caches de sessão em memória/Redis) →
 * versões (memória do processo por até 500 ms, senão 1 GET no Redis por
 * família) → ETag (memória do processo, senão 1 GET pequeno no Redis).
 * Nenhum `prisma.*`; o teste `response-cache.test.ts` garante isso.
 */
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import type { ServerTiming } from "@/lib/server-timing";

import { cache } from "./index";
import type { ResponseFamily } from "./response-families";
import { cacheVersionName, getCacheVersions } from "./versions";

export { RESPONSE_FAMILIES, bumpResponseFamilies, type ResponseFamily } from "./response-families";

const log = getLogger("cache/response");

/** TTL de segurança: a invalidação é explícita, isto cobre escritor esquecido. */
export const RESPONSE_CACHE_TTL_SEC = 600;

export const RESPONSE_CACHE_CONTROL = "private, no-cache";

const KEY_PREFIX = "resp:";
const ETAG_SUFFIX = ":etag";
const VARIANT_FP_LENGTH = 20;

/** Especificação de uma resposta cacheável (uma rota + uma variante). */
export type CachedResponseSpec = {
  /** Nome curto e estável do bloco (vai na chave e no log). */
  name: string;
  /** Org dona do dado — sempre na chave e no sal do ETag. */
  orgId: string;
  /** Famílias de versão (por org) de que o corpo depende. */
  families: readonly ResponseFamily[];
  /**
   * O que mais muda o corpo além da org: query normalizada, entradas de
   * permissão, id do usuário. Vazio = igual para toda a org.
   */
  variant?: string;
  ttlSec?: number;
  /** Monta o corpo (objeto serializável, igual ao da rota). Só no miss. */
  load: () => Promise<unknown>;
};

export type CachedResponse = {
  key: string;
  etag: string;
  /** Corpo JSON exatamente como a rota devolve. */
  body: string;
  source: "hit" | "miss" | "shared";
};

// ── Memória curta do ETag por processo ─────────────────────────────
//
// A chave é versionada: valor novo = chave nova, então a memória nunca
// serve ETag velho para a versão atual. Expira junto com o TTL do valor.

const ETAG_MEMO_MAX = 5_000;
const etagMemo = new Map<string, { etag: string; expiresAt: number }>();

function rememberEtag(key: string, etag: string, ttlSec: number): void {
  if (!etagMemo.has(key) && etagMemo.size >= ETAG_MEMO_MAX) {
    const oldest = etagMemo.keys().next().value;
    if (oldest !== undefined) etagMemo.delete(oldest);
  }
  etagMemo.set(key, { etag, expiresAt: Date.now() + ttlSec * 1000 });
}

function memoEtag(key: string): string | undefined {
  const hit = etagMemo.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    etagMemo.delete(key);
    return undefined;
  }
  return hit.etag;
}

/** Só para testes. */
export function resetResponseCacheMemoForTests(): void {
  etagMemo.clear();
}

// ── Chaves e ETag ──────────────────────────────────────────────────

export function responseVariantFingerprint(variant: string | undefined): string {
  if (!variant) return "all";
  return createHash("sha1").update(variant).digest("hex").slice(0, VARIANT_FP_LENGTH);
}

/** Lê as versões (memória/Redis) e monta a chave. Nunca consulta o banco. */
export async function responseCacheKey(
  spec: Pick<CachedResponseSpec, "name" | "orgId" | "families" | "variant">,
): Promise<string> {
  const families = [...new Set(spec.families)].sort();
  const versions = await getCacheVersions(
    ...families.map((f) => cacheVersionName(f, spec.orgId)),
  );
  return `${KEY_PREFIX}${spec.name}:${spec.orgId}:v${versions.join(".")}:${responseVariantFingerprint(spec.variant)}`;
}

/**
 * ETag fraco: sha1 do corpo salgado com a org. `W/` porque o proxy pode
 * comprimir a resposta (o corpo transmitido muda, o significado não).
 */
export function computeResponseEtag(orgId: string, body: string): string {
  const hash = createHash("sha1").update(orgId).update("\n").update(body).digest("hex");
  return `W/"${hash.slice(0, 32)}"`;
}

/**
 * `If-None-Match` pode trazer vários valores e o prefixo `W/`. Comparação
 * fraca (RFC 9110 §13.1.2): ignora o `W/`.
 */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strip = (v: string) => v.trim().replace(/^W\//i, "");
  if (ifNoneMatch.trim() === "*") return true;
  const wanted = strip(etag);
  return ifNoneMatch
    .split(",")
    .map(strip)
    .some((v) => v === wanted);
}

/** ETag guardado para a chave (memória do processo, senão Redis). */
export async function peekResponseEtag(key: string, ttlSec = RESPONSE_CACHE_TTL_SEC): Promise<string | undefined> {
  const local = memoEtag(key);
  if (local) return local;
  const stored = await cache.getText(key + ETAG_SUFFIX);
  if (stored) rememberEtag(key, stored, ttlSec);
  return stored;
}

// O corpo é guardado num envelope `<etag>\n<corpo>`: o acerto devolve o
// ETag sem recalcular o hash. O ETag não tem quebra de linha.
function splitEnvelope(text: string): { etag: string; body: string } | null {
  const i = text.indexOf("\n");
  if (i <= 0) return null;
  return { etag: text.slice(0, i), body: text.slice(i + 1) };
}

/**
 * Corpo + ETag da chave (já calculada), rodando `spec.load` só no miss
 * (singleflight no processo + lock entre réplicas, via `cache.wrapText`).
 */
export async function loadCachedResponse(
  spec: CachedResponseSpec,
  key?: string,
): Promise<CachedResponse> {
  const ttlSec = spec.ttlSec ?? RESPONSE_CACHE_TTL_SEC;
  const resolvedKey = key ?? (await responseCacheKey(spec));
  const { text, source } = await cache.wrapText(resolvedKey, ttlSec, async () => {
    const body = JSON.stringify(await spec.load());
    const etag = computeResponseEtag(spec.orgId, body);
    // Chave pequena só com o ETag: o 304 não precisa ler o corpo.
    await cache.setText(resolvedKey + ETAG_SUFFIX, etag, ttlSec);
    return `${etag}\n${body}`;
  });
  const envelope = splitEnvelope(text);
  if (!envelope) {
    // Valor inesperado (não deveria acontecer): recalcula sem cache.
    log.warn({ key: resolvedKey }, "[response-cache] envelope inválido — recarregando");
    const body = JSON.stringify(await spec.load());
    return { key: resolvedKey, etag: computeResponseEtag(spec.orgId, body), body, source: "miss" };
  }
  rememberEtag(resolvedKey, envelope.etag, ttlSec);
  return { key: resolvedKey, ...envelope, source };
}

function cacheHeaders(etag: string, timing?: ServerTiming): Record<string, string> {
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": RESPONSE_CACHE_CONTROL,
  };
  if (timing) headers["Server-Timing"] = timing.header();
  return headers;
}

/** 304 sem corpo, com os mesmos cabeçalhos de cache. */
export function notModifiedResponse(etag: string, timing?: ServerTiming): NextResponse {
  return new NextResponse(null, { status: 304, headers: cacheHeaders(etag, timing) });
}

/** 200 com o corpo já serializado. */
export function cachedJsonResponse(
  body: string,
  etag: string,
  timing?: ServerTiming,
): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/json", ...cacheHeaders(etag, timing) },
  });
}

/**
 * Responde a rota a partir do cache. Chame DEPOIS da autenticação e das
 * checagens de permissão da rota (a especificação já sai da sessão).
 *
 * `Server-Timing`: `cache` (versões + ETag/corpo, `desc` = 304/hit/miss/shared).
 */
export async function respondWithCachedJson(
  request: Request,
  spec: CachedResponseSpec,
  timing?: ServerTiming,
): Promise<NextResponse> {
  const t0 = performance.now();
  const key = await responseCacheKey(spec);
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) {
    const known = await peekResponseEtag(key, spec.ttlSec);
    if (known && etagMatches(ifNoneMatch, known)) {
      timing?.add("cache", performance.now() - t0, "304");
      return notModifiedResponse(known, timing);
    }
  }
  const res = await loadCachedResponse(spec, key);
  timing?.add("cache", performance.now() - t0, res.source);
  if (etagMatches(ifNoneMatch, res.etag)) return notModifiedResponse(res.etag, timing);
  return cachedJsonResponse(res.body, res.etag, timing);
}
