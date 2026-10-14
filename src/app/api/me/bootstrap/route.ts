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
 *
 * ## v2 — header `x-bootstrap-version: 2`
 *
 * Só o payload ESTÁVEL (`buildMeBootstrapStable`: sem `agentStatus`,
 * `emailUnread`, `teamChatRooms`) + `blocks` sem `/api/team-chat/rooms`. Os
 * voláteis estão em `GET /api/me/live`. O payload estável fica no Redis por
 * usuário (`services/me-bootstrap-cache.ts`, invalidação explícita + TTL de
 * 10 min) e o ETag do v2 = usuário + ETag guardado do payload + ETag de cada
 * bloco. `If-None-Match` igual → 304 lendo só versões/ETags no Redis, sem
 * nenhuma consulta Prisma (`Server-Timing: cache;desc="304"`, sem `query`).
 * Sem o header (frontend atual da main), a resposta continua a v1 acima.
 * `Vary` inclui `X-Bootstrap-Version`: a mesma URL tem dois corpos.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { isBootstrapV2 } from "@/lib/bootstrap-version";
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
  type MeBootstrapUser,
} from "@/services/me-bootstrap";
import {
  loadMeBootstrapStable,
  meBootstrapCacheKey,
  peekMeBootstrapEtag,
} from "@/services/me-bootstrap-cache";
import { getLogger } from "@/lib/logger";
import { recordCacheLookup, recordConditionalResponse } from "@/lib/metrics";
import { ServerTiming } from "@/lib/server-timing";

const log = getLogger("api/me/bootstrap");

export const dynamic = "force-dynamic";

function headers(etag: string, timing: ServerTiming): Record<string, string> {
  return {
    ETag: etag,
    "Cache-Control": RESPONSE_CACHE_CONTROL,
    // Inclui `X-Bootstrap-Version`: a mesma URL tem dois corpos (v1/v2).
    Vary: RESPONSE_CACHE_VARY,
    "Server-Timing": timing.header(),
  };
}

/** ETag do v2: usuário + ETag do payload estável + ETag de cada bloco. */
function v2Etag(
  userId: string,
  baseEtag: string,
  blocks: readonly { url: string; etag: string }[],
  blockErrors: readonly string[] = [],
): string {
  return computeBootstrapBlocksEtag(userId, `v2\n${baseEtag}`, blocks, blockErrors);
}

async function respondV2(
  request: Request,
  user: MeBootstrapUser,
  timing: ServerTiming,
): Promise<NextResponse> {
  const ifNoneMatch = request.headers.get("if-none-match");
  const t0 = performance.now();
  const [key, refs] = await Promise.all([
    meBootstrapCacheKey(user),
    resolveBootstrapBlocks(user, { stable: true }),
  ]);

  // 304 só com versões e ETags guardados: nenhum corpo lido, nenhum Prisma.
  if (ifNoneMatch && refs.every((r) => r.knownEtag)) {
    const baseEtag = await peekMeBootstrapEtag(key);
    if (baseEtag) {
      const etag = v2Etag(
        user.id,
        baseEtag,
        inContractOrder(refs.map((r) => ({ url: r.url, etag: r.knownEtag as string }))),
      );
      if (etagMatches(ifNoneMatch, etag)) {
        timing.add("cache", performance.now() - t0, "304");
        recordCacheLookup("resp_me_boot", true);
        recordConditionalResponse("/api/me/bootstrap", 304);
        return new NextResponse(null, { status: 304, headers: headers(etag, timing) });
      }
    }
  }

  const [base, loaded] = await Promise.all([
    loadMeBootstrapStable(user, key, (fn) => timing.time("query", fn)),
    loadBootstrapBlocks(refs),
  ]);
  timing.add("cache", performance.now() - t0, base.source);
  recordCacheLookup("resp_me_boot", base.source !== "miss");
  const blocks = {
    entries: inContractOrder(loaded.entries),
    errors: loaded.errors,
  };
  const etag = v2Etag(user.id, base.etag, blocks.entries, blocks.errors);
  if (etagMatches(ifNoneMatch, etag)) {
    recordConditionalResponse("/api/me/bootstrap", 304);
    return new NextResponse(null, { status: 304, headers: headers(etag, timing) });
  }
  recordConditionalResponse("/api/me/bootstrap", 200);
  const body = timing.timeSync("serialize", () => appendBlocksToBootstrapJson(base.body, blocks));
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers(etag, timing) },
  });
}

export async function GET(request: Request) {
  const timing = new ServerTiming();
  return withOrgContext(async (session) => {
    // `auth` = JWT + versão da sessão + rate limit (antes do handler).
    timing.add("auth", timing.totalMs());
    try {
      if (isBootstrapV2(request)) return await respondV2(request, session.user, timing);

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
