/**
 * Invalidação do board disparada por `new_message` e escopo do evento
 * (`pipelineIds` / `dealIds`).
 *
 * `lastMessage` / `unreadCount` dos cards são por contato (qualquer
 * conversa dele), então uma mensagem nova só muda o board dos pipelines
 * onde o contato tem deal. Os publicadores de `new_message` quase nunca
 * têm o conjunto completo de pipelines em mãos: ele sai de UMA consulta
 * pelo índice (organizationId, contactId, status) de `deals`, agrupada
 * por pipeline. Contato sem deal não invalida board nenhum.
 *
 * A mesma consulta alimenta as duas coisas: a purga do cache do board e
 * os campos `pipelineIds` / `dealIds` que o barramento anexa ao evento
 * (contrato em `realtime-events.ts`). Não há segunda consulta por
 * mensagem para montar o evento.
 *
 * O resultado fica em memória por 60 s por processo
 * (`PIPELINES_CACHE_TTL_MS`): uma conversa ativa publica várias mensagens
 * por minuto em cada processo que publica (API, worker-meta-webhook,
 * worker-whatsapp, automação) e a janela de purga do board já é de 15 s,
 * então a consulta repetida não traz informação nova. Deal criado/movido
 * dentro desses 60 s já invalida o board no próprio write
 * (`invalidateBoardsForPipelines`); só a mensagem seguinte pode sair até
 * 60 s sem aquele pipeline/deal novo no escopo (o cliente continua
 * casando o card pelo contato, e o poll do board cobre o resto).
 *
 * Sem contato nem conversa no payload, ou com a consulta falhando, purga
 * todos os pipelines da org (comportamento anterior) e o evento sai SEM
 * escopo — o cliente cai no caminho antigo. Falha não é cacheada.
 *
 * prismaBase: `publish` roda em webhook/worker sem RequestContext; a org
 * vem do envelope e entra no WHERE.
 */
import { Prisma } from "@prisma/client";

import { scheduleBoardInvalidation } from "@/lib/cache/keys";
import { prismaBase } from "@/lib/prisma-base";
import { getLogger } from "@/lib/logger";

const log = getLogger("board-invalidation");

export const PIPELINES_CACHE_TTL_MS = 60_000;
/** Teto do Map por processo — evicção do mais antigo inserido. */
const PIPELINES_CACHE_MAX_ENTRIES = 5_000;

/**
 * Ids de deal trazidos por pipeline na consulta (literal `[1:25]` no SQL)
 * e teto de ids no evento. Passou de qualquer um dos dois, o evento sai
 * só com `pipelineIds`: lista de deals pela metade faria o cliente
 * concluir que o card que falta não é afetado.
 */
export const BOARD_SCOPE_DEAL_IDS_PER_PIPELINE = 25;
export const BOARD_SCOPE_MAX_DEAL_IDS = 50;

/** Quais boards/cards uma mensagem afeta. */
export type MessageBoardScope = {
  /** Pipelines onde o contato tem deal. Vazio = nenhum board afetado. */
  pipelineIds: string[];
  /**
   * Todos os deals do contato nesses pipelines. `null` = lista não
   * conhecida (chamador só informou o pipeline) ou grande demais.
   */
  dealIds: string[] | null;
};

const scopeByContact = new Map<
  string,
  { scope: MessageBoardScope; expiresAt: number }
>();

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((v): v is string => nonEmpty(v) !== null))];
}

function cacheKey(
  orgId: string,
  contactId: string | null,
  conversationId: string | null,
): string {
  return contactId ? `${orgId}|c:${contactId}` : `${orgId}|v:${conversationId}`;
}

function cachedScope(key: string): MessageBoardScope | undefined {
  const hit = scopeByContact.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    scopeByContact.delete(key);
    return undefined;
  }
  return hit.scope;
}

function rememberScope(key: string, scope: MessageBoardScope): void {
  if (scopeByContact.size >= PIPELINES_CACHE_MAX_ENTRIES) {
    const oldest = scopeByContact.keys().next().value;
    if (oldest !== undefined) scopeByContact.delete(oldest);
  }
  scopeByContact.set(key, {
    scope,
    expiresAt: Date.now() + PIPELINES_CACHE_TTL_MS,
  });
}

/** Só para testes: esvazia o cache contato → pipelines deste processo. */
export function clearMessagePipelineCache(): void {
  scopeByContact.clear();
}

type ScopeRow = {
  pipelineId: string | null;
  dealCount: number | bigint | null;
  dealIds: string[] | null;
};

