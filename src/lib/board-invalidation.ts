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
 * Sem contato nem conversa no payload, ou com a consulta falhando, purga
 * todos os pipelines da org (comportamento anterior).
 *
 * prismaBase: `publish` roda em webhook/worker sem RequestContext; a org
 * vem do envelope e entra no WHERE.
 */
import { Prisma } from "@prisma/client";

import { scheduleBoardInvalidation } from "@/lib/cache/keys";
import { prismaBase } from "@/lib/prisma-base";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
    pipelineIds = await findMessagePipelineIds(orgId, contactId, conversationId);
  } catch {
    scheduleBoardInvalidation(orgId);
    return;
  }
  for (const pipelineId of pipelineIds) {
    scheduleBoardInvalidation(orgId, pipelineId);
  }
}
