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
