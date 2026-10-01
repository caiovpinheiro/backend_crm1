/**
 * Renovação da sessão atual (SV-2) — quando o PRÓPRIO usuário revoga as
 * sessões (troca de senha em `PUT /api/profile`, "sair dos outros
 * dispositivos" em `POST /api/me/sessions/revoke-all`), as outras caem e a
 * que fez o pedido continua.
 *
 * Como
 * ────
 * A sessão é um JWT sem estado: "manter esta" = reemitir o cookie desta
 * sessão com a `sessionVersion` nova. Quem reemite é o próprio NextAuth, no
 * `POST /api/auth/session` (`update()` do `useSession`, `trigger: "update"`):
 *
 *   1. A rota que incrementou a versão chama `issueSessionRenewal` e devolve
 *      na resposta `sessionRenewal: { token, sessionVersion, expiresInSec }`.
 *      O `token` é um nonce aleatório de uso único; aqui fica só o hash
 *      dele, ligado ao `userId` e à versão nova, por 60 s.
 *   2. O cliente chama `update({ sessionRenewal: token })`.
 *   3. O callback `jwt` chama `renewSessionVersion`: lê a versão ATUAL no
 *      banco (sem cache) e só sobe a claim quando, ao mesmo tempo,
 *        - a claim do token é a versão imediatamente anterior;
 *        - o nonce existe, não expirou, não foi usado, é deste usuário e
 *          foi emitido para exatamente a versão atual do banco.
 *
 * O que NÃO renova (e o token cai pela checagem normal de versão):
 *   - `update()` sem prova, ou com prova inventada/expirada/já usada;
 *   - prova de outro usuário;
 *   - token já revogado antes (claim ≤ versão − 2) — mesmo com prova;
 *   - outro incremento depois da emissão (reset administrativo, erase…):
 *     a prova vale só para a versão em que foi emitida;
 *   - banco fora do ar: sem leitura confirmada a claim não sobe.
 * Reset administrativo, "esqueci a senha", erase e exclusão não emitem
 * prova: continuam derrubando tudo.
 *
 * Onde o nonce mora: no Redis do cache (compartilhado entre réplicas, o
 * `update()` pode cair em outra instância); sem Redis, na memória do
 * processo — aí a renovação só funciona se o `update()` cair na mesma
 * réplica, e o pior caso é o comportamento antigo (ir para o login).
 * Consumo atômico (`MULTI GET+DEL`): duas tentativas simultâneas com o
 * mesmo nonce — só uma leva. Toda tentativa de renovação queima o nonce.
 */
import { createHash, randomBytes } from "node:crypto";

import { logAuditAsync } from "@/lib/audit/log";
import { getCacheClient } from "@/lib/cache/redis-client";
import { getLogger } from "@/lib/logger";

import { loadSessionVersion } from "./session-version-check";

const log = getLogger("auth");

export const SESSION_RENEWAL_TTL_MS = 60_000;
/** Campo do corpo do `update()` (e da resposta da rota) que leva a prova. */
export const SESSION_RENEWAL_FIELD = "sessionRenewal";

const KEY_PREFIX = "auth:session-renewal:";
const MAX_MEMORY_ENTRIES = 5_000;
/** 32 bytes em base64url = 43 caracteres; aceita só esse formato. */
const PROOF_RE = /^[A-Za-z0-9_-]{43}$/;

export type SessionRenewalGrant = {
  /** Nonce de uso único — só vai na resposta a quem fez o pedido. */
  token: string;
  /** Versão para a qual a sessão atual pode subir. */
  sessionVersion: number;
  expiresInSec: number;
};

type StoredGrant = { userId: string; version: number };
type MemoryEntry = StoredGrant & { expiresAt: number };

const memory = new Map<string, MemoryEntry>();

function hashProof(proof: string): string {
  return createHash("sha256").update(proof).digest("hex");
}

function encode(grant: StoredGrant): string {
  return `${grant.version}:${grant.userId}`;
}

function decode(raw: string): StoredGrant | null {
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const version = Number(raw.slice(0, sep));
  const userId = raw.slice(sep + 1);
  if (!Number.isInteger(version) || version < 0 || !userId) return null;
  return { userId, version };
}

function memoryPut(hash: string, grant: StoredGrant, now: number): void {
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(key);
  }
  memory.set(hash, { ...grant, expiresAt: now + SESSION_RENEWAL_TTL_MS });
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

function memoryTake(hash: string, now: number): StoredGrant | null {
  const entry = memory.get(hash);
  if (!entry) return null;
  memory.delete(hash);
  if (entry.expiresAt <= now) return null;
  return { userId: entry.userId, version: entry.version };
}

