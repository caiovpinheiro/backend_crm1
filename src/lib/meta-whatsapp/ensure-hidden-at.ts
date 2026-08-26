import { Prisma } from "@prisma/client";

import { prismaBase } from "@/lib/prisma-base";

/**
 * Auto-cura da migration `20260826150000_template_hidden_at`.
 *
 * Produção sobe com `SKIP_PRISMA_MIGRATE=1`, então o Prisma Client passa a
 * selecionar `hidden_at` sem a coluna existir → P2022 em 100% das orgs no
 * GET `/api/whatsapp-template-configs/agent-enabled` (inbox não lista
 * templates). `ADD COLUMN IF NOT EXISTS` é idempotente; uma tentativa por
 * processo.
 */
let hiddenAtColumnEnsured = false;

export function isMissingHiddenAtColumn(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2022") {
    const col = String((error.meta as { column?: string } | undefined)?.column ?? "");
    if (!col || /hidden_at/i.test(col)) return true;
  }
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  return msg.includes("hidden_at") && msg.includes("does not exist");
}

export async function ensureWhatsappTemplateHiddenAtColumn(): Promise<boolean> {
  if (hiddenAtColumnEnsured) return true;
  try {
    await prismaBase.$executeRawUnsafe(
      `ALTER TABLE "whatsapp_template_configs" ADD COLUMN IF NOT EXISTS "hidden_at" TIMESTAMP(3)`,
    );
    await prismaBase.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "whatsapp_template_configs_organizationId_hidden_at_idx" ON "whatsapp_template_configs" ("organizationId", "hidden_at")`,
    );
    hiddenAtColumnEnsured = true;
    return true;
  } catch (e) {
    console.warn(
      "[whatsapp-template-config] falha ao aplicar hidden_at (DDL):",
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}
