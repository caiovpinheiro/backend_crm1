/**
 * GET /api/me/bootstrap
 * ─────────────────────
 * Uma resposta com tudo que o shell precisa na carga: perfil,
 * preferências, permissões efetivas, organização, alert-config, status
 * do agente, e-mail não lido, salas do team-chat (resumo) e widgets
 * ativos — contrato e regras por bloco em `services/me-bootstrap.ts` — e,
 * em `blocks`, os corpos das rotas globais que a aba nova chama (funis,
 * canais, usuários, respostas rápidas…) indexados pela URL exata; contrato
 * em `services/bootstrap-blocks.ts` e no tipo `MeBootstrapResponse`.
 *
 * Permissão: sessão autenticada (`requireAuth` via `withOrgContext`).
 * Não existe uma permission única para o agregado — cada bloco aplica a
 * checagem da rota que espelha e vem `null`/ausente quando negado.
 *
 * Cache: `ETag` fraco = usuário + payload base + ETag de cada bloco, com
 * `Cache-Control: private, no-cache` (o navegador revalida sozinho com
 * `If-None-Match`). `If-None-Match` igual → 304 sem corpo. O payload base
 * ainda é montado a cada chamada (dados voláteis por usuário: status,
 * não lidos); os blocos entram no ETag pelo ETag guardado no cache — no 304
 * nenhum corpo de bloco é lido.
 *
 * `Server-Timing`: auth, query (payload base), cache (blocos), serialize, total.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { RESPONSE_CACHE_CONTROL, RESPONSE_CACHE_VARY } from "@/lib/cache/response-cache";
import {
  TEAM_CHAT_ROOMS_URL,
  appendBlocksToBootstrapJson,
  inContractOrder,
  loadBootstrapBlocks,
  resolveBootstrapBlocks,
  teamChatRoomsBlock,
  type BootstrapBlockEntry,
  type BootstrapBlockUrl,
} from "@/services/bootstrap-blocks";
import {
  buildMeBootstrap,
  computeBootstrapBlocksEtag,
  etagMatches,
} from "@/services/me-bootstrap";
import { getLogger } from "@/lib/logger";
import { recordConditionalResponse } from "@/lib/metrics";
import { ServerTiming } from "@/lib/server-timing";

const log = getLogger("api/me/bootstrap");

export const dynamic = "force-dynamic";

function headers(etag: string, timing: ServerTiming): Record<string, string> {
  return {
    ETag: etag,
    "Cache-Control": RESPONSE_CACHE_CONTROL,
    Vary: RESPONSE_CACHE_VARY,
    "Server-Timing": timing.header(),
  };
}

export async function GET(request: Request) {
  const timing = new ServerTiming();
  return withOrgContext(async (session) => {
    // `auth` = JWT + versão da sessão + rate limit (antes do handler).
    timing.add("auth", timing.totalMs());
    try {
      let fullRooms: unknown[] | null = null;
      const [payload, refs] = await Promise.all([
        timing.time("query", () =>
          buildMeBootstrap(session.user, {
            onTeamChatRooms: (rooms) => {
              fullRooms = rooms;
            },
          }),
        ),
        timing.time("cache", () => resolveBootstrapBlocks(session.user)),
      ]);
      const baseJson = timing.timeSync("serialize", () => JSON.stringify(payload));
      const ifNoneMatch = request.headers.get("if-none-match");

      // Bloco por usuário (salas do team-chat): da consulta do payload base.
      // Sem permissão → ausente; falha → `blockErrors`.
      const liveRooms: BootstrapBlockEntry | null =
        fullRooms !== null && session.user.organizationId
          ? teamChatRoomsBlock(session.user.organizationId, fullRooms)
          : null;
      const liveErrors: BootstrapBlockUrl[] = payload.failedBlocks?.includes("teamChatRooms")
        ? [TEAM_CHAT_ROOMS_URL]
        : [];
      const withLive = <T extends { url: BootstrapBlockUrl; etag: string }>(items: T[]) =>
        inContractOrder<{ url: BootstrapBlockUrl; etag: string }>(
          liveRooms ? [...items, liveRooms] : items,
        );

      // 304 sem ler corpo de bloco: todos os ETags já estão guardados.
      if (ifNoneMatch && refs.every((r) => r.knownEtag)) {
        const etag = computeBootstrapBlocksEtag(
          session.user.id,
          baseJson,
          withLive(refs.map((r) => ({ url: r.url, etag: r.knownEtag as string }))),
          liveErrors,
        );
        if (etagMatches(ifNoneMatch, etag)) {
          recordConditionalResponse("/api/me/bootstrap", 304);
          return new NextResponse(null, { status: 304, headers: headers(etag, timing) });
        }
      }

      const loaded = await timing.time("cache", () => loadBootstrapBlocks(refs));
      const blocks = {
        entries: inContractOrder(liveRooms ? [...loaded.entries, liveRooms] : loaded.entries),
        errors: inContractOrder([...loaded.errors, ...liveErrors].map((url) => ({ url }))).map(
          (e) => e.url,
        ),
      };
      const etag = computeBootstrapBlocksEtag(
        session.user.id,
        baseJson,
        blocks.entries,
        blocks.errors,
      );
      if (etagMatches(ifNoneMatch, etag)) {
        recordConditionalResponse("/api/me/bootstrap", 304);
        return new NextResponse(null, { status: 304, headers: headers(etag, timing) });
      }
      recordConditionalResponse("/api/me/bootstrap", 200);
      const body = timing.timeSync("serialize", () =>
        appendBlocksToBootstrapJson(baseJson, blocks),
      );
      return new NextResponse(body, {
        status: 200,
        headers: { "Content-Type": "application/json", ...headers(etag, timing) },
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
