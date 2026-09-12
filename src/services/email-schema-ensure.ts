import { Prisma } from "@prisma/client";

import { prismaBase } from "@/lib/prisma-base";

/**
 * Auto-cura da migration `20260912133000_email_outlook_rules`.
 *
 * Produção sobe com `SKIP_PRISMA_MIGRATE=1`. O Prisma Client passa a
 * selecionar `auto_handled` / `ooo_*` / `action_*` sem as colunas
 * existirem → P2022 no GET `/api/emails` (a caixa mostra
 * "Erro ao listar e-mails") e no GET `/api/email-accounts`.
 * `ADD COLUMN IF NOT EXISTS` é idempotente; uma tentativa por processo.
 */
let outlookColumnsEnsured = false;

export function isMissingEmailOutlookColumn(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2022") {
    const col = String((error.meta as { column?: string } | undefined)?.column ?? "");
    if (!col || /auto_handled|ooo_|action_target|action_body/i.test(col)) return true;
  }
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    (msg.includes("does not exist") || msg.includes("column")) &&
    /auto_handled|ooo_enabled|ooo_message|ooo_starts_at|ooo_ends_at|action_target|action_body/.test(
      msg,
    )
  );
}

export async function ensureEmailOutlookColumns(): Promise<boolean> {
  if (outlookColumnsEnsured) return true;
  try {
    await prismaBase.$executeRawUnsafe(`
      ALTER TABLE "email_rules"
        ADD COLUMN IF NOT EXISTS "action_target" TEXT,
        ADD COLUMN IF NOT EXISTS "action_body" TEXT
    `);
    await prismaBase.$executeRawUnsafe(`
      ALTER TABLE "email_accounts"
        ADD COLUMN IF NOT EXISTS "ooo_enabled" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "ooo_message" TEXT,
        ADD COLUMN IF NOT EXISTS "ooo_starts_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "ooo_ends_at" TIMESTAMP(3)
    `);
    await prismaBase.$executeRawUnsafe(`
      ALTER TABLE "emails"
        ADD COLUMN IF NOT EXISTS "auto_handled" BOOLEAN NOT NULL DEFAULT false
    `);
    outlookColumnsEnsured = true;
    return true;
  } catch (e) {
    console.warn(
      "[email] falha ao aplicar colunas Outlook (DDL):",
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}
