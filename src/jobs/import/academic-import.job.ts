import type { Job } from "bullmq";

import { getLogger } from "@/lib/logger";
import type { ContactImportPayload } from "@/lib/queue";
import { readStoredFile } from "@/lib/storage/local";
import { importMatriculados } from "@/services/academic-records";

import {
  incrementOperationProgress,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
} from "@/jobs/leads/_update-progress";

const log = getLogger("worker.etl.academic-import");

/**
 * Job `academic-import`: substitui a base de matriculados da org.
 * Roda no etl-worker (fora da API) — parse + deleteMany + createMany.
 */
export async function processAcademicImport(
  payload: ContactImportPayload,
  job: Job<ContactImportPayload>,
): Promise<void> {
  const { operationId, organizationId, fileName, originalName, initiatedByUserId } =
    payload;
  const ctx = log.child({ operationId, organizationId, jobId: job.id });

  await markOperationStarted(operationId, organizationId);

  try {
    const stored = await readStoredFile(organizationId, "imports", fileName);
    if (!stored) {
      await markOperationFailed(
        operationId,
        organizationId,
        `Arquivo não encontrado: imports/${fileName}`,
      );
      return;
    }

    const result = await importMatriculados({
      organizationId,
      buffer: stored.buffer,
      fileName: originalName || fileName,
      uploadedById: initiatedByUserId,
    });

    await incrementOperationProgress(operationId, organizationId, {
      processed: result.totalRows + result.skipped,
      succeeded: result.totalRows,
      failed: result.skipped,
    });
    await markOperationFinished(operationId, organizationId);
    ctx.info(
      { totalRows: result.totalRows, skipped: result.skipped },
      "academic import done",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.error({ err: msg }, "academic import failed");
    await markOperationFailed(operationId, organizationId, msg);
    throw err;
  }
}
