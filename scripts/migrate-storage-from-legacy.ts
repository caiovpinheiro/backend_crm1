/**
 * Copia mídia do servidor antigo (volume /app/storage no 187 ou
 * STORAGE_FALLBACK_URL) para o driver ativo (Spaces).
 *
 * Depois do lote chegar a missing≈0:
 *   1. Remova STORAGE_FALLBACK_URL no EasyPanel
 *   2. Desligue banco-backend-crm / 187.127.27.39
 *
 * No container que AINDA tem o disco legado + credenciais S3:
 *   STORAGE_DRIVER=s3 npx tsx scripts/migrate-storage-from-legacy.ts
 *
 * Na API nova (só fallback HTTP):
 *   STORAGE_FALLBACK_URL=https://banco-backend-crm....easypanel.host \
 *   npx tsx scripts/migrate-storage-from-legacy.ts --no-disk --cookie '<cookie>'
 *
 *   --org <organizationId>   só uma org
 *   --dry-run
 *   --no-disk / --no-fallback
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
  const fromDisk = !process.argv.includes("--no-disk");
  const fromFallback = !process.argv.includes("--no-fallback");
  const cookie = getArg("--cookie") ?? process.env.STORAGE_FALLBACK_COOKIE ?? null;

  if (!process.env.DATABASE_URL) {
    console.error("Erro: DATABASE_URL não definida.");
    process.exit(1);
  }

  const { migrateStorageFromLegacy } = await import(
    "../src/lib/storage/migrate-from-legacy"
  );
  const { prismaBase } = await import("../src/lib/prisma-base");
  const { storageDriver } = await import("../src/lib/storage/local");
  const { storageFallbackConfigured } = await import(
    "../src/lib/storage/upstream-fallback"
  );

  console.log(
    JSON.stringify({
      mode: dryRun ? "dry-run" : "apply",
      driver: storageDriver(),
      fromDisk,
      fromFallback,
      fallbackConfigured: storageFallbackConfigured(),
      orgId: orgId ?? "all",
    }),
  );

  const result = await migrateStorageFromLegacy({
    orgId,
    dryRun,
    fromDisk,
    fromFallback,
    cookieHeader: cookie,
    onProgress: (done, total, last) => {
      if (done % 50 === 0 || done === total) {
        console.log(`[migrate-storage] ${done}/${total} ${last}`);
      }
    },
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.missing > 0) {
    console.warn(
      `\nAinda faltam ${result.missing} arquivo(s). Não desligue o 187.`,
    );
  } else if (!dryRun) {
    console.log(
      "\nLote ok. Remova STORAGE_FALLBACK_URL e desligue o host legado.",
    );
  }

  await prismaBase.$disconnect();
  if (result.errors > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
