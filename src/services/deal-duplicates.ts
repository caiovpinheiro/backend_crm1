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

const log = getLogger("deal-duplicates");

type UnifyClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

/**
 * Chave lógica da duplicata (já existente, não inventada):
 * organizationId + contactId + funil (`stage.pipelineId`) + OPEN + COMMERCIAL.
 * Quem fica: maior `stage.position`, depois `updatedAt` mais recente,
 * depois `createdAt` mais antigo.
 *
 * Locks, sempre nesta ordem (evita deadlock):
 * 1. funil `organizationId:pipelineId:open-commercial`
 *    — shared em toda criação OPEN comercial, exclusivo na unificação
 * 2. contato `organizationId:pipelineId:contactId:open-commercial`
 *    — exclusivo, só depois de reler `allowDuplicateDeals = false`
 * A flag é lida dentro do shared. A unificação espera esses shared,
 * então uma criação que entrou com o valor antigo ainda é limpa.
 */
export function openCommercialPipelineLockKey(organizationId: string, pipelineId: string): string {
  return `${organizationId}:${pipelineId}:open-commercial`;
}

export function openCommercialContactLockKey(
  organizationId: string,
  pipelineId: string,
  contactId: string,
): string {
  return `${organizationId}:${pipelineId}:${contactId}:open-commercial`;
}

/** A unificação segura o exclusivo por até 120s. A criação espera esse lock. */
export const OPEN_COMMERCIAL_CREATE_TX_MS = 150_000;

export async function lockOpenCommercialPipelineShared(
  tx: Pick<UnifyClient, "$executeRaw">,
  organizationId: string,
  pipelineId: string,
): Promise<void> {
  const pipelineKey = openCommercialPipelineLockKey(organizationId, pipelineId);
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock_shared(hashtextextended(${pipelineKey}, 0))
  `;
}

export async function lockOpenCommercialContactExclusive(
  tx: Pick<UnifyClient, "$executeRaw">,
  organizationId: string,
  pipelineId: string,
  contactId: string,
): Promise<void> {
  const contactKey = openCommercialContactLockKey(organizationId, pipelineId, contactId);
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${contactKey}, 0))
  `;
}

/** Shared do funil e, em seguida, exclusivo do contato. */
export async function lockOpenCommercialDealCreate(
  tx: Pick<UnifyClient, "$executeRaw">,
  organizationId: string,
  pipelineId: string,
  contactId: string,
): Promise<void> {
  await lockOpenCommercialPipelineShared(tx, organizationId, pipelineId);
  await lockOpenCommercialContactExclusive(tx, organizationId, pipelineId, contactId);
}

