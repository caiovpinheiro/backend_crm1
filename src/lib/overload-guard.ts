/**
 * Proteção contra sobrecarga do processo (por réplica): mede o atraso do
 * event loop com `perf_hooks.monitorEventLoopDelay` numa janela deslizante e,
 * acima do limite, recusa primeiro as chamadas ACESSÓRIAS e depois as
 * LEITURAS PESADAS (classes de `api-cost-class.ts`). Essenciais (enviar
 * mensagem, salvar, mover, auth) e leituras comuns nunca são recusadas aqui.
 *
 * Medição
 * ───────
 * A janela (`OVERLOAD_WINDOW_MS`, 10 s) é dividida em 5 fatias. A cada fatia
 * o histograma é lido e zerado; o p99 da janela é o MAIOR p99 das fatias
 * dentro dela (conservador: uma fatia ruim já conta) e o p50 é a mediana dos
 * p50. Antes de completar a 1ª janela, vale o que já foi medido.
 *
 * Níveis (avaliados a cada fatia)
 * ───────────────────────────────
 * - 0: normal.
 * - 1: p99 da janela ≥ `OVERLOAD_P99_MS` (200) → 503 para `accessory`.
 * - 2: p99 continua ≥ `OVERLOAD_P99_MS` por mais uma janela inteira depois
 *   de entrar no nível 1, OU p99 ≥ `OVERLOAD_HEAVY_P99_MS` (500) → 503 também
 *   para `heavy_read`.
 * - Histerese: só volta a 0 quando o p99 da janela fica abaixo de
 *   `OVERLOAD_RECOVER_P99_MS` (150) — como o p99 é o máximo das fatias, isso
 *   exige uma janela inteira calma. Entre 150 e 200 o nível fica como está.
 *
 * Resposta 503: `{ message, code: "OVERLOADED", class, retryAfterMs }` +
 * `Retry-After`, `retryAfterMs` = `OVERLOAD_RETRY_AFTER_MS` (5000, entre 2 e
 * 5 s). `OVERLOAD_P99_MS=0` desliga a proteção.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import type { ApiCostClass } from "@/lib/api-cost-class";
import { getLogger } from "@/lib/logger";

const log = getLogger("overload-guard");

export type OverloadLevel = 0 | 1 | 2;

export type OverloadConfig = {
  /** 0 = desligado. */
  thresholdMs: number;
  windowMs: number;
  heavyThresholdMs: number;
  recoverMs: number;
  retryAfterMs: number;
};

export const OVERLOAD_DEFAULTS = {
  thresholdMs: 200,
  windowMs: 10_000,
  retryAfterMs: 5_000,
} as const;
const SLICES_PER_WINDOW = 5;

type Env = Record<string, string | undefined>;

