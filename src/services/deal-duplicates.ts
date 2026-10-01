/**
 * Une negócios OPEN comerciais repetidos do mesmo contato dentro de um funil.
 *
 * O card que fica é o mais à frente na etapa (maior `stage.position`);
 * empate fica com o atualizado por último. Notas, tarefas, produtos e o
 * histórico passam para ele. Os outros saem do funil.
 */

import { Prisma } from "@prisma/client";

import { invalidateBoardData } from "@/lib/cache/keys";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";

const log = getLogger("deal-duplicates");

type UnifyClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

export async function pipelineForbidsDuplicateDeals(
  pipelineId: string,
): Promise<boolean> {
  try {
    const row = await prisma.pipeline.findUnique({
      where: { id: pipelineId },
      select: { allowDuplicateDeals: true },
    });
    return row?.allowDuplicateDeals === false;
  } catch (err) {
    log.warn({ err }, "leitura de allowDuplicateDeals falhou; duplicata segue permitida");
    return false;
  }
}

/**
 * Mensagem estável para o PUT do funil. O Prisma embrulha coluna ausente
 * (P2022) e falha de SQL (P2010) sem texto útil na resposta HTTP.
 */
export function duplicateDealsErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    code?: string;
    message?: string;
    meta?: { message?: string; column?: string };
  };
  if (e.code === "P2022" || /allowDuplicateDeals/i.test(e.message ?? "")) {
    return 'Falta a coluna allowDuplicateDeals em pipelines. Rode: ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "allowDuplicateDeals" BOOLEAN NOT NULL DEFAULT true;';
  }
  if (e.code === "P2010") {
    const detail = e.meta?.message || e.message || "erro de SQL";
    return `Não consegui unir os negócios repetidos. ${detail}`.slice(0, 600);
  }
  return null;
}

function duplicatePairsCte(orgId: string, pipelineId: string) {
  return Prisma.sql`
    WITH open_deals AS (
      SELECT
        d.id,
        d."contactId",
        d."updatedAt",
        d."createdAt",
        s.position AS stage_position
      FROM deals d
      JOIN stages s ON s.id = d."stageId"
      WHERE d."organizationId" = ${orgId}
        AND s."pipelineId" = ${pipelineId}
        AND d.status = 'OPEN'
        AND d."dealRole" = 'COMMERCIAL'
        AND d."contactId" IS NOT NULL
    ),
    ranked AS (
      SELECT
        id,
        "contactId",
        row_number() OVER (
          PARTITION BY "contactId"
          ORDER BY stage_position DESC, "updatedAt" DESC, "createdAt" ASC
        ) AS rn
      FROM open_deals
    ),
    _dup_pairs AS (
      SELECT r.id AS loser_id, k.id AS keeper_id
      FROM ranked r
      JOIN ranked k ON k."contactId" = r."contactId" AND k.rn = 1
      WHERE r.rn > 1
    )
  `;
}

/**
 * Apaga os OPEN comerciais repetidos do funil e devolve quantos saíram.
 * Roda na mesma transação de quem grava `allowDuplicateDeals = false`.
 *
 * Cada comando repete o CTE dos pares. Tabela temporária não serve aqui:
 * o Prisma manda o SQL como prepared statement, e o Postgres recusa
 * CREATE TEMP TABLE nesse protocolo — o PUT quebrava ao desligar a opção.
 */