export async function lockOpenCommercialDealUnify(
  tx: Pick<UnifyClient, "$executeRaw">,
  organizationId: string,
  pipelineId: string,
): Promise<void> {
  const pipelineKey = openCommercialPipelineLockKey(organizationId, pipelineId);
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${pipelineKey}, 0))
  `;
}

export async function pipelineForbidsDuplicateDeals(
  pipelineId: string,
  db: Pick<typeof prisma, "pipeline"> = prisma,
): Promise<boolean> {
  try {
    const row = await db.pipeline.findUnique({
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
function flattenError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i += 1) {
    const e = cur as {
      code?: string;
      message?: string;
      meta?: { message?: string; code?: string };
      cause?: unknown;
    };
    if (e.code) parts.push(String(e.code));
    if (e.meta?.code) parts.push(String(e.meta.code));
    if (typeof e.meta?.message === "string" && e.meta.message.trim()) {
      parts.push(e.meta.message.trim());
    }
    if (typeof e.message === "string" && e.message.trim()) parts.push(e.message.trim());
    cur = e.cause;
  }
  return parts.join(" | ").slice(0, 700);
}

export function duplicateDealsErrorMessage(err: unknown): string | null {
  const text = flattenError(err);
  if (!text) return null;
  if (/allowDuplicateDeals/i.test(text)) {
    return 'Falta a coluna allowDuplicateDeals em pipelines. Rode: ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "allowDuplicateDeals" BOOLEAN NOT NULL DEFAULT true;';
  }
  return text;
}

type DuplicatePair = { loserId: string; keeperId: string };

async function runFrozenPairsSql(
  tx: UnifyClient,
  pairs: DuplicatePair[],
  statement: string,
) {
  const loserIds = pairs.map((p) => p.loserId);
  const keeperIds = pairs.map((p) => p.keeperId);
  await tx.$executeRaw`
    WITH _dup_pairs AS (
      SELECT loser_id, keeper_id
      FROM unnest(${loserIds}::text[], ${keeperIds}::text[]) AS t(loser_id, keeper_id)
    )
    ${Prisma.raw(statement)}
  `;
}

/**
 * Apaga os OPEN comerciais repetidos do funil e devolve quantos saíram.
 * Roda na mesma transação de quem grava `allowDuplicateDeals = false`.
 *
 * Cada comando repete o CTE dos pares no mesmo prepared statement.
 * Fragmento Prisma.sql aninhado e CREATE TEMP TABLE quebram nesse protocolo.
 */
export async function unifyDuplicateOpenDealsInPipeline(
  tx: UnifyClient,
  pipelineId: string,
  organizationId: string,
): Promise<number> {
  const orgId = organizationId;
  await lockOpenCommercialDealUnify(tx, orgId, pipelineId);
  await tx.$executeRaw`
    SELECT d.id
    FROM deals d
    JOIN stages s ON s.id = d."stageId"
    WHERE d."organizationId" = ${orgId}
      AND s."pipelineId" = ${pipelineId}
      AND d.status = 'OPEN'::"DealStatus"
      AND d."dealRole" = 'COMMERCIAL'::"DealRole"
      AND d."contactId" IS NOT NULL
      AND d."intentionalDuplicate" = false
    ORDER BY d.id
    FOR UPDATE OF d
  `;

  const rows = await tx.$queryRaw<Array<{ loser_id: string; keeper_id: string }>>`
    WITH open_deals AS (
      SELECT
        d.id,
        d."contactId",
        s.position AS stage_position,
        d."updatedAt",
        d."createdAt"
      FROM deals d
      JOIN stages s ON s.id = d."stageId"
      WHERE d."organizationId" = ${orgId}
        AND s."pipelineId" = ${pipelineId}
        AND d.status = 'OPEN'::"DealStatus"
        AND d."dealRole" = 'COMMERCIAL'::"DealRole"
        AND d."contactId" IS NOT NULL
        AND d."intentionalDuplicate" = false
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
    )
    SELECT r.id AS loser_id, k.id AS keeper_id
    FROM ranked r
    JOIN ranked k ON k."contactId" = r."contactId" AND k.rn = 1
    WHERE r.rn > 1
  `;
  const pairs: DuplicatePair[] = rows.map((row) => ({
    loserId: row.loser_id,
    keeperId: row.keeper_id,
  }));
  if (pairs.length === 0) return 0;

  const run = (statement: string) => runFrozenPairsSql(tx, pairs, statement);

  await run(`
    INSERT INTO tags_on_deals ("dealId", "tagId")
    SELECT p.keeper_id, t."tagId"
    FROM tags_on_deals t
    JOIN _dup_pairs p ON p.loser_id = t."dealId"
    ON CONFLICT ("dealId", "tagId") DO NOTHING
  `);
  await run(`
    DELETE FROM tags_on_deals
    WHERE "dealId" IN (SELECT loser_id FROM _dup_pairs)
  `);

  await run(`
    DELETE FROM deal_custom_field_values v
    USING _dup_pairs p
    WHERE v."dealId" = p.loser_id
      AND EXISTS (
        SELECT 1 FROM deal_custom_field_values k
        WHERE k."dealId" = p.keeper_id
          AND k."customFieldId" = v."customFieldId"
      )
  `);
  await run(`
    DELETE FROM deal_custom_field_values
    WHERE id IN (
      SELECT id FROM (
        SELECT
          v2.id,
          row_number() OVER (
            PARTITION BY p.keeper_id, v2."customFieldId"
            ORDER BY (CASE WHEN btrim(v2.value) = '' THEN 1 ELSE 0 END), v2.id
          ) AS rn
        FROM deal_custom_field_values v2
        JOIN _dup_pairs p ON p.loser_id = v2."dealId"
      ) ranked
      WHERE ranked.rn > 1
    )
  `);
  await run(`
    UPDATE deal_custom_field_values v
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE v."dealId" = p.loser_id
  `);

  await run(`
    UPDATE deal_products dp
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE dp."dealId" = p.loser_id
  `);

  await run(`
    DELETE FROM deal_quotas q
    USING _dup_pairs p
    WHERE q."dealId" = p.loser_id
      AND EXISTS (
        SELECT 1 FROM deal_quotas k
        WHERE k."dealId" = p.keeper_id AND k."quotaId" = q."quotaId"
      )
  `);
  await run(`
    DELETE FROM deal_quotas
    WHERE id IN (
      SELECT id FROM (
        SELECT
          q2.id,
          row_number() OVER (
            PARTITION BY p.keeper_id, q2."quotaId"
            ORDER BY q2.id
          ) AS rn
        FROM deal_quotas q2
        JOIN _dup_pairs p ON p.loser_id = q2."dealId"
      ) ranked
      WHERE ranked.rn > 1
    )
  `);
  await run(`
    UPDATE deal_quotas q
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE q."dealId" = p.loser_id
  `);

  await run(`
    UPDATE quota_movements m
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE m."dealId" = p.loser_id
  `);
  await run(`
    UPDATE inventory_movements m
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE m."dealId" = p.loser_id
  `);

  await run(`
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
  `);
  await run(`
    DELETE FROM deal_links dl
    USING _dup_pairs p, deal_links keep
    WHERE dl."fromDealId" = p.loser_id
      AND keep."fromDealId" = p.keeper_id
      AND keep."toDealId" = dl."toDealId"
      AND keep."linkType" = dl."linkType"
  `);
  await run(`
    DELETE FROM deal_links dl
    USING _dup_pairs p, deal_links keep
    WHERE dl."toDealId" = p.loser_id
      AND keep."toDealId" = p.keeper_id
      AND keep."fromDealId" = dl."fromDealId"
      AND keep."linkType" = dl."linkType"
  `);
  await run(`
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
  `);
  await run(`
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
  `);
  await run(`
    UPDATE deal_links dl
    SET "fromDealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE dl."fromDealId" = p.loser_id
  `);
  await run(`
    UPDATE deal_links dl
    SET "toDealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE dl."toDealId" = p.loser_id
  `);

  await run(`
    UPDATE deal_events e
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE e."dealId" = p.loser_id
  `);
  await run(`
    UPDATE activity_events e
    SET
      "dealId" = CASE WHEN e."dealId" = p.loser_id THEN p.keeper_id ELSE e."dealId" END,
      "entityId" = CASE
        WHEN e."entityType" = 'DEAL'::"EventEntityType" AND e."entityId" = p.loser_id THEN p.keeper_id
        ELSE e."entityId"
      END
    FROM _dup_pairs p
    WHERE e."dealId" = p.loser_id
       OR (e."entityType" = 'DEAL'::"EventEntityType" AND e."entityId" = p.loser_id)
  `);
  await run(`
    UPDATE activities a
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE a."dealId" = p.loser_id
  `);
  await run(`
    UPDATE notes n
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE n."dealId" = p.loser_id
  `);
  await run(`
    UPDATE calls c
    SET deal_id = p.keeper_id
    FROM _dup_pairs p
    WHERE c.deal_id = p.loser_id
  `);
  await run(`
    UPDATE automation_logs l
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE l."dealId" = p.loser_id
  `);
  await run(`
    UPDATE distribution_logs l
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE l."dealId" = p.loser_id
  `);
  await run(`
    UPDATE distribution_pending d
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE d."dealId" = p.loser_id
  `);
  await run(`
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
  `);
  await run(`
    UPDATE ai_agent_survey_responses s
    SET "dealId" = p.keeper_id
    FROM _dup_pairs p
    WHERE s."dealId" = p.loser_id
  `);

  await run(`
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
  `);

  await run(`
    DELETE FROM deals
    WHERE id IN (SELECT loser_id FROM _dup_pairs)
  `);

  return pairs.length;
}

export async function invalidatePipelineBoard(
  pipelineId: string,
  organizationId: string,
): Promise<void> {
  try {
    await invalidateBoardData(organizationId, pipelineId);
  } catch {
    /* fora de contexto — o TTL do board cobre */
  }
}
