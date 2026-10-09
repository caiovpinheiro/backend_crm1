/**
 * Números de versão das famílias de cache (invalidação O(1), sem SCAN).
 *
 * Antes, invalidar "todas as variantes do board desta org" era um
 * `delPattern` — `SCAN` do keyspace inteiro do Redis, que é compartilhado
 * com BullMQ, SSE e rate limit, a cada mensagem / mudança de status /
 * edição de canal. Agora cada família tem um número guardado em
 * `cache:v:<família>:<org>[:<pipeline>]`; a chave do valor embute esse
 * número (`board:<org>:<pipeline>:v<n>.<m>:<hash>`) e invalidar é um
 * `INCR`. As chaves da versão anterior deixam de ser lidas e somem pelo
 * TTL delas.
 *
 * ## Leitura da versão: memória curtíssima por processo
 *
 * Ler a versão no Redis a cada `get` dobraria as idas ao Redis (a chave do
 * valor depende da versão, então não cabe no mesmo MGET). Cada processo
 * guarda a última versão lida por `CACHE_VERSION_MEMO_MS` (default 500 ms,
 * teto 2 s; 0 = lê sempre). Consequências:
 *
 * - No processo que invalidou, a versão nova vale na hora: o `INCR`
 *   atualiza a memória local e quem lê durante o `INCR` espera por ele.
 * - Nos outros processos, o pior caso é servir a versão anterior por até
 *   `CACHE_VERSION_MEMO_MS` depois do `INCR`. 500 ms fica abaixo do
 *   refetch que o SSE dispara no cliente (~800 ms).
 * - Exceção: a família `board` não tem memória (lê a versão sempre) — ver
 *   `NO_MEMO_FAMILIES`.
 *
 * ## Redis fora
 *
 * A versão vive na memória do processo, com a mesma regra (embutida na
 * chave, `bump` soma 1). Um `bump` feito com o Redis fora fica pendente e
 * é aplicado (`INCRBY`) na primeira leitura depois que ele volta, para o
 * valor antigo que ficou no Redis não ser lido de novo. Entre processos,
 * com o Redis fora, não há propagação — o limite do stale é o TTL do
 * valor, como já era no fallback em memória.
 *
 * ## Por que a versão começa em `Date.now()`
 *
 * Se a chave da versão sumir (TTL de 7 dias sem `bump`, eviction), um
 * contador que recomeçasse do zero poderia repetir um número ainda
 * presente em chaves antigas. Semeando com o relógio, a versão nova é
 * sempre maior que qualquer uma já usada.
 */
import type { Redis as IORedisClient } from "ioredis";

import {
  getCacheClient,
  isCacheRedisDisabled,
  noteFailure,
  noteSuccess,
} from "./redis-client";

const VERSION_KEY_PREFIX = "cache:v:";
/** Renovado a cada `bump`. Expirar equivale a uma invalidação a mais. */
const VERSION_TTL_SEC = 7 * 24 * 60 * 60;
const DEFAULT_MEMO_MS = 500;
const MAX_MEMO_MS = 2_000;
/** Teto dos Maps por processo — evicção do mais antigo inserido. */
const MAX_TRACKED = 10_000;

type Known = {
  value: number;
  /** `Date.now()` da última leitura/escrita — idade da memória local. */
  at: number;
  /** `bumpSeq` do último bump aplicado neste processo (0 = nenhum). */
  bumpedAt: number;
};

/** Última versão conhecida (lida do Redis ou local). */
const known = new Map<string, Known>();
/** Bumps feitos com o Redis fora, ainda não aplicados nele. */
const pendingBumps = new Map<string, number>();
const readsInFlight = new Map<string, Promise<number>>();
const bumpsInFlight = new Map<string, Promise<number>>();
/** Relógio lógico dos bumps: leitura iniciada antes não sobrescreve. */
let bumpSeq = 0;

/** Nome da versão: `<família>:<org>[:<pipeline>]`. */
export function cacheVersionName(family: string, ...scope: string[]): string {
  return [family, ...scope].join(":");
}

/** Chave Redis da versão (`cache:v:<nome>`). */
export function cacheVersionRedisKey(name: string): string {
  return VERSION_KEY_PREFIX + name;
}

/**
 * Famílias sem memória local da versão (E5 / N-BE-9 da auditoria).
 *
 * `board`: com 2 réplicas, quem move um card numa réplica e recarrega o
 * board pela outra podia receber o valor da versão anterior por até
 * 500 ms (a outra réplica ainda lembrava a versão velha) — o card "voltava"
 * até o próximo refetch. Ler a versão sempre custa 1 GET pequeno por versão
 * a cada leitura do board (que já é um GET de até 1 MB e só acontece em
 * carga/refetch da tela), e as leituras simultâneas no processo continuam
 * coalescidas (`readsInFlight`). Escolhido no lugar de pub/sub do bump:
 * não precisa de conexão de subscribe por processo nem trata mensagem
 * perdida — a leitura no Redis é a fonte da verdade.
 *
 * As demais famílias (contadores do Inbox, catálogos, lookups) aceitam o
 * atraso de até `CACHE_VERSION_MEMO_MS` entre réplicas.
 */
const NO_MEMO_FAMILIES: ReadonlySet<string> = new Set(["board"]);

function familyOf(name: string): string {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(0, i);
}

/** Memória local da versão, em ms (`name` decide as famílias sem memo). */
export function cacheVersionMemoMs(name?: string): number {
  if (name !== undefined && NO_MEMO_FAMILIES.has(familyOf(name))) return 0;
  const raw = process.env.CACHE_VERSION_MEMO_MS?.trim();
  if (!raw) return DEFAULT_MEMO_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MEMO_MS;
  return Math.min(Math.floor(n), MAX_MEMO_MS);
}

