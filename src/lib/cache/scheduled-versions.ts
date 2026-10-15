/**
 * Versão das mensagens agendadas por conversa (gate de carga de produção,
 * 15/10, metas 6/7 — `GET /api/scheduled-messages?conversationId=`).
 *
 * `cache:v:rc_sched:<org>:<conversa>` (ver `versions.ts`; prefixo `rc_` =
 * sem memória local da versão: a outra réplica enxerga o bump na leitura
 * seguinte). O ETag da lista = versão da conversa + `rc_users` (nome e
 * avatar de quem agendou vêm no item) + org. `If-None-Match` igual → 304
 * sem consultar o banco além da checagem de acesso.
 *
 * Escritores (sempre DEPOIS de gravar): criar, cancelar (manual, por
 * resposta do cliente/agente, ao encerrar), o worker que reivindica
 * (PENDING → SENDING, o item sai da lista), devolve (lease vencido), envia
 * e marca falha, e a reatribuição do autor quando um usuário é excluído.
 * Sem Redis disponível a rota não usa ETag (sem 304 com versão só local).
 */
import { createHash } from "node:crypto";

import { getLogger } from "@/lib/logger";

import type { Redis as IORedisClient } from "ioredis";

import { getCacheClient, noteFailure, noteSuccess } from "./redis-client";
import { bumpCacheVersion, cacheVersionName, cacheVersionRedisKey } from "./versions";

const log = getLogger("cache/scheduled-versions");

export const SCHEDULED_VERSION_FAMILY = "rc_sched";
const USERS_FAMILY = "rc_users";
/** Mesmo TTL das versões de `versions.ts` (renovado a cada bump). */
const VERSION_TTL_SEC = 7 * 24 * 60 * 60;

export function scheduledVersionName(orgId: string, conversationId: string): string {
  return cacheVersionName(SCHEDULED_VERSION_FAMILY, orgId, conversationId);
}

/** Invalida a lista de agendadas das conversas (um INCR cada). Nunca lança. */
export async function bumpScheduledMessages(
  orgId: string | null | undefined,
  ...conversationIds: (string | null | undefined)[]
): Promise<void> {
  const ids = [...new Set(conversationIds.filter((id): id is string => Boolean(id)))];
  if (!orgId || ids.length === 0) return;
  try {
    await bumpCacheVersion(...ids.map((id) => scheduledVersionName(orgId, id)));
  } catch (err) {
    log.warn({ err, orgId, conversationIds: ids }, "[sched] bump falhou");
  }
}

/** Versão crua no Redis; ausente = semeia (como `versions.ts`). */
async function readOrSeed(client: IORedisClient, key: string): Promise<string> {
  const current = await client.get(key);
  if (current !== null) return current;
  await client.set(key, String(Date.now()), "EX", VERSION_TTL_SEC, "NX");
  return (await client.get(key)) ?? "";
}

/**
 * ETag da lista da conversa, lido ANTES do banco (versão velha + lista nova
 * só custa um 200 a mais). Lê direto do Redis: com o Redis fora (ou sem
 * Redis) devolve `null` e a rota responde sem ETag — a versão só na
 * memória de um processo não serve para 304 entre réplicas.
 */
export async function scheduledListEtag(
  orgId: string,
  conversationId: string,
): Promise<string | null> {
  const client = getCacheClient();
  if (!client) return null;
  const convKey = cacheVersionRedisKey(scheduledVersionName(orgId, conversationId));
  const usersKey = cacheVersionRedisKey(cacheVersionName(USERS_FAMILY, orgId));
  let conv: string;
  let users: string | null;
  try {
    [conv, users] = await Promise.all([readOrSeed(client, convKey), client.get(usersKey)]);
    noteSuccess();
  } catch (err) {
    noteFailure(err, convKey, "sched-etag");
    return null;
  }
  const hash = createHash("sha1")
    .update(orgId)
    .update("\n")
    .update(conversationId)
    .update("\n")
    .update(`${conv}.${users ?? ""}`)
    .digest("hex")
    .slice(0, 24);
  return `W/"s.${hash}"`;
}
