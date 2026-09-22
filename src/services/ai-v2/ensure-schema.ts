/**
 * Guarda de schema para funcionalidades v2.
 *
 * Como o deploy em DEV não aplica migrations automaticamente e a tabela pode
 * estar em um banco diferente do visto localmente, este helper garante
 * (de forma idempotente) que as colunas/tabelas usadas pela v2 existam
 * antes de executar operações que dependem delas.
 */

import { prismaBase } from "@/lib/prisma-base";

let checked = false;

export async function ensureV2AgentSchema(): Promise<void> {
  if (checked) return;
  if (process.env.NODE_ENV === "test") {
    checked = true;
    return;
  }

  const needs: string[] = [];

  const db = prismaBase as unknown as {
    $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  };

  const columnResult = await db.$queryRawUnsafe<
    Array<{ exists: boolean }>
  >(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_configs' AND column_name = 'draft_config') AS exists`,
  );
  const hasDraftColumn = columnResult[0]?.exists === true;
  if (!hasDraftColumn) needs.push("draft_config column");

  const tableResult = await db.$queryRawUnsafe<
    Array<{ exists: boolean }>
  >(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_agent_config_versions') AS exists`,
  );
  const hasVersionsTable = tableResult[0]?.exists === true;
  if (!hasVersionsTable) needs.push("ai_agent_config_versions table");

  if (needs.length === 0) {
    checked = true;
    return;
  }

  console.log("[ai-v2] schema guard: creating missing", needs.join(", "));

  await (prismaBase as any).$executeRawUnsafe(
    `ALTER TABLE "ai_agent_configs" ADD COLUMN IF NOT EXISTS "draft_config" JSONB`,
  );
  await (prismaBase as any).$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_agent_config_versions" (
      "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "version_number" INTEGER NOT NULL,
      "config" JSONB NOT NULL,
      "comment" TEXT,
      "created_by_id" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("agentId", "version_number")
    )
  `);
  await (prismaBase as any).$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_aiconfigversions_org ON "ai_agent_config_versions"("organizationId")`,
  );
  await (prismaBase as any).$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_aiconfigversions_agent_created ON "ai_agent_config_versions"("agentId", "createdAt")`,
  );

  checked = true;
}
