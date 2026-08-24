/**
 * Rede de segurança da distribuição.
 *
 * O aluno escreveu, a IA é a responsável e ninguém respondeu. Cobre falha
 * de LLM/chave, canal fora do ar e qualquer caminho em que o agente fica
 * em silêncio — sem isso o lead fica preso na IA e nunca chega a humano.
 *
 * Override: `AI_AGENT_STUCK_INBOUND_MS` (0 desliga).
 */

import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { executeAcademicDepartmentHandoff } from "@/services/ai/academic-department-routing";

export const STUCK_INBOUND_MS = 15 * 60 * 1000;

const BATCH_SIZE = 50;

type StuckRow = {
  conversation_id: string;
  contact_id: string;
  organization_id: string;
  last_inbound_at: Date;
};

async function listStuckInbound(
  now: Date,
  stuckMs: number,
): Promise<StuckRow[]> {
  return prismaBase.$queryRaw<StuckRow[]>`
    SELECT
      c.id AS conversation_id,
      c."contactId" AS contact_id,
      c."organizationId" AS organization_id,
      c."lastInboundAt" AS last_inbound_at
    FROM "conversations" c
    JOIN "users" u ON u.id = c."assignedToId"
    JOIN "ai_agent_configs" a ON a."userId" = u.id
    WHERE u.type = 'AI'
      AND a.active = true
      AND c.status = 'OPEN'
      AND c."hasHumanReply" = false
      AND c."contactId" IS NOT NULL
      AND c."lastInboundAt" IS NOT NULL
      AND c."lastInboundAt" < (${now}::timestamptz - ((${stuckMs})::text || ' milliseconds')::interval)
      -- Ninguém respondeu depois da última mensagem do aluno.
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m."conversationId" = c.id
          AND m.direction = 'out'
          AND COALESCE(m."isPrivate", false) = false
          AND m."messageType" <> 'note'
          AND m."createdAt" > c."lastInboundAt"
      )
      -- Já está na fila de espera: a drenagem cuida.
      AND NOT EXISTS (
        SELECT 1 FROM distribution_pending dp
        WHERE dp.status = 'PENDING'
          AND (dp."conversationId" = c.id OR dp."contactId" = c."contactId")
      )
    ORDER BY c."lastInboundAt" ASC
    LIMIT ${BATCH_SIZE};
  `;
}

export async function distributeStuckInbound(
  now: Date = new Date(),
  stuckMs: number = STUCK_INBOUND_MS,
): Promise<{ distributed: number }> {
  if (stuckMs <= 0) return { distributed: 0 };

  const rows = await listStuckInbound(now, stuckMs);
  let distributed = 0;

  for (const row of rows) {
    const idleMin = Math.round(
      (now.getTime() - new Date(row.last_inbound_at).getTime()) / 60_000,
    );
    try {
      await withSystemContext(row.organization_id, () =>
        executeAcademicDepartmentHandoff({
          conversationId: row.conversation_id,
          contactId: row.contact_id,
          reason: `IA sem responder há ${idleMin} min — distribuição de segurança`,
        }),
      );
      distributed++;
    } catch (err) {
      console.error(
        `[ai-stuck-inbound] falha conv=${row.conversation_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (distributed > 0) {
    console.info(
      `[ai-stuck-inbound] distribuídas=${distributed} de ${rows.length} candidatas`,
    );
  }
  return { distributed };
}