async function findMessageBoardScope(
  orgId: string,
  contactId: string | null,
  conversationId: string | null,
): Promise<MessageBoardScope> {
  const contactMatch = contactId
    ? Prisma.sql`d."contactId" = ${contactId}`
    : Prisma.sql`d."contactId" = (
        SELECT c."contactId" FROM conversations c
        WHERE c.id = ${conversationId} AND c."organizationId" = ${orgId}
      )`;
  // Uma linha por pipeline: o volume da resposta não cresce com o número
  // de deals do contato (contato "genérico" de importação tem milhares).
  const rows = await prismaBase.$queryRaw<ScopeRow[]>`
    SELECT s."pipelineId" AS "pipelineId",
           COUNT(*)::int AS "dealCount",
           (ARRAY_AGG(d.id ORDER BY d."updatedAt" DESC))[1:25] AS "dealIds"
    FROM deals d
    INNER JOIN stages s ON s.id = d."stageId"
    WHERE d."organizationId" = ${orgId} AND ${contactMatch}
    GROUP BY s."pipelineId"
  `;

  const pipelineIds: string[] = [];
  const dealIds: string[] = [];
  let complete = true;
  for (const row of rows) {
    if (!row.pipelineId) continue;
    pipelineIds.push(row.pipelineId);
    // Linha sem a lista (formato antigo da consulta em mock/teste): só o
    // pipeline é conhecido.
    if (!Array.isArray(row.dealIds)) {
      complete = false;
      continue;
    }
    const ids = row.dealIds.filter((id): id is string => !!id);
    if (Number(row.dealCount ?? ids.length) > ids.length) complete = false;
    dealIds.push(...ids);
  }
  if (dealIds.length > BOARD_SCOPE_MAX_DEAL_IDS) complete = false;
  return { pipelineIds, dealIds: complete ? dealIds : null };
}

async function resolveMessageBoardScope(
  orgId: string,
  contactId: string | null,
  conversationId: string | null,
): Promise<MessageBoardScope> {
  const key = cacheKey(orgId, contactId, conversationId);
  const cached = cachedScope(key);
  if (cached) return cached;
  const scope = await findMessageBoardScope(orgId, contactId, conversationId);
  rememberScope(key, scope);
  return scope;
}

let lastScopeFailureLogAt = 0;

/**
 * A falha vira purga da org inteira e evento sem escopo — funciona, mas
 * custa caro se for permanente (consulta quebrada). Um log por minuto por
 * processo deixa isso visível sem inundar numa queda do banco.
 */
function logScopeFailure(err: unknown): void {
  const now = Date.now();
  if (now - lastScopeFailureLogAt < 60_000) return;
  lastScopeFailureLogAt = now;
  log.error(
    { err: err instanceof Error ? err.message : err },
    "[board-invalidation] contato → pipelines falhou; board da org purgado e new_message sem escopo",
  );
}

/**
 * Chamado por `sseBus.publish("new_message")`: agenda a purga do board
 * dos pipelines afetados e devolve o escopo que o barramento anexa ao
 * evento. `null` = escopo desconhecido (purga da org inteira; evento sai
 * sem `pipelineIds`). No máximo UMA consulta por chamada, e nenhuma
 * quando o payload já traz `pipelineIds`/`pipelineId` ou o cache de 60 s
 * responde.
 */
export async function scheduleBoardInvalidationForMessage(
  orgId: string,
  data: unknown,
): Promise<MessageBoardScope | null> {
  const rec =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};

  // Chamador já sabe os pipelines afetados (lista completa do contato).
  const explicitPipelineIds =
    stringList(rec.pipelineIds) ??
    (nonEmpty(rec.pipelineId) ? [rec.pipelineId as string] : null);
  if (explicitPipelineIds) {
    for (const pipelineId of explicitPipelineIds) {
      scheduleBoardInvalidation(orgId, pipelineId);
    }
    return { pipelineIds: explicitPipelineIds, dealIds: stringList(rec.dealIds) };
  }

  const contactId = nonEmpty(rec.contactId);
  const conversationId = nonEmpty(rec.conversationId);
  if (!contactId && !conversationId) {
    scheduleBoardInvalidation(orgId);
    return null;
  }

  let scope: MessageBoardScope;
  try {
    scope = await resolveMessageBoardScope(orgId, contactId, conversationId);
  } catch (err) {
    logScopeFailure(err);
    scheduleBoardInvalidation(orgId);
    return null;
  }
  for (const pipelineId of scope.pipelineIds) {
    scheduleBoardInvalidation(orgId, pipelineId);
  }
  return scope;
}

/**
 * Anexa o escopo ao payload do `new_message` (campos aditivos; cliente
 * antigo ignora). Sem escopo, devolve o payload como veio.
 */
export function withMessageBoardScope(
  payload: unknown,
  scope: MessageBoardScope | null,
): unknown {
  if (!scope) return payload;
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...(payload as Record<string, unknown>),
    pipelineIds: scope.pipelineIds,
    ...(scope.dealIds ? { dealIds: scope.dealIds } : {}),
  };
}
