/**
 * Coalescência de purga entre réplicas (E4 / N-BE-4 da auditoria).
 *
 * As purgas do board e dos contadores do Inbox são "leading + trailing" numa
 * janela (15 s): a 1ª mudança purga na hora, as seguintes da janela viram UMA
 * purga no fim dela. Antes a janela era um `setTimeout` por processo — com 2
 * réplicas cada uma abria a sua e a org era purgada duas vezes por janela
 * (o recálculo do board, ~2,4 s, dobrava).
 *
 * Agora a janela é um claim no Redis do cache, atômico (Lua):
 *
 *   SET cache:coalesce:<nome> <token> NX PX <janela>
 *     ganhou  → esta réplica é a DONA: purga na hora e, no fim da janela,
 *               solta o claim (compare-and-delete) e lê a marca de sujo;
 *     perdeu  → outra réplica é dona: grava `cache:coalesce-dirty:<nome>`
 *               (PX 2 × janela) no MESMO script e não purga.
 *   Fim da janela na dona: sujo (marca no Redis ou evento local) → agenda
 *   de novo, que reivindica a janela seguinte e purga (o trailing).
 *
 * Por que no mesmo script: a dona solta o claim ANTES de apagar a marca. Uma
 * marca escrita enquanto o claim existia já está lá quando a dona a apaga;
 * depois de solto, quem chega reivindica e purga ele mesmo.
 *
 * Por processo continua só o atalho local: dentro de uma janela conhecida,
 * eventos seguintes não vão ao Redis. Na dona, o evento local entra no
 * "sujo" do fim da janela. Na seguidora, a marca gravada no claim cobre os
 * eventos até a dona apagá-la — o que só acontece depois de o claim
 * expirar; por isso a seguidora absorve localmente só até
 * (PTTL − FOLLOWER_MARGIN_MS) e, depois disso, o próximo evento volta ao
 * Redis (reivindica, ou marca sujo de novo). Sem purga repetida.
 *
 * Sem Redis (ou comando que falhou): janela local, como antes.
 * Dona que morre no meio da janela: o claim expira e a marca fica sem
 * trailing — o stale máximo vira o TTL do valor (board 45 s, contadores
 * 90 s + SWR), o mesmo de antes para quem não tinha purga.
 */
import { getCacheClient, noteFailure, noteSuccess } from "./redis-client";

const CLAIM_PREFIX = "cache:coalesce:";
const DIRTY_PREFIX = "cache:coalesce-dirty:";

/** -1 = claim ganho; ≥ 0 = ms restantes do claim de outra réplica. */
const CLAIM_SCRIPT = `-- crm:coalesce-claim
if redis.call("set", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  return -1
end
redis.call("set", KEYS[2], "1", "PX", ARGV[3])
local ttl = redis.call("pttl", KEYS[1])
if ttl < 0 then return 0 end
return ttl`;

/** Solta o claim só se ainda é desta réplica (compare-and-delete). */
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Folga da seguidora antes do fim do claim da dona (latência do Redis). */
const FOLLOWER_MARGIN_MS = 1_000;

type Slot = {
  role: "pending" | "owner" | "follower";
  /** Evento local depois da última purga (só a dona usa). */
  again: boolean;
  /** Seguidora: até quando a marca de sujo cobre eventos locais. */
  until: number;
};

const slots = new Map<string, Slot>();

export function coalesceClaimKey(name: string): string {
  return CLAIM_PREFIX + name;
}

export function coalesceDirtyKey(name: string): string {
  return DIRTY_PREFIX + name;
}

function newToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
}

async function runPurge(purge: () => Promise<void> | void): Promise<void> {
  try {
    await purge();
  } catch {
    /* cache é best-effort — o TTL cobre a falha */
  }
}

/**
 * Agenda `purge` com coalescência leading + trailing por `name`, valendo
 * entre réplicas quando há Redis. Fire-and-forget: nunca lança nem espera.
 */
export function scheduleCoalescedPurge(
  name: string,
  windowMs: number,
  purge: () => Promise<void> | void,
): void {
  const open = slots.get(name);
  if (open && !(open.role === "follower" && Date.now() >= open.until)) {
    open.again = true;
    return;
  }
  const slot: Slot = { role: "pending", again: false, until: Infinity };
  slots.set(name, slot);
  void startWindow(name, windowMs, purge, slot);
}

async function startWindow(
  name: string,
  windowMs: number,
  purge: () => Promise<void> | void,
  slot: Slot,
): Promise<void> {
  const token = newToken();
  let inRedis = false;
  let followerMs: number | null = null;

  const client = getCacheClient();
  if (client) {
    try {
      const reply = Number(
        await client.eval(
          CLAIM_SCRIPT,
          2,
          coalesceClaimKey(name),
          coalesceDirtyKey(name),
          token,
          String(windowMs),
          String(windowMs * 2),
        ),
      );
      noteSuccess();
      if (reply === -1) inRedis = true;
      else followerMs = Number.isFinite(reply) ? Math.max(0, reply) : 0;
    } catch (err) {
      noteFailure(err, name, "coalesce");
    }
  }

  if (followerMs !== null) {
    // Outra réplica é dona: a marca de sujo gravada no claim cobre os
    // eventos até ela apagá-la (depois de o claim expirar); ela faz o
    // trailing. A janela local expira por tempo, sem timer.
    slot.role = "follower";
    slot.again = false;
    slot.until = Date.now() + followerMs - FOLLOWER_MARGIN_MS;
    return;
  }

  // Dona (Redis) ou janela local (sem Redis): purga agora. Eventos locais
  // até aqui ficam cobertos por esta purga.
  slot.role = "owner";
  slot.again = false;
  const timer = setTimeout(() => {
    void closeWindow(name, windowMs, purge, slot, inRedis ? token : null);
  }, windowMs);
  unrefTimer(timer);
  await runPurge(purge);
}

async function closeWindow(
  name: string,
  windowMs: number,
  purge: () => Promise<void> | void,
  slot: Slot,
  token: string | null,
): Promise<void> {
  if (slots.get(name) === slot) slots.delete(name);
  let dirty = slot.again;
  if (token) {
    const client = getCacheClient();
    if (client) {
      try {
        await client.eval(RELEASE_SCRIPT, 1, coalesceClaimKey(name), token);
        const removed = await client.del(coalesceDirtyKey(name));
        noteSuccess();
        if (Number(removed) > 0) dirty = true;
      } catch (err) {
        noteFailure(err, name, "coalesce");
      }
    }
  }
  if (dirty) scheduleCoalescedPurge(name, windowMs, purge);
}

/** Só para testes: esquece as janelas locais (timers pendentes ficam). */
export function resetCoalesceForTests(): void {
  slots.clear();
}
