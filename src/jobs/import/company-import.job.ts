import type { Job } from "bullmq";

import { type CsvDelimiter } from "@/lib/csv-parse";
import { readTableFromBuffer } from "@/lib/import-helpers";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import type { ContactImportPayload } from "@/lib/queue";
import { readStoredFile } from "@/lib/storage/local";
import { createCompany, updateCompany } from "@/services/companies";

import {
  incrementOperationProgress,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  type BulkOperationErrorEntry,
} from "@/jobs/leads/_update-progress";

const log = getLogger("worker.etl.company-import");

const KEY_ALIASES: Record<string, string> = {
  nome: "name",
  name: "name",
  dominio: "domain",
  domain: "domain",
  website: "domain",
  site: "domain",
  setor: "industry",
  industria: "industry",
  industry: "industry",
  porte: "size",
  size: "size",
  telefone: "phone",
  phone: "phone",
  endereco: "address",
  address: "address",
  cep: "cep",
  cidade: "city",
  city: "city",
  estado: "state",
  uf: "state",
  state: "state",
  notas: "notes",
  notes: "notes",
  observacoes: "notes",
};

function norm(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function cell(row: Record<string, string>, key: string): string {
  return (row[key] ?? "").trim();
}

const CHUNK = 50;

/**
 * Job `company-import`: upsert de empresas a partir de CSV/XLSX no storage.
 */
export async function processCompanyImport(
  payload: ContactImportPayload,
  job: Job<ContactImportPayload>,
): Promise<void> {
  const { operationId, organizationId, fileName, originalName, updateExisting } =
    payload;
  const delimiter = payload.delimiter as CsvDelimiter | undefined;
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

    const { headers, rows } = await readTableFromBuffer(
      stored.buffer,
      originalName || fileName,
      delimiter,
    );

    const headerMap = new Map<string, string>();
    for (const h of headers) {
      const key = KEY_ALIASES[norm(h)] ?? KEY_ALIASES[h] ?? h;
      headerMap.set(h, key);
    }

    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      let succeeded = 0;
      let failed = 0;
      const errors: BulkOperationErrorEntry[] = [];

      for (let j = 0; j < slice.length; j++) {
        const raw = slice[j]!;
        const mapped: Record<string, string> = {};
        for (const [src, dest] of headerMap) {
          mapped[dest] = (raw[src] ?? "").trim();
        }
        const name = cell(mapped, "name");
        const rowNum = i + j + 2;
        if (!name) {
          failed += 1;
          errors.push({
            itemId: String(rowNum),
            message: "Nome é obrigatório.",
            attempt: job.attemptsMade,
            at: new Date().toISOString(),
          });
          continue;
        }
        try {
          const existing = await prisma.company.findFirst({
            where: { name: { equals: name, mode: "insensitive" } },
            select: { id: true },
          });
          const companyPayload = {
            name,
            domain: cell(mapped, "domain") || null,
            industry: cell(mapped, "industry") || null,
            size: cell(mapped, "size") || null,
            phone: cell(mapped, "phone") || null,
            address: cell(mapped, "address") || null,
            cep: cell(mapped, "cep") || null,
            city: cell(mapped, "city") || null,
            state: cell(mapped, "state") || null,
            notes: cell(mapped, "notes") || null,
          };
          if (existing) {
            if (!updateExisting) {
              // skipped — conta como succeeded para não falhar o job
              succeeded += 1;
              continue;
            }
            await updateCompany(existing.id, companyPayload);
          } else {
            await createCompany(companyPayload);
          }
          succeeded += 1;
        } catch (err) {
          failed += 1;
          errors.push({
            itemId: String(rowNum),
            message: err instanceof Error ? err.message : "Falha ao gravar.",
            attempt: job.attemptsMade,
            at: new Date().toISOString(),
          });
        }
      }

      await incrementOperationProgress(
        operationId,
        organizationId,
        {
          processed: slice.length,
          succeeded,
          failed,
        },
        errors,
      );
    }

    await markOperationFinished(operationId, organizationId);
    ctx.info({ rows: rows.length }, "company import done");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.error({ err: msg }, "company import failed");
    await markOperationFailed(operationId, organizationId, msg);
    throw err;
  }
}
