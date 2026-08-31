/**
 * Repara mídias de modelos (message_templates + quick_replies) cujo objeto
 * sumiu do driver ativo (Spaces). Tenta recuperar bytes da mesma org:
 *   - outros buckets de reuse + alias jpg/jpeg + ListObjects do stem
 *   - STORAGE_ROOT local e public/uploads
 *   - STORAGE_FALLBACK_URL GET (700ms)
 *
 * Defina STORAGE_FALLBACK_URL TEMPORARIAMENTE no EasyPanel se os arquivos
 * ainda estão no host legado `banco-backend-crm.6tqx2r.easypanel.host`
 * ou no volume antigo da API. Só esse host (env) é chamado — nunca a URL
 * crua do modelo (SSRF). Remova a env depois do repair.
 *
 * Não inventa arquivos. Não enfraquece o send-by-reference.
 *
 * Uso (no container da API):
 *   npx tsx scripts/repair-template-media.ts --org <organizationId>
 *   npx tsx scripts/repair-template-media.ts --org <organizationId> --dry-run
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const orgId = getArg("--org");
  const dryRun = process.argv.includes("--dry-run");

  if (!orgId) {
    console.error("Erro: informe --org <organizationId>.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("Erro: DATABASE_URL não definida.");
    process.exit(1);
  }

  const { repairOrgTemplateMedia } = await import(
    "../src/lib/storage/repair-template-media"
  );
  const { prismaBase } = await import("../src/lib/prisma-base");

  const result = await repairOrgTemplateMedia({ orgId, dryRun });

  const names = (rows: { name: string; fileName?: string }[]) =>
    rows.map((r) => (r.fileName ? `${r.name} (${r.fileName})` : r.name));

  console.log(dryRun ? "[dry-run]" : "[apply]");
  console.log(
    JSON.stringify(
      {
        repaired: names(result.repaired),
        missing: names(result.missing),
        skipped: result.skipped.map((s) => `${s.name} [${s.reason}]`),
        fallbackConfigured: result.fallbackConfigured,
      },
      null,
      2,
    ),
  );

  if (result.missing.length) {
    console.warn(
      `\nAinda faltam ${result.missing.length} arquivo(s). Reenvie só esses modelos:`,
    );
    for (const row of result.missing) {
      console.warn(`  - ${row.name} (${row.fileName})`);
    }
  }

  await prismaBase.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
