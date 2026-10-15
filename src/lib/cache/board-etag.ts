/**
 * ETag e 304 do board (`GET`/`POST /api/pipelines/:id/board` e
 * `POST /api/pipelines/:id/board/columns`) — gate C de carga, 15/10/2026.
 *
 * Produção (15/10): board + mensagens + agendadas somavam 45 s de servidor
 * por minuto e nenhuma resposta 304. O board é a resposta mais cara do app e
 * a maioria das recargas (foco na aba, poll, volta à tela) devolvia
 * exatamente o mesmo quadro.
 *
 * ## O que entra no ETag
 *
 * O ETag NÃO é o hash do corpo — ler/montar o corpo é o que custa. É o hash de:
 *
 *   1. formato (`BOARD_ETAG_FORMAT`) e tipo da resposta (board, colunas, etapas);
 *   2. org e funil (org A nunca casa ETag da org B, mesmo funil/variante iguais);
 *   3. a variante canônica do pedido — a mesma de `canonicalBoardVariant`
 *      (filtros/status/página/ordenação/cursor normalizados) e com o
 *      PERFIL DE VISIBILIDADE: o `where` de posse do usuário (quem só vê os
 *      próprios negócios leva o próprio id) e o recorte de etapas do papel.
 *      Perfis diferentes nunca compartilham ETag;
 *   4. as versões de CARD do board (org + funil, `keys.ts`), que sobem só
 *      quando muda algo que aparece no card (escritores abaixo);
 *   5. as versões de ATIVIDADE (mensagens, coalescidas em 1/min por funil)
 *      SÓ quando a ordem/recorte depende delas: ordenação `lastInteraction`
 *      ou filtro de conversa/última mensagem (`boardEtagFreshness`);
 *   6. um balde de tempo: 15 min sempre (o card tem `isRotting` e
 *      `hasOverdueActivity`, relativos a "agora", e é a rede de segurança
 *      para escritor esquecido); 1 min quando o filtro depende de algo sem
 *      escritor rastreado (campos personalizados, origem/UTM do contato,
 *      busca livre, janela de 24 h, minutos parados, exceções do painel).
 *
 * ## Prévia e ordem por "última interação" sem bump por mensagem
 *
 * Mensagem nova e status de mensagem não mudam a versão de card. O
 * `new_message`/`message_status` chegam ao cliente pelo SSE e ele aplica
 * prévia, não lidas, ticks e posição do card no próprio cache
 * (`setQueryData`), sem pedir o board. Um 304 depois disso diz "o quadro
 * (cards, colunas, ordem por posição/criação) é o mesmo" — o cliente
 * reaproveita o corpo que tem e o merge `mergeBoardKeepingLiveActivity`
 * mantém a prévia mais nova que ele já aplicou. O valor em cache no servidor
 * pode ter a prévia de até 1 min atrás; quem recebe 200 recebe esse valor
 * (igual a hoje, com o TTL de 45 s).
 *
 * A ORDEM por última interação é a exceção: um card fora da página carregada
 * sobe para o topo no servidor e o evento não traz o card. Por isso, com
 * `sort=lastInteraction`, a versão de atividade (1 por minuto por funil, a
 * mesma que já purgava o valor em cache) entra no ETag: recarregar depois
 * de mensagens nesse funil devolve 200 com a ordem nova, no máximo 1 vez por
 * minuto; sem mensagem no funil, 304.
 *
 * ## Por que o 304 não toca no banco
 *
 * Sessão (JWT + caches), contexto authz, settings de visibilidade e flags vêm
 * do Redis/memória; funil por número/slug vem do cache local de funis; a
 * visibilidade de negócios (`getDealVisibilityFilter`) não lê o escopo de
 * departamento (só recorta conversas). As versões são 2 a 4 GETs pequenos no
 * Redis (a família `board` sem memória local — ver `versions.ts`), então uma
 * escrita numa réplica vale na outra na leitura seguinte.
 *
 * ## Escritores (quem sobe a versão de card)
 *
 * Funil conhecido → `invalidateBoardData(org, funil)` (direto ou via
 * `invalidateBoardsForPipelines` / `syncBoardsAfterDealChanges`); funil
 * desconhecido → `invalidateOrgBoards(org)`. A lista arquivo:linha está na
 * descrição do PR do gate C. Mensagem → `scheduleBoardInvalidationForMessages`
 * (só atividade).
 */
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { recordConditionalResponse } from "@/lib/metrics";
import type { ServerTiming } from "@/lib/server-timing";

import { boardVersionTag } from "./keys";
import { etagMatches, RESPONSE_CACHE_CONTROL, RESPONSE_CACHE_VARY } from "./response-cache";

/** Sobe quando o formato do corpo muda (deploy invalida os ETags antigos). */
export const BOARD_ETAG_FORMAT = "b1";
/** Balde de tempo de todo ETag do board: `isRotting`/atraso + rede de segurança. */
export const BOARD_ETAG_SAFETY_BUCKET_MS = 15 * 60_000;
/** Balde de tempo quando o filtro depende de dado sem escritor rastreado. */
export const BOARD_ETAG_VOLATILE_BUCKET_MS = 60_000;

