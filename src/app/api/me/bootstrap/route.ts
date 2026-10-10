/**
 * GET /api/me/bootstrap
 * ─────────────────────
 * Uma resposta com tudo que o shell precisa na carga: perfil,
 * preferências, permissões efetivas, organização, alert-config, status
 * do agente, e-mail não lido, salas do team-chat (resumo) e widgets
 * ativos. Contrato e regras por bloco em `services/me-bootstrap.ts`.
 *
 * Permissão: sessão autenticada (`requireAuth` via `withOrgContext`).
 * Não existe uma permission única para o agregado — cada bloco aplica a
 * checagem da rota que espelha e vem `null` quando negado.
 *
 * Cache: `ETag` forte (hash do JSON) + `Cache-Control: private, no-store`.
 * `If-None-Match` igual → 304 sem corpo. O servidor ainda monta o payload
 * para comparar (é o custo de manter o hash fiel); a economia é o corpo
 * e o re-render no cliente.
 *
 * `Server-Timing`: auth, query (monta o payload), serialize (JSON + ETag), total.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  buildMeBootstrap,
  computeBootstrapEtag,
  etagMatches,
} from "@/services/me-bootstrap";
import { getLogger } from "@/lib/logger";
import { ServerTiming } from "@/lib/server-timing";

const log = getLogger("api/me/bootstrap");

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, no-store";

export async function GET(request: Request) {
  const timing = new ServerTiming();
  return withOrgContext(async (session) => {
    // `auth` = JWT + versão da sessão + rate limit (antes do handler).
    timing.add("auth", timing.totalMs());
    try {
      const payload = await timing.time("query", () => buildMeBootstrap(session.user));
      const { body, etag } = timing.timeSync("serialize", () => {
        const json = JSON.stringify(payload);
        return { body: json, etag: computeBootstrapEtag(json) };
      });

      if (etagMatches(request.headers.get("if-none-match"), etag)) {
        return new NextResponse(null, {
          status: 304,
          headers: {
            ETag: etag,
            "Cache-Control": CACHE_CONTROL,
            "Server-Timing": timing.header(),
          },
        });
      }

      return new NextResponse(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: etag,
          "Cache-Control": CACHE_CONTROL,
          "Server-Timing": timing.header(),
        },
      });
    } catch (e) {
      log.error({ err: e }, "[GET /api/me/bootstrap] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar o bootstrap." },
        { status: 500 },
      );
    }
  });
}
