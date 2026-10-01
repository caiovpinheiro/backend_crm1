import { NextResponse } from "next/server";

import {
  canSeeHealthDetail,
  getHealthSnapshot,
  healthUptimeSec,
} from "@/lib/health-check";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Endpoint público de saúde, consumido por monitores externos, pelo
 * healthcheck do compose (`deploy/digitalocean`) e pelo cockpit-monitor.
 * Liberado no middleware — NÃO exigir auth para o estado agregado.
 *
 *  - Sem credencial: `{ "status": "ok" | "degraded" }`, 200 ou 503. Todos
 *    os consumidores conhecidos só olham o status HTTP.
 *  - Com `HEALTH_TOKEN` (`X-Health-Token` ou `Authorization: Bearer`) ou
 *    sessão de super-admin: detalhe de Postgres/Redis, latências, uptime
 *    e o commit da imagem (`gitSha`, do build arg GIT_SHA). O commit NÃO
 *    sai na resposta pública.
 *  - Sempre `Cache-Control: no-store` pra evitar resposta carimbada por
 *    Traefik/CDN.
 *
 * Checagens e regra de acesso em `@/lib/health-check`.
 */

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: Request) {
  const snapshot = await getHealthSnapshot();
  const status = snapshot.ok ? "ok" : "degraded";
  const httpStatus = snapshot.ok ? 200 : 503;

  if (!(await canSeeHealthDetail(request))) {
    return NextResponse.json({ status }, { status: httpStatus, headers: NO_STORE });
  }

  return NextResponse.json(
    {
      status,
      db: snapshot.db,
      redis: snapshot.redis,
      uptimeSec: healthUptimeSec(),
      gitSha: process.env.GIT_SHA?.trim() || null,
      timestamp: new Date().toISOString(),
    },
    { status: httpStatus, headers: NO_STORE },
  );
}

export async function HEAD() {
  const snapshot = await getHealthSnapshot();
  return new NextResponse(null, {
    status: snapshot.ok ? 200 : 503,
    headers: NO_STORE,
  });
}