function num(raw: string | undefined): number | null {
  const v = raw?.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function getOverloadConfig(env: Env = process.env): OverloadConfig {
  const thresholdMs = num(env.OVERLOAD_P99_MS) ?? OVERLOAD_DEFAULTS.thresholdMs;
  const windowMs = Math.max(1_000, num(env.OVERLOAD_WINDOW_MS) ?? OVERLOAD_DEFAULTS.windowMs);
  const heavy = num(env.OVERLOAD_HEAVY_P99_MS);
  const recover = num(env.OVERLOAD_RECOVER_P99_MS);
  const retry = num(env.OVERLOAD_RETRY_AFTER_MS) ?? OVERLOAD_DEFAULTS.retryAfterMs;
  return {
    thresholdMs,
    windowMs,
    heavyThresholdMs: heavy !== null && heavy > thresholdMs ? heavy : thresholdMs * 2.5,
    recoverMs: recover !== null && recover < thresholdMs ? recover : thresholdMs * 0.75,
    retryAfterMs: Math.min(5_000, Math.max(2_000, retry)),
  };
}

export type OverloadState = {
  level: OverloadLevel;
  /** Desde quando o p99 está ≥ limite (sem interrupção); `null` = não está. */
  aboveSince: number | null;
};

/** Transição pura de nível — testável sem relógio nem medidor. */
export function nextOverloadState(
  prev: OverloadState,
  sample: { p99Ms: number; now: number },
  cfg: OverloadConfig,
): OverloadState {
  if (cfg.thresholdMs <= 0) return { level: 0, aboveSince: null };
  const { p99Ms, now } = sample;
  if (p99Ms >= cfg.thresholdMs) {
    const aboveSince = prev.aboveSince ?? now;
    const persisted = prev.level >= 1 && now - aboveSince >= cfg.windowMs;
    const level: OverloadLevel =
      p99Ms >= cfg.heavyThresholdMs || persisted || prev.level === 2 ? 2 : 1;
    return { level, aboveSince };
  }
  if (p99Ms < cfg.recoverMs) return { level: 0, aboveSince: null };
  // Faixa de histerese: mantém o nível, mas a contagem de "acima" recomeça.
  return { level: prev.level, aboveSince: null };
}

/** `true` se a classe deve receber 503 no nível atual. */
export function overloadRejectsClass(level: OverloadLevel, cls: ApiCostClass): boolean {
  if (cls === "accessory") return level >= 1;
  if (cls === "heavy_read") return level >= 2;
  return false;
}

export type DelaySample = { p50Ms: number; p99Ms: number };

export type OverloadSnapshot = DelaySample & { level: OverloadLevel };

/**
 * Guarda com medidor e relógio injetáveis. `tick()` = fim de uma fatia:
 * lê o medidor, atualiza a janela deslizante e o nível.
 */
export class OverloadGuard {
  private slices: Array<DelaySample & { at: number }> = [];
  private state: OverloadState = { level: 0, aboveSince: null };
  private last: DelaySample = { p50Ms: 0, p99Ms: 0 };

  constructor(
    private readonly readSlice: () => DelaySample,
    private readonly now: () => number,
    private readonly config: () => OverloadConfig,
  ) {}

  tick(): OverloadSnapshot {
    const cfg = this.config();
    const now = this.now();
    this.slices.push({ ...this.readSlice(), at: now });
    // Mantém só as fatias da última janela (tolerância de meia fatia).
    const sliceMs = cfg.windowMs / SLICES_PER_WINDOW;
    const from = now - cfg.windowMs + sliceMs / 2;
    this.slices = this.slices.filter((s) => s.at > from).slice(-SLICES_PER_WINDOW);
    const p99Ms = Math.max(...this.slices.map((s) => s.p99Ms));
    const p50s = this.slices.map((s) => s.p50Ms).sort((a, b) => a - b);
    const p50Ms = p50s[Math.floor(p50s.length / 2)] ?? 0;
    this.last = { p50Ms, p99Ms };
    const prevLevel = this.state.level;
    this.state = nextOverloadState(this.state, { p99Ms, now }, cfg);
    if (this.state.level !== prevLevel) {
      const payload = { from: prevLevel, to: this.state.level, p50Ms, p99Ms };
      if (this.state.level > prevLevel) log.warn(payload, "sobrecarga: nível subiu");
      else log.info(payload, "sobrecarga: nível desceu");
    }
    return this.snapshot();
  }

  snapshot(): OverloadSnapshot {
    return { level: this.state.level, ...this.last };
  }
}

// ── Instância do processo ────────────────────────────────────────────────

type ProcessState = {
  guard: OverloadGuard | null;
  histogram: IntervalHistogram | null;
  timer: ReturnType<typeof setInterval> | null;
  /** Medidor indisponível neste runtime: não tenta de novo a cada requisição. */
  failed: boolean;
};

const globalForOverload = globalThis as typeof globalThis & { __crmOverloadGuard?: ProcessState };

function processState(): ProcessState {
  if (!globalForOverload.__crmOverloadGuard) {
    globalForOverload.__crmOverloadGuard = {
      guard: null,
      histogram: null,
      timer: null,
      failed: false,
    };
  }
  return globalForOverload.__crmOverloadGuard;
}

const NS_PER_MS = 1e6;

/**
 * Liga o medidor deste processo (idempotente). Só roda onde a API atende
 * (chamado na 1ª requisição autenticada); no Vitest só com guarda injetada.
 */
export function ensureOverloadGuardStarted(): OverloadGuard | null {
  const s = processState();
  if (s.guard) return s.guard;
  if (s.failed || process.env.VITEST === "true") return null;
  const cfg = getOverloadConfig();
  if (cfg.thresholdMs <= 0) return null;
  try {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const guard = new OverloadGuard(
      () => {
        const sample =
          histogram.count > 0
            ? {
                p50Ms: histogram.percentile(50) / NS_PER_MS,
                p99Ms: histogram.percentile(99) / NS_PER_MS,
              }
            : { p50Ms: 0, p99Ms: 0 };
        histogram.reset();
        return sample;
      },
      () => Date.now(),
      () => getOverloadConfig(),
    );
    const timer = setInterval(() => guard.tick(), cfg.windowMs / SLICES_PER_WINDOW);
    timer.unref?.();
    s.guard = guard;
    s.histogram = histogram;
    s.timer = timer;
    return guard;
  } catch (err) {
    s.failed = true;
    log.warn({ err }, "monitorEventLoopDelay indisponível — proteção de sobrecarga desligada");
    return null;
  }
}

/** Nível e atraso atuais deste processo (0 se a guarda não está ligada). */
export function getOverloadSnapshot(): OverloadSnapshot {
  const guard = processState().guard ?? ensureOverloadGuardStarted();
  return guard ? guard.snapshot() : { level: 0, p50Ms: 0, p99Ms: 0 };
}

/**
 * Decide se a chamada desta classe recebe 503 agora. `null` = segue.
 * Nunca recusa `essential` nem `cached_read`.
 */
export function checkOverload(cls: ApiCostClass): { retryAfterMs: number } | null {
  if (cls === "essential" || cls === "cached_read") return null;
  const cfg = getOverloadConfig();
  if (cfg.thresholdMs <= 0) return null;
  const { level } = getOverloadSnapshot();
  return overloadRejectsClass(level, cls) ? { retryAfterMs: cfg.retryAfterMs } : null;
}

/** Só testes: injeta uma guarda (medidor/relógio falsos) ou limpa. */
export function setOverloadGuardForTests(guard: OverloadGuard | null): void {
  const s = processState();
  if (s.timer) clearInterval(s.timer);
  s.histogram?.disable();
  globalForOverload.__crmOverloadGuard = { guard, histogram: null, timer: null, failed: false };
}