/**
 * Filtros cujo resultado só muda por escritores de card (negócio, dono,
 * etapa, tags, contato do negócio). Datas são intervalos absolutos.
 */
const CARD_FILTER_KEYS: ReadonlySet<string> = new Set([
  "logic",
  "pipelineId",
  "stageIds",
  "statuses",
  "ownerIds",
  "withoutOwner",
  "withoutContact",
  "lostReasons",
  "tagIds",
  "tagMode",
  "withoutTags",
  "createdAt",
  "updatedAt",
  "closedAt",
]);

/** Filtros que mudam com mensagem (versão de atividade). */
const ACTIVITY_FILTER_KEYS: ReadonlySet<string> = new Set([
  "conversationStatus",
  "windowState",
  "lastMessageDirection",
  "lastInteractionAt",
  "idleMinutes",
]);

/** Filtros de atividade que também andam com o relógio. */
const TIME_RELATIVE_ACTIVITY_KEYS: ReadonlySet<string> = new Set(["windowState", "idleMinutes"]);

export type BoardEtagFreshness = {
  /** Inclui as versões de atividade (mensagens). */
  activity: boolean;
  /** Balde de 1 min (dado sem escritor rastreado ou relativo a agora). */
  volatile: boolean;
};

/**
 * Do que o ETag depende além das versões de card. `filters` = filtros já
 * canônicos (`canonicalBoardFilters`): vazio/padrão não conta.
 */
export function boardEtagFreshness(args: {
  sortField?: string | null;
  filters?: Record<string, unknown> | null;
}): BoardEtagFreshness {
  let activity = args.sortField === "lastInteraction";
  let volatile = false;
  for (const key of Object.keys(args.filters ?? {})) {
    if (CARD_FILTER_KEYS.has(key)) continue;
    if (ACTIVITY_FILTER_KEYS.has(key)) {
      activity = true;
      if (TIME_RELATIVE_ACTIVITY_KEYS.has(key)) volatile = true;
      continue;
    }
    // Qualquer outro critério (inclusive um novo): sem escritor rastreado.
    volatile = true;
  }
  return { activity, volatile };
}

export type BoardEtagKind = "board" | "columns" | "stages";

export type BoardEtagInput = {
  orgId: string;
  pipelineId: string;
  kind: BoardEtagKind;
  /** Pedido canônico + perfil de visibilidade (ver o cabeçalho). */
  variant: string;
  freshness: BoardEtagFreshness;
  /** Só testes. */
  now?: number;
};

/** ETag fraco do board. Lê só versões no Redis (nunca o banco). */
export async function computeBoardEtag(input: BoardEtagInput): Promise<string> {
  const now = input.now ?? Date.now();
  const versions = await boardVersionTag(input.orgId, input.pipelineId, {
    activity: input.freshness.activity,
  });
  const buckets = [Math.floor(now / BOARD_ETAG_SAFETY_BUCKET_MS)];
  if (input.freshness.volatile) buckets.push(Math.floor(now / BOARD_ETAG_VOLATILE_BUCKET_MS));
  const hash = createHash("sha1")
    .update(
      [
        BOARD_ETAG_FORMAT,
        input.kind,
        input.orgId,
        input.pipelineId,
        versions,
        input.freshness.activity ? "a" : "-",
        buckets.join("."),
      ].join("\n"),
    )
    .update("\n")
    .update(input.variant)
    .digest("hex");
  return `W/"${hash.slice(0, 32)}"`;
}

function boardCacheHeaders(etag: string): Record<string, string> {
  return {
    ETag: etag,
    "Cache-Control": RESPONSE_CACHE_CONTROL,
    Vary: RESPONSE_CACHE_VARY,
  };
}

/** O `If-None-Match` do pedido casa com o ETag atual? */
export function boardEtagMatches(request: Request, etag: string): boolean {
  return etagMatches(request.headers.get("if-none-match"), etag);
}

/** 304 sem corpo, com os cabeçalhos de cache (conta na métrica 304 × 200). */
export function boardNotModified(
  request: Request,
  etag: string,
  timing?: ServerTiming,
): NextResponse {
  recordConditionalResponse(new URL(request.url).pathname, 304);
  const headers = boardCacheHeaders(etag);
  if (timing) headers["Server-Timing"] = timing.header();
  return new NextResponse(null, { status: 304, headers });
}

/** Põe ETag/Cache-Control/Vary numa resposta 200 (e conta na métrica). */
export function withBoardEtag(request: Request, res: NextResponse, etag: string): NextResponse {
  if (res.status !== 200) return res;
  recordConditionalResponse(new URL(request.url).pathname, 200);
  for (const [name, value] of Object.entries(boardCacheHeaders(etag))) {
    res.headers.set(name, value);
  }
  return res;
}
