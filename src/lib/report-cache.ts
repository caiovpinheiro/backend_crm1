import { cache } from "@/lib/cache";
import { reportKey } from "@/lib/cache/keys";
import { reportFingerprint } from "@/lib/report-fingerprint";

/** Janela máxima das telas de Configurações/Logs (igual a `/api/logs/system-usage/_period.ts`). */
export const REPORT_MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

/** Relatório fresco por 60 s e servido vencido por mais 120 s enquanto recalcula. */
export const REPORT_FRESH_SEC = 60;
export const REPORT_STALE_SEC = 120;

/** Como o relatório foi servido (cabeçalho `Server-Timing`, fase `cache`). */
export type ReportCacheStatus = "hit" | "miss" | "stale";

/**
 * Relatórios do painel/analytics com cache por org + parâmetros, sem invalidação
 * ativa (o teto de staleness é REPORT_FRESH_SEC + REPORT_STALE_SEC). Requisições
 * idênticas simultâneas dividem uma única execução do `loader` (singleflight no
 * processo + lock no Redis entre réplicas, dentro de `cache.wrapSwr`). Se o
 * `loader` lançar, nada é gravado.
 */
export function cachedReport<T>(
  name: string,
  orgId: string,
  parts: Record<string, unknown>,
  loader: () => Promise<T>,
  opts?: { onStatus?: (status: ReportCacheStatus) => void },
): Promise<T> {
  let started = false;
  let settled = false;
  const tracked = opts?.onStatus
    ? async () => {
        started = true;
        try {
          return await loader();
        } finally {
          settled = true;
        }
      }
    : loader;
  const result = cache.wrapSwr(
    reportKey(name, orgId, reportFingerprint(parts)),
    { ttlSec: REPORT_FRESH_SEC, staleSec: REPORT_STALE_SEC },
    tracked,
  );
  if (!opts?.onStatus) return result;
  const onStatus = opts.onStatus;
  return result.then((value) => {
    // O loader deste chamador terminou antes da resposta: miss. Começou e ainda
    // roda: o vencido foi servido enquanto recalcula em segundo plano (stale).
    // Nem começou: servido do cache (inclui valor calculado por outra
    // requisição simultânea, que dividiu o loader).
    onStatus(started ? (settled ? "miss" : "stale") : "hit");
    return value;
  });
}
