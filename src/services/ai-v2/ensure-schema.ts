/**
 * Guarda de schema para funcionalidades v2.
 *
 * Como o deploy em DEV não aplica migrations automaticamente e a tabela pode
 * estar em um banco diferente do visto localmente, este helper garante
 * (de forma idempotente) que as colunas/tabelas usadas pela v2 existam
 * antes de executar operações que dependem delas.
 */

import { prisma } from "@/lib/prisma";

let checked = false;

export async function ensureV2AgentSchema(): Promise<void> {
  if (checked) return;
  if (process.env.NODE_ENV === "test") {
    checked = true;
    return;
  }

  try {
    const columnResult = await (prisma as any).$queryRawUnsafe<
      Array<{ exists: boolean }>
    >(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_configs' AND column_name = 'draft_config') AS exists`,
    );
    const hasDraftColumn = columnResult[0]?.exists === true;

    if (!hasDraftColumn) {
      await (prisma as any).$executeRawUnsafe(
        `ALTER TABLE "ai_agent_configs" ADD COLUMN IF NOT EXISTS "draft_config" JSONB`,
      );
    }

    const tableResult = await (prisma as any).$queryRawUnsafe<
      Array<{ exists: boolean }>
    >(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_agent_config_versions') AS exists`,
    );
    const hasVersionsTable = tableResult[0]?.exists === true;

    if (!hasVersionsTable) {
      await (prisma as any).$executeRawUnsafe(`
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
      await (prisma as any).$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_aiconfigversions_org ON "ai_agent_config_versions"("organizationId")`,
      );
      await (prisma as any).$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_aiconfigversions_agent_created ON "ai_agent_config_versions"("agentId", "createdAt")`,
      );
    }

    checked = true;
  } catch (err) {
    // Não quebra a requisição: se o schema já estiver OK, a operação segue.
    // Se não estiver, a operação vai falhar com o erro real do Prisma.
    console.error("[ai-v2] ensure schema failed", err);
  }
}
