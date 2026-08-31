import type { Job } from "bullmq";

import {
  buildCustomFieldHeaderMap,
  processContactRow,
  validateContactImportHeaders,
  type ContactImportOptions,
} from "@/lib/contact-import-core";
import { readTableFromBuffer, upsertImportTag } from "@/lib/import-helpers";
import { getLogger } from "@/lib/logger";
import { prismaImport } from "@/lib/prisma-import";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { getCustomFields } from "@/services/custom-fields";
import { readStoredFile } from "@/lib/storage/local";
import {
  enqueueImportEtl,
  IMPORT_ETL_JOB_NAMES,
  type ContactImportPayload,
} from "@/lib/queue";

import {
  incrementOperationProgress,
  isOperationCancelled,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  type BulkOperationErrorEntry,
} from "@/jobs/leads/_update-progress";

const log = getLogger("worker.etl.contact-import");

/** Linhas processadas por lote antes de atualizar o progresso no Postgres. */
const CHUNK_SIZE = 50;

/**
 * Fatia de linhas que um sub-job processa antes de re-enfileirar a próxima
 * (justiça entre tenants — ver deals-import.job.ts). Override via IMPORT_SLICE.
 */
const IMPORT_SLICE = (() => {
  const raw = process.env.IMPORT_SLICE;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
})();

/**
 * M7 — pausa (ms) entre chunks para aliviar o Postgres compartilhado durante
 * cargas em massa. Opt-in via `IMPORT_CHUNK_SLEEP_MS` (default 0 = sem pausa,
 * preserva throughput histórico). Recomendado 50-100ms em prod multi-tenant.
 */
