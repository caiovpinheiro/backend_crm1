/**
 * Invalidação do board disparada por `new_message`.
 *
 * `lastMessage` / `unreadCount` dos cards são por contato (qualquer
 * conversa dele), então uma mensagem nova só muda o board dos pipelines
 * onde o contato tem deal. Os publicadores de `new_message` não mandam o
 * `pipelineId`: ele sai de uma consulta pelo índice
 * (organizationId, contactId, status) de `deals`. Contato sem deal não
 * invalida board nenhum.
 *
 * O resultado dessa consulta fica em memória por 60 s por processo
 * (`PIPELINES_CACHE_TTL_MS`): uma conversa ativa publica várias mensagens
 * por minuto em cada processo que publica (API, worker-meta-webhook,
 * worker-whatsapp, automação) e a janela de purga do board já é de 15 s,
 * então a consulta repetida não traz informação nova. Deal criado/movido
 * dentro desses 60 s já invalida o board no próprio write
 * (`invalidateBoardsForPipelines`); só o preview da mensagem seguinte
 * pode ficar até 60 s sem purga naquele pipeline novo.
 *
 * Sem contato nem conversa no payload, ou com a consulta falhando, purga
 * todos os pipelines da org (comportamento anterior). Falha não é cacheada.
 *
 * prismaBase: `publish` roda em webhook/worker sem RequestContext; a org
 * vem do envelope e entra no WHERE.
 */
import { Prisma } from "@prisma/client";

import { scheduleBoardInvalidation } from "@/lib/cache/keys";
import { prismaBase } from "@/lib/prisma-base";

export const PIPELINES_CACHE_TTL_MS = 60_000;
/** Teto do Map por processo — evicção do mais antigo inserido. */
const PIPELINES_CACHE_MAX_ENTRIES = 5_000;

const pipelinesByContact = new Map<
  string,
  { pipelineIds: string[]; expiresAt: number }
>();

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function cacheKey(
  orgId: string,
  contactId: string | null,
  conversationId: string | null,
): string {
  return contactId ? `${orgId}|c:${contactId}` : `${orgId}|v:${conversationId}`;
}

function cachedPipelineIds(key: string): string[] | undefined {
  const hit = pipelinesByContact.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    pipelinesByContact.delete(key);
    return undefined;
  }
  return hit.pipelineIds;
}

function rememberPipelineIds(key: string, pipelineIds: string[]): void {
  if (pipelinesByContact.size >= PIPELINES_CACHE_MAX_ENTRIES) {
    const oldest = pipelinesByContact.keys().next().value;
    if (oldest !== undefined) pipelinesByContact.delete(oldest);
  }
  pipelinesByContact.set(key, {
    pipelineIds,
    expiresAt: Date.now() + PIPELINES_CACHE_TTL_MS,
  });
}

/** Só para testes: esvazia o cache contato → pipelines deste processo. */
export function clearMessagePipelineCache(): void {
  pipelinesByContact.clear();
}

async function findMessagePipelineIds(
  orgId: string,
  contactId: string | null,
  conversationId: string | null,
): Promise<string[]> {
  const contactMatch = contactId
    ? Prisma.sql`d."contactId" = ${contactId}`
    : Prisma.sql`d."contactId" = (
        SELECT c."contactId" FROM conversations c
        WHERE c.id = ${conversationId} AND c."organizationId" = ${orgId}
      )`;
  const rows = await prismaBase.$queryRaw<Array<{ pipelineId: string }>>`
    SELECT DISTINCT s."pipelineId" AS "pipelineId"
    FROM deals d
    INNER JOIN stages s ON s.id = d."stageId"
    WHERE d."organizationId" = ${orgId} AND ${contactMatch}
  `;
  return rows.map((r) => r.pipelineId).filter((id): id is string => !!id);
}

async function resolveMessagePipelineIds(
  orgId: string,
  contactId: string | null,
  conversationId: string | null,
): Promise<string[]> {
  const key = cacheKey(orgId, contactId, conversationId);
  const cached = cachedPipelineIds(key);
  if (cached) return cached;
  const pipelineIds = await findMessagePipelineIds(orgId, contactId, conversationId);
  rememberPipelineIds(key, pipelineIds);
  return pipelineIds;
}

/** Fire-and-forget a partir de `sseBus.publish("new_message")`. */
export async function scheduleBoardInvalidationForMessage(
  orgId: string,
  data: unknown,
): Promise<void> {
  const rec =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};

  const explicitPipelineId = nonEmpty(rec.pipelineId);
  if (explicitPipelineId) {
    scheduleBoardInvalidation(orgId, explicitPipelineId);
    return;
  }

  const contactId = nonEmpty(rec.contactId);
  const conversationId = nonEmpty(rec.conversationId);
  if (!contactId && !conversationId) {
    scheduleBoardInvalidation(orgId);
    return;
  }

  let pipelineIds: string[];
  try {
    pipelineIds = await resolveMessagePipelineIds(orgId, contactId, conversationId);
  } catch {
    scheduleBoardInvalidation(orgId);
    return;
  }
  for (const pipelineId of pipelineIds) {
    scheduleBoardInvalidation(orgId, pipelineId);
  }
}