export async function unifyDuplicateOpenDealsInPipeline(
  tx: UnifyClient,
  pipelineId: string,
): Promise<number> {
  const orgId = getOrgIdOrThrow();
  const cte = duplicatePairsCte(orgId, pipelineId);

  const counted = await tx.$queryRaw<Array<{ removed: number | bigint }>>`
    ${cte}
    SELECT count(*)::int AS removed FROM _dup_pairs
  `;
  const removed = Number(counted[0]?.removed ?? 0);
  if (!removed) return 0;

  await tx.$executeRaw`
    ${cte}
    INSERT INTO tags_on_deals ("dealId", "tagId")
    SELECT p.keeper_id, t."tagId"
    FROM tags_on_deals t
    JOIN _dup_pairs p ON p.loser_id = t."dealId"
    ON CONFLICT ("dealId", "tagId") DO NOTHING
  `;
  await tx.$executeRaw`
    ${cte}
    DELETE FROM tags_on_deals
    WHERE "dealId" IN (SELECT loser_id FROM _dup_pairs)
  `;

  await tx.$executeRaw`
    ${cte}
    DELETE FROM deal_custom_field_values v
    USING _dup_pairs p
    WHERE v."dealId" = p.loser_id
      AND EXISTS (
        SELECT 1 FROM deal_custom_field_values k
        WHERE k."dealId" = p.keeper_id
          AND k."customFieldId" = v."customFieldId"
      )
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE deal_custom_field_values v
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE v."dealId" = p.loser_id
  `;

  await tx.$executeRaw`
    ${cte}
    UPDATE deal_products dp
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE dp."dealId" = p.loser_id
  `;

  await tx.$executeRaw`
    ${cte}
    DELETE FROM deal_quotas q
    USING _dup_pairs p
    WHERE q."dealId" = p.loser_id
      AND EXISTS (
        SELECT 1 FROM deal_quotas k
        WHERE k."dealId" = p.keeper_id AND k."quotaId" = q."quotaId"
      )
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE deal_quotas q
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE q."dealId" = p.loser_id
  `;

  await tx.$executeRaw`
    ${cte}
    UPDATE quota_movements m
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE m."dealId" = p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE inventory_movements m
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE m."dealId" = p.loser_id
  `;

  await tx.$executeRaw`
    ${cte}
    DELETE FROM deal_links dl
    USING _dup_pairs p
    WHERE (dl."fromDealId" = p.loser_id AND dl."toDealId" = p.keeper_id)
       OR (dl."toDealId" = p.loser_id AND dl."fromDealId" = p.keeper_id)
       OR (
         dl."fromDealId" = p.loser_id
         AND dl."toDealId" IN (
           SELECT loser_id FROM _dup_pairs p2 WHERE p2.keeper_id = p.keeper_id
         )
       )
       OR (
         dl."toDealId" = p.loser_id
         AND dl."fromDealId" IN (
           SELECT loser_id FROM _dup_pairs p2 WHERE p2.keeper_id = p.keeper_id
         )
       )
  `;
  await tx.$executeRaw`
    ${cte}
    DELETE FROM deal_links dl
    USING _dup_pairs p, deal_links keep
    WHERE dl."fromDealId" = p.loser_id
      AND keep."fromDealId" = p.keeper_id
      AND keep."toDealId" = dl."toDealId"
      AND keep."linkType" = dl."linkType"
  `;
  await tx.$executeRaw`
    ${cte}
    DELETE FROM deal_links dl
    USING _dup_pairs p, deal_links keep
    WHERE dl."toDealId" = p.loser_id
      AND keep."toDealId" = p.keeper_id
      AND keep."fromDealId" = dl."fromDealId"
      AND keep."linkType" = dl."linkType"
  `;
  await tx.$executeRaw`
    ${cte}
    DELETE FROM deal_links
    WHERE id IN (
      SELECT id FROM (
        SELECT
          dl2.id,
          row_number() OVER (
            PARTITION BY p.keeper_id, dl2."toDealId", dl2."linkType"
            ORDER BY dl2."createdAt"
          ) AS rn
        FROM deal_links dl2
        JOIN _dup_pairs p ON p.loser_id = dl2."fromDealId"
      ) ranked
      WHERE ranked.rn > 1
    )
  `;
  await tx.$executeRaw`
    ${cte}
    DELETE FROM deal_links
    WHERE id IN (
      SELECT id FROM (
        SELECT
          dl2.id,
          row_number() OVER (
            PARTITION BY p.keeper_id, dl2."fromDealId", dl2."linkType"
            ORDER BY dl2."createdAt"
          ) AS rn
        FROM deal_links dl2
        JOIN _dup_pairs p ON p.loser_id = dl2."toDealId"
      ) ranked
      WHERE ranked.rn > 1
    )
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE deal_links dl
    SET "fromDealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE dl."fromDealId" = p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE deal_links dl
    SET "toDealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE dl."toDealId" = p.loser_id
  `;

  await tx.$executeRaw`
    ${cte}
    UPDATE deal_events e
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE e."dealId" = p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE activity_events e
    SET
      "dealId" = CASE WHEN e."dealId" = p.loser_id THEN p.keeper_id ELSE e."dealId" END,
      "entityId" = CASE
        WHEN e."entityType" = 'DEAL' AND e."entityId" = p.loser_id THEN p.keeper_id
        ELSE e."entityId"
      END
    FROM _dup_pairs p
    WHERE e."dealId" = p.loser_id
       OR (e."entityType" = 'DEAL' AND e."entityId" = p.loser_id)
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE activities a
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE a."dealId" = p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE notes n
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE n."dealId" = p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE calls c
    SET deal_id = p.keeper_id
    FROM _dup_pairs p
    WHERE c.deal_id = p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE automation_logs l
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE l."dealId" = p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE distribution_logs l
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE l."dealId" = p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE distribution_pending d
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE d."dealId" = p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE distribution_leads_assignments a
    SET
      "dealId" = CASE WHEN a."dealId" = p.loser_id THEN p.keeper_id ELSE a."dealId" END,
      "targetKey" = CASE
        WHEN a."targetKey" = 'deal:' || p.loser_id THEN 'deal:' || p.keeper_id
        ELSE a."targetKey"
      END
    FROM _dup_pairs p
    WHERE a."dealId" = p.loser_id
       OR a."targetKey" = 'deal:' || p.loser_id
  `;
  await tx.$executeRaw`
    ${cte}
    UPDATE ai_agent_survey_responses s
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE s."dealId" = p.loser_id
  `;

  await tx.$executeRaw`
    ${cte}
    UPDATE deals k
    SET
      value = GREATEST(k.value, sub.max_value),
      "ownerId" = COALESCE(k."ownerId", sub.owner_id)
    FROM (
      SELECT
        p.keeper_id,
        MAX(d.value) AS max_value,
        (
          ARRAY_AGG(d."ownerId" ORDER BY d."updatedAt" DESC)
          FILTER (WHERE d."ownerId" IS NOT NULL)
        )[1] AS owner_id
      FROM _dup_pairs p
      JOIN deals d ON d.id = p.loser_id
      GROUP BY p.keeper_id
    ) sub
    WHERE k.id = sub.keeper_id
  `;

  await tx.$executeRaw`
    ${cte}
    DELETE FROM deals
    WHERE id IN (SELECT loser_id FROM _dup_pairs)
      AND "organizationId" = ${orgId}
  `;

  return removed;
}

export async function invalidatePipelineBoard(pipelineId: string): Promise<void> {
  try {
    await invalidateBoardData(getOrgIdOrThrow(), pipelineId);
  } catch {
    /* fora de contexto — o TTL do board cobre */
  }
}