function capMap<V>(map: Map<string, V>): void {
  if (map.size < MAX_TRACKED) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

function remember(name: string, value: number, bumped: boolean): void {
  const prev = known.get(name);
  if (!prev) capMap(known);
  known.set(name, {
    value,
    at: Date.now(),
    bumpedAt: bumped ? ++bumpSeq : (prev?.bumpedAt ?? 0),
  });
}

function takePending(name: string): number {
  const pending = pendingBumps.get(name) ?? 0;
  if (pending > 0) pendingBumps.delete(name);
  return pending;
}

function addPending(name: string, count: number): void {
  if (count <= 0) return;
  if (!pendingBumps.has(name)) capMap(pendingBumps);
  pendingBumps.set(name, (pendingBumps.get(name) ?? 0) + count);
}

function parseVersion(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Versão na memória do processo (Redis fora ou desligado). */
function localVersion(name: string): number {
  const value = known.get(name)?.value ?? Date.now();
  remember(name, value, false);
  return value;
}

/** Cria a versão no Redis se não existir e devolve a que ficou valendo. */
async function seedInRedis(client: IORedisClient, name: string): Promise<number> {
  const key = cacheVersionRedisKey(name);
  const seed = Date.now();
  const created = await client.set(key, String(seed), "EX", VERSION_TTL_SEC, "NX");
  if (created === "OK") return seed;
  return parseVersion(await client.get(key)) ?? seed;
}

/** `INCRBY` atômico com semente e renovação do TTL — uma ida ao Redis. */
async function incrInRedis(
  client: IORedisClient,
  name: string,
  by: number,
): Promise<number> {
  const key = cacheVersionRedisKey(name);
  const replies = await client
    .multi()
    .set(key, String(Date.now()), "EX", VERSION_TTL_SEC, "NX")
    .incrby(key, by)
    .expire(key, VERSION_TTL_SEC)
    .exec();
  const incr = replies?.[1];
  if (!incr || incr[0]) {
    throw incr?.[0] ?? new Error("[cache] INCRBY da versão sem resposta");
  }
  const value = parseVersion(incr[1]);
  if (value === null) throw new Error("[cache] versão inválida no Redis");
  return value;
}

async function readVersion(name: string): Promise<number> {
  const client = getCacheClient();
  if (!client) return localVersion(name);

  const startedAt = bumpSeq;
  const pending = takePending(name);
  try {
    const value =
      pending > 0
        ? await incrInRedis(client, name, pending)
        : (parseVersion(await client.get(cacheVersionRedisKey(name))) ??
          (await seedInRedis(client, name)));
    noteSuccess();
    // Um bump que terminou depois do início desta leitura tem a versão
    // mais nova: não sobrescrever com a resposta antiga do GET.
    const current = known.get(name);
    if (current && current.bumpedAt > startedAt) return current.value;
    remember(name, value, pending > 0);
    return value;
  } catch (err) {
    addPending(name, pending);
    noteFailure(err, name, "version");
    return localVersion(name);
  }
}

async function versionNumber(name: string): Promise<number> {
  // Invalidação em andamento neste processo: quem lê espera a versão nova.
  const bumping = bumpsInFlight.get(name);
  if (bumping) return bumping;

  const hit = known.get(name);
  if (hit && Date.now() - hit.at < cacheVersionMemoMs(name)) return hit.value;

  const reading = readsInFlight.get(name);
  if (reading) return reading;
  const read = readVersion(name).finally(() => {
    if (readsInFlight.get(name) === read) readsInFlight.delete(name);
  });
  readsInFlight.set(name, read);
  return read;
}

/**
 * Versão atual da família, como texto curto pra embutir na chave.
 * No máximo uma ida ao Redis por `CACHE_VERSION_MEMO_MS` por nome.
 */
export async function getCacheVersion(name: string): Promise<string> {
  return (await versionNumber(name)).toString(36);
}

export async function getCacheVersions(...names: string[]): Promise<string[]> {
  return Promise.all(names.map(getCacheVersion));
}

async function applyBump(name: string): Promise<number> {
  const client = getCacheClient();
  if (client) {
    const pending = takePending(name);
    try {
      const value = await incrInRedis(client, name, pending + 1);
      noteSuccess();
      remember(name, value, true);
      return value;
    } catch (err) {
      addPending(name, pending);
      noteFailure(err, name, "bump");
    }
  }
  // Redis fora: vale na memória deste processo e fica pendente até ele
  // voltar. Sem Redis configurado não há o que reaplicar.
  const value = (known.get(name)?.value ?? Date.now()) + 1;
  if (!isCacheRedisDisabled()) addPending(name, 1);
  remember(name, value, true);
  return value;
}

function bumpOne(name: string): Promise<number> {
  const bump = applyBump(name).finally(() => {
    if (bumpsInFlight.get(name) === bump) bumpsInFlight.delete(name);
  });
  bumpsInFlight.set(name, bump);
  return bump;
}

/**
 * Invalida a família: `INCR` da versão. O(1), sem SCAN. Nunca lança —
 * com o Redis fora o bump vale no processo e é reaplicado depois.
 */
export async function bumpCacheVersion(...names: string[]): Promise<void> {
  await Promise.all([...new Set(names)].map(bumpOne));
}

/** Só para testes: esquece versões, pendências e leituras em andamento. */
export function resetCacheVersionsForTests(): void {
  known.clear();
  pendingBumps.clear();
  readsInFlight.clear();
  bumpsInFlight.clear();
  bumpSeq = 0;
}
