/**
 * Limite do ping de presença (`POST /api/agents/me/ping`): no máximo 1 a
 * cada `PRESENCE_PING_MIN_INTERVAL_MS` (20 s) por usuário e aba.
 *
 * Aba = header `x-tab-id` (o frontend manda um id por aba); sem header (ou
 * com valor fora do formato), o limite vale por usuário. Em produção, abas
 * com o frontend em loop chegaram a ~20 pings/min por rede.
 *
 * Redis `SET <chave> 1 PX 20000 NX`: quem ganha a chave passa; quem não
 * ganha recebe o tempo restante (`PTTL`). Redis fora / ausente → fail-open
 * (presença é best-effort, nunca bloqueia por falha de infraestrutura).
 *
 * Teto por usuário (todas as abas somadas): no máximo
 * `PRESENCE_PING_USER_MAX_PER_MIN` (padrão 6) pings aceitos pelo limite da
 * aba numa janela fixa de 60 s (`consumePresencePingUserSlot`). Contador
 * `INCR` + `PEXPIRE` no 1º ping da janela, num script Lua (atômico entre
 * réplicas). Excedeu → `retryAfterMs` = o que falta da janela.
 */
import { getCacheClient, noteFailure, noteSuccess } from "@/lib/cache/redis-client";

export const PRESENCE_PING_MIN_INTERVAL_MS = 20_000;
export const PRESENCE_TAB_ID_HEADER = "x-tab-id";
const KEY_PREFIX = "presence:ping-limit:";
const TAB_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export type PresencePingDecision = { ok: true } | { ok: false; retryAfterMs: number };

/** Id da aba do header; formato inválido = sem aba (limite por usuário). */
export function presenceTabId(headers: Headers): string | null {
  const raw = headers.get(PRESENCE_TAB_ID_HEADER)?.trim() ?? "";
  return TAB_ID_RE.test(raw) ? raw : null;
}

export function presencePingLimitKey(userId: string, tabId: string | null): string {
  return `${KEY_PREFIX}${userId}:${tabId ?? "-"}`;
}

export async function consumePresencePingSlot(params: {
  userId: string;
  tabId: string | null;
}): Promise<PresencePingDecision> {
  const client = getCacheClient();
  if (!client) return { ok: true };
  const key = presencePingLimitKey(params.userId, params.tabId);
  try {
    const won = await client.set(key, "1", "PX", PRESENCE_PING_MIN_INTERVAL_MS, "NX");
    if (won === "OK") {
      noteSuccess();
      return { ok: true };
    }
    const pttl = await client.pttl(key);
    noteSuccess();
    // -2: a chave expirou entre o SET e o PTTL — a janela já passou.
    if (pttl === -2) return { ok: true };
    const retryAfterMs =
      pttl > 0 ? Math.min(pttl, PRESENCE_PING_MIN_INTERVAL_MS) : PRESENCE_PING_MIN_INTERVAL_MS;
    return { ok: false, retryAfterMs };
  } catch (err) {
    noteFailure(err, key, "presence-ping-limit");
    return { ok: true };
  }
}

export const PRESENCE_PING_USER_WINDOW_MS = 60_000;
export const PRESENCE_PING_USER_MAX_PER_MIN_DEFAULT = 6;
const USER_KEY_PREFIX = "presence:ping-user:";

/** `PRESENCE_PING_USER_MAX_PER_MIN` (inteiro ≥ 1). Padrão 6. */
export function presencePingUserMaxPerMin(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.PRESENCE_PING_USER_MAX_PER_MIN?.trim() || NaN);
  return Number.isInteger(raw) && raw >= 1 ? raw : PRESENCE_PING_USER_MAX_PER_MIN_DEFAULT;
}

export function presencePingUserKey(userId: string): string {
  return `${USER_KEY_PREFIX}${userId}`;
}

/**
 * Conta o ping e devolve -1 se cabe na janela; senão o PTTL (ms) da janela.
 * Chave sem TTL (não deveria existir) ganha a janela de novo.
 */
const USER_CAP_SCRIPT = `-- crm:presence-ping-user-cap
local n = redis.call("INCR", KEYS[1])
if n == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
if n <= tonumber(ARGV[2]) then return -1 end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return ttl`;

/** Teto por usuário somando as abas. Redis fora / ausente → fail-open. */
export async function consumePresencePingUserSlot(params: {
  userId: string;
}): Promise<PresencePingDecision> {
  const client = getCacheClient();
  if (!client) return { ok: true };
  const key = presencePingUserKey(params.userId);
  try {
    const raw = await client.eval(
      USER_CAP_SCRIPT,
      1,
      key,
      String(PRESENCE_PING_USER_WINDOW_MS),
      String(presencePingUserMaxPerMin()),
    );
    noteSuccess();
    const ttl = Number(raw);
    if (!Number.isFinite(ttl) || ttl < 0) return { ok: true };
    return {
      ok: false,
      retryAfterMs: Math.max(1, Math.min(ttl, PRESENCE_PING_USER_WINDOW_MS)),
    };
  } catch (err) {
    noteFailure(err, key, "presence-ping-user-cap");
    return { ok: true };
  }
}
