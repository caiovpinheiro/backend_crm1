import { createHash } from "node:crypto";

const MINUTE_MS = 60_000;

/** Instante arredondado para baixo ao minuto (ms desde a época). */
export function floorToMinute(date: Date): number {
  const t = date.getTime();
  return Number.isFinite(t) ? Math.floor(t / MINUTE_MS) * MINUTE_MS : 0;
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return { $minute: floorToMinute(value) };
  if (Array.isArray(value)) {
    // Listas de ids: sem repetição e em ordem, para `a,b` e `b,a` serem a mesma chave.
    if (value.every((v) => typeof v === "string")) {
      return [...new Set(value as string[])].sort();
    }
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) {
      if (rec[key] !== undefined) out[key] = normalize(rec[key]);
    }
    return out;
  }
  return value;
}

/**
 * Impressão digital estável dos parâmetros de um relatório: datas arredondadas
 * ao minuto, listas de ids ordenadas e sem repetição, chaves em ordem alfabética.
 * A mesma consulta escrita de outro jeito cai na mesma chave de cache.
 */
export function reportFingerprint(parts: Record<string, unknown>): string {
  return createHash("sha1")
    .update(JSON.stringify(normalize(parts)))
    .digest("hex")
    .slice(0, 24);
}