function chunkSleepMs(): number {
  const raw = process.env.IMPORT_CHUNK_SLEEP_MS;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handler do job `contact-import` da fila `import-etl`.
 *
 * Roda dentro de `withSystemContext(organizationId)` (configurado pelo
 * etl-worker), então `prisma` scoped e `getOrgIdOrThrow()` funcionam. Lê o
 * arquivo do bucket `imports` no volume compartilhado e processa linha a linha,
 * atualizando o `BulkOperation` em lotes para o frontend acompanhar via polling.
 */
export async function processContactImport(
  payload: ContactImportPayload,
  job: Job<ContactImportPayload>,
): Promise<void> {
  const { operationId, organizationId, fileName, originalName } = payload;
  const offset = payload.offset ?? 0;
  const isFirstSlice = offset === 0;
  const ctx = log.child({ operationId, organizationId, jobId: job.id, offset });

  // Só a primeira fatia marca o início; as seguintes continuam o progresso.
  if (isFirstSlice) {
    await markOperationStarted(operationId, organizationId);
  }

  // 1. Obtém o conteúdo do arquivo. Preferência: base64 embutido no
  // BulkOperation.payload (banco já compartilhado entre backend e worker) —
  // assim não dependemos de storage compartilhado entre containers. Fallback:
  // lê do disco (legado, quando o volume é compartilhado).
  let fileBuffer: Buffer | null = null;
  try {
    const op = await prismaImport.bulkOperation.findUnique({
      where: { id: operationId },
      select: { payload: true },
    });
    const opPayload = (op?.payload ?? null) as { fileContentB64?: unknown } | null;
    const b64 =
      typeof opPayload?.fileContentB64 === "string" ? opPayload.fileContentB64 : null;
    if (b64) fileBuffer = Buffer.from(b64, "base64");
  } catch (err) {
    ctx.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Falha ao ler conteúdo embutido — tentando storage em disco",
    );
  }

  if (!fileBuffer) {
    const stored = await readStoredFile(organizationId, "imports", fileName);
    if (stored) fileBuffer = stored.buffer;
  }

  if (!fileBuffer) {
    await markOperationFailed(
      operationId,
      organizationId,
      `Conteúdo da importação não encontrado (nem embutido no banco nem no storage: imports/${fileName}).`,
    );
    ctx.error("Conteúdo do arquivo não encontrado — abortando");
    return;
  }

  // 2. Parseia (CSV/XLSX).
  let headers: string[];
  let rows: Record<string, string>[];
  try {
    const parsed = await readTableFromBuffer(
      fileBuffer,
      originalName,
      payload.delimiter,
    );
    headers = parsed.headers;
    rows = parsed.rows;
  } catch (err) {
    await markOperationFailed(
      operationId,
      organizationId,
      `Falha ao ler o arquivo: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const headerError = validateContactImportHeaders(headers);
  if (headerError) {
    await markOperationFailed(operationId, organizationId, headerError);
    return;
  }

  // 3. Tag opcional (uma vez, fora do loop).
  let importTagId: string | null = null;
  if (payload.tagName) {
    try {
      importTagId = await upsertImportTag(getOrgIdOrThrow(), payload.tagName);
    } catch {
      importTagId = null;
    }
  }

  // Campos personalizados: casa colunas do arquivo com CustomFields (entity
  // "contact") existentes e grava os valores. Colunas sem campo correspondente
  // são ignoradas silenciosamente (comportamento padrão de import).
  let customFieldHeaderMap: Map<string, string> | undefined;
  try {
    const defs = (await getCustomFields("contact")) as Array<{
      id: string;
      name: string;
      label?: string | null;
    }>;
    const map = buildCustomFieldHeaderMap(headers, defs);
    if (map.size > 0) {
      customFieldHeaderMap = map;
      ctx.info(
        { mappedCustomFields: [...map.keys()] },
        "Campos personalizados mapeados na importação",
      );
    }
  } catch (err) {
    ctx.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Falha ao carregar campos personalizados — seguindo só com campos padrão",
    );
  }

  const opts: ContactImportOptions = {
    updateExisting: payload.updateExisting,
    importTagId,
    customFieldHeaderMap,
  };

  // 4. Processa em lotes, atualizando progresso a cada chunk.
  let chunkProcessed = 0;
  let chunkSucceeded = 0;
  let chunkFailed = 0;
  let chunkErrors: BulkOperationErrorEntry[] = [];

  const flush = async () => {
    if (chunkProcessed === 0) return;
    await incrementOperationProgress(
      operationId,
      organizationId,
      {
        processed: chunkProcessed,
        succeeded: chunkSucceeded,
        failed: chunkFailed,
      },
      chunkErrors,
    );
    chunkProcessed = 0;
    chunkSucceeded = 0;
    chunkFailed = 0;
    chunkErrors = [];
  };

  // Processa APENAS a fatia [offset, offset+IMPORT_SLICE). Se houver mais
  // linhas, re-enfileira a próxima fatia no fim da fila ao final.
  const sliceEnd = Math.min(offset + IMPORT_SLICE, rows.length);
  for (let i = offset; i < sliceEnd; i++) {
    const rowNumber = i + 2; // +1 cabeçalho, +1 base-1
    let result;
    try {
      result = await processContactRow(headers, rows[i], opts);
    } catch (err) {
      result = {
        status: "failed" as const,
        message: err instanceof Error ? err.message : "Erro inesperado na linha.",
      };
    }

    chunkProcessed += 1;
    if (result.status === "failed") {
      chunkFailed += 1;
      chunkErrors.push({
        itemId: `row-${rowNumber}`,
        message: result.message.slice(0, 500),
        attempt: job.attemptsMade + 1,
        at: new Date().toISOString(),
      });
    } else {
      chunkSucceeded += 1;
    }

    if (chunkProcessed >= CHUNK_SIZE) {
      await flush();
      if (await isOperationCancelled(operationId, organizationId)) {
        ctx.info("Importação cancelada — interrompendo fatia");
        return;
      }
      const pause = chunkSleepMs();
      if (pause > 0) await sleep(pause);
    }
  }

  await flush();

  if (await isOperationCancelled(operationId, organizationId)) {
    ctx.info("Importação cancelada — não re-enfileira a próxima fatia");
    return;
  }

  // Há mais linhas? Re-enfileira a próxima fatia no FIM da fila, cedendo o
  // slot à próxima org. A próxima fatia re-parseia e continua do offset.
  if (sliceEnd < rows.length) {
    const enqueued = await enqueueImportEtl(IMPORT_ETL_JOB_NAMES.contactImport, {
      ...payload,
      offset: sliceEnd,
    });
    if (!enqueued) {
      await markOperationFailed(
        operationId,
        organizationId,
        "Redis indisponível ao re-enfileirar a próxima fatia do import.",
      );
      return;
    }
    ctx.info(
      { processedUpTo: sliceEnd, totalRows: rows.length },
      "Fatia de contatos concluída — próxima fatia enfileirada",
    );
    return;
  }

  await markOperationFinished(operationId, organizationId);

  ctx.info({ totalRows: rows.length }, "Importação de contatos concluída");
}
