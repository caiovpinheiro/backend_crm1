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
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  buildMeBootstrap,
  computeBootstrapEtag,
  etagMatches,
} from "@/services/me-bootstrap";

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, no-store";

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const payload = await buildMeBootstrap(session.user);
      const body = JSON.stringify(payload);
      const etag = computeBootstrapEtag(body);

      if (etagMatches(request.headers.get("if-none-match"), etag)) {
        return new NextResponse(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": CACHE_CONTROL },
        });
      }

      return new NextResponse(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: etag,
          "Cache-Control": CACHE_CONTROL,
        },
      });
    } catch (e) {
      console.error("[GET /api/me/bootstrap]", e);
      return NextResponse.json(
        { message: "Erro ao carregar o bootstrap." },
        { status: 500 },
      );
    }
  });
}
