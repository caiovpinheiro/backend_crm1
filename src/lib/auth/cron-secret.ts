import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

/**
 * Autenticação única das rotas `/api/cron/*` (SEC-20).
 *
 * Forma preferida: `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Compatibilidade: `?secret=` continua aceito porque há agendadores
 * (Easypanel "Scheduled", curl em crontab) configurados assim. Esse uso é
 * DEPRECADO — o segredo vai parar em logs de acesso do proxy/Traefik.
 * Cada uso emite um aviso amostrado (1 por rota a cada 10 min) pra que o
 * operador migre o agendador para o header sem poluir o log.
 *
 * A comparação usa `crypto.timingSafeEqual` sobre buffers do mesmo tamanho
 * (tamanhos diferentes → falha sem comparar byte a byte, o que não vaza o
 * conteúdo, só o comprimento — aceitável para um segredo de cron).
 */

const QUERY_WARN_WINDOW_MS = 10 * 60 * 1000;
const lastQueryWarnAtByRoute = new Map<string, number>();

/** Só testes. */
export function resetCronSecretWarningsForTests(): void {
  lastQueryWarnAtByRoute.clear();
}

export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function extractBearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/**
 * Retorna `null` quando o segredo confere; caso contrário, a resposta de
 * erro pronta (503 sem `CRON_SECRET` configurado, 401 segredo inválido).
 *
 * Uso: `const denied = requireCronSecret(request); if (denied) return denied;`
 */
export function requireCronSecret(request: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json(
      { ok: false, message: "CRON_SECRET nao configurado." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const headerSecret = extractBearer(request);
  let provided = headerSecret;
  let viaQuery = false;

  if (!provided) {
    const querySecret = url.searchParams.get("secret")?.trim() ?? "";
    if (querySecret) {
      provided = querySecret;
      viaQuery = true;
    }
  }

  if (!provided || !secretsMatch(provided, expected)) {
    return NextResponse.json(
      { ok: false, message: "Cron secret invalido." },
      { status: 401 },
    );
  }

  if (viaQuery) {
    const now = Date.now();
    const last = lastQueryWarnAtByRoute.get(url.pathname) ?? 0;
    if (now - last >= QUERY_WARN_WINDOW_MS) {
      lastQueryWarnAtByRoute.set(url.pathname, now);
      console.warn(
        `[cron] ${url.pathname}: CRON_SECRET recebido por ?secret= (DEPRECADO — vaza em logs de proxy). Migre o agendador para o header "Authorization: Bearer".`,
      );
    }
  }

  return null;
}
