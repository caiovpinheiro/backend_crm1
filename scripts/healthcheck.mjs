#!/usr/bin/env node
/**
 * HEALTHCHECK do container (Dockerfile). Mesma imagem para API e workers:
 *
 *  - APP_MODE=api | api-public → GET http://127.0.0.1:$PORT/api/health.
 *    200 (ok) e 503 (degraded: Postgres/Redis fora) contam como vivo — é
 *    checagem de liveness. Reiniciar a API não conserta o banco e o boot
 *    novo ainda rodaria `migrate deploy` contra ele. Timeout, conexão
 *    recusada ou outro status → 1.
 *  - worker-* → 0 (sem HTTP).
 *  - APP_MODE desconhecido → 0 (melhor não derrubar do que reiniciar em loop).
 *
 * APP_MODE/PORT vêm de /tmp/healthcheck.env, gravado pelo entrypoint depois
 * de carregar /app/.env — no EasyPanel com "Create .env file" as variáveis
 * existem só nesse arquivo e não no ambiente que o `docker exec` do
 * healthcheck herda. Sem o arquivo, cai no ambiente do container.
 */
import { readFileSync } from "node:fs";

const STATE_FILE = process.env.HEALTHCHECK_STATE_FILE || "/tmp/healthcheck.env";
const TIMEOUT_MS = Number(process.env.HEALTHCHECK_TIMEOUT_MS) || 4_000;

function readState() {
  const out = {};
  try {
    for (const line of readFileSync(STATE_FILE, "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch {
    /* sem arquivo: usa o ambiente */
  }
  return out;
}

const state = readState();
const mode = (state.APP_MODE || process.env.APP_MODE || "").trim();
const port = (state.PORT || process.env.PORT || "3000").trim();

if (mode !== "api" && mode !== "api-public") process.exit(0);

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 200 || res.status === 503) process.exit(0);
  console.error(`[healthcheck] /api/health respondeu ${res.status}`);
  process.exit(1);
} catch (err) {
  console.error(`[healthcheck] /api/health falhou: ${err?.message ?? err}`);
  process.exit(1);
}