/**
 * Emite a prova para a sessão que acabou de incrementar a própria versão.
 * `tokenVersion` é a claim da sessão que fez o pedido: se ela não era a
 * versão imediatamente anterior a `newVersion`, não há o que renovar e
 * nada é emitido. Nunca lança — sem prova, o cliente vai para o login.
 */
export async function issueSessionRenewal(args: {
  userId: string;
  newVersion: number | null | undefined;
  tokenVersion: number;
}): Promise<SessionRenewalGrant | null> {
  const { userId, newVersion, tokenVersion } = args;
  if (typeof newVersion !== "number" || !Number.isInteger(newVersion)) return null;
  if (newVersion !== tokenVersion + 1) return null;

  const token = randomBytes(32).toString("base64url");
  const hash = hashProof(token);
  const grant: StoredGrant = { userId, version: newVersion };

  let stored = false;
  const client = getCacheClient();
  if (client) {
    try {
      const reply = await client.set(
        KEY_PREFIX + hash,
        encode(grant),
        "PX",
        SESSION_RENEWAL_TTL_MS,
        "NX",
      );
      stored = reply === "OK";
    } catch (err) {
      log.warn({ err, userId }, "[auth] prova de renovação: Redis falhou — usando memória");
    }
  }
  if (!stored) memoryPut(hash, grant, Date.now());

  return {
    token,
    sessionVersion: newVersion,
    expiresInSec: Math.floor(SESSION_RENEWAL_TTL_MS / 1000),
  };
}

/** Consome (apaga) a prova. Atômico no Redis; depois tenta a memória. */
async function takeGrant(proof: string): Promise<StoredGrant | null> {
  const hash = hashProof(proof);
  const client = getCacheClient();
  if (client) {
    try {
      const key = KEY_PREFIX + hash;
      const replies = await client.multi().get(key).del(key).exec();
      const raw = replies?.[0]?.[1];
      const deleted = replies?.[1]?.[1];
      if (typeof raw === "string" && deleted === 1) {
        // Uso único também contra uma eventual cópia local.
        memory.delete(hash);
        return decode(raw);
      }
    } catch (err) {
      log.warn({ err }, "[auth] prova de renovação: leitura no Redis falhou");
    }
  }
  return memoryTake(hash, Date.now());
}

/** Extrai a prova do corpo do `update()`. Qualquer outra coisa = sem prova. */
export function sessionRenewalProofFrom(updateData: unknown): string | null {
  if (typeof updateData !== "object" || updateData === null) return null;
  const value = (updateData as Record<string, unknown>)[SESSION_RENEWAL_FIELD];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Decide se a claim pode subir. Devolve a versão nova, ou `null` quando
 * NÃO renova (o chamador segue para a checagem normal de versão, que
 * derruba o token defasado).
 *
 * Devolve a própria versão atual quando a claim já está nela (o cliente
 * repetiu o `update()` depois de ter dado certo): nada a fazer, e a sessão
 * válida não é derrubada por uma prova já consumida.
 */
export async function renewSessionVersion(args: {
  userId: string;
  organizationId?: string | null;
  tokenVersion: number;
  proof: string;
}): Promise<number | null> {
  const { userId, tokenVersion, proof } = args;

  // Banco, não cache: nas outras réplicas o cache ainda pode estar na
  // versão antiga. Sem leitura confirmada (`null`) a claim não sobe.
  const current = await loadSessionVersion(userId, { fresh: true });
  if (current === null) return null;
  if (tokenVersion === current) return current;

  if (!PROOF_RE.test(proof)) return deny(userId, "malformed");
  const grant = await takeGrant(proof);
  if (!grant) return deny(userId, "unknown_or_used");
  if (grant.userId !== userId) return deny(userId, "other_user");
  if (grant.version !== current) return deny(userId, "version_moved");
  if (tokenVersion !== current - 1) return deny(userId, "token_not_previous");

  log.info(
    { userId, sessionVersion: current },
    "[auth] sessão atual renovada após revogação das demais",
  );
  logAuditAsync({
    entity: "user",
    action: "session_renewed",
    entityId: userId,
    organizationId: args.organizationId ?? null,
    actorId: userId,
    metadata: { sessionVersion: current },
  });
  return current;
}

function deny(userId: string, reason: string): null {
  log.warn({ userId, reason }, "[auth] renovação de sessão recusada");
  return null;
}

/** Só testes. */
export function clearSessionRenewalsForTests(): void {
  memory.clear();
}
