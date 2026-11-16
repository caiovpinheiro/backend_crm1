import type { Job } from "bullmq";

import { type CsvDelimiter } from "@/lib/csv-parse";
import { readTableFromBuffer } from "@/lib/import-helpers";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import type { ContactImportPayload } from "@/lib/queue";
import { readStoredFile } from "@/lib/storage/local";
import { prismaBase } from "@/lib/prisma-base";
import {
  CompanyNumberConflictError,
  createCompany,
  findCompanyByNumber,
  parseCompanyNumberInput,
  updateCompany,
  type UpdateCompanyInput,
} from "@/services/companies";

import {
  incrementOperationProgress,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  type BulkOperationErrorEntry,
} from "@/jobs/leads/_update-progress";

const log = getLogger("worker.etl.company-import");

const KEY_ALIASES: Record<string, string> = {
  // Número (ID público) da empresa — chave prioritária de identificação.
  numero: "number",
  number: "number",
  numero_da_empresa: "number",
  numero_empresa: "number",
  id_da_empresa: "number",
  id_empresa: "number",
  codigo: "number",
  codigo_da_empresa: "number",
  sku: "number",
  nome: "name",
  name: "name",
  dominio: "domain",
  domain: "domain",
  // A tela de Empresas exibe `domain` como "E-mail" e `size` como "CNPJ".
  email: "domain",
  e_mail: "domain",
  cnpj: "size",
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

/** Headers (normalizados) que o worker reconhece como o nome da empresa. */
export const COMPANY_IMPORT_NAME_HEADERS: ReadonlySet<string> = new Set(
  Object.entries(KEY_ALIASES)
    .filter(([, v]) => v === "name")
    .map(([k]) => k),
);

export function normalizeImportHeader(h: string): string {
  return norm(h);
}

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

/** Campos gravados pelo import (além de `name`/`number`). */
const DATA_FIELDS = [
  "domain",
  "industry",
  "size",
  "phone",
  "address",
  "cep",
  "city",
  "state",
  "notes",
] as const;

export type CompanyImportSummary = {
  created: number;
  updated: number;
  skipped: number;
};

type RowOutcome =
  | { kind: "created" | "updated" | "skipped" }
  | { kind: "failed"; message: string };

/**
 * Decide e aplica uma linha. Identificação de existente:
 *   1) coluna Número preenchida → casa SÓ pelo número (nunca pelo nome).
 *      Sem empresa com esse número → cria com esse número exato.
 *   2) sem número → casa pelo nome, mas só se for único na org. Nome com
 *      mais de uma empresa e "atualizar existentes" ligado → erro na linha
 *      (pede o número), em vez de atualizar a errada.
 * Existente sem "atualizar existentes" → ignorada.
 */
export async function importCompanyRow(
  mapped: Record<string, string>,
  presentFields: ReadonlySet<string>,
  updateExisting: boolean,
): Promise<RowOutcome> {
  const name = cell(mapped, "name");
  if (!name) return { kind: "failed", message: "Nome é obrigatório." };

  const rawNumber = cell(mapped, "number");
  const parsed = parseCompanyNumberInput(rawNumber);
  if (!parsed.ok) {
    return { kind: "failed", message: `${parsed.message} (valor: "${rawNumber}")` };
  }
  const number = parsed.value;

  let existingId: string | null = null;
  if (number != null) {
    existingId = (await findCompanyByNumber(number))?.id ?? null;
  } else {
    const byName = await prisma.company.findMany({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true },
      take: 2,
    });
    if (byName.length > 1) {
      if (!updateExisting) return { kind: "skipped" };
      return {
        kind: "failed",
        message:
          `Há mais de uma empresa chamada "${name}". ` +
          "Preencha a coluna Número para indicar qual atualizar.",
      };
    }
    existingId = byName[0]?.id ?? null;
  }

  if (existingId) {
    if (!updateExisting) return { kind: "skipped" };
    // Atualiza só colunas presentes e preenchidas: célula vazia ou coluna
    // ausente na planilha não apaga dado já cadastrado.
    const data: UpdateCompanyInput = { name };
    for (const f of DATA_FIELDS) {
      if (!presentFields.has(f)) continue;
      const v = cell(mapped, f);
      if (v) data[f] = v;
    }
    await updateCompany(existingId, data);
    return { kind: "updated" };
  }

  const createData: Parameters<typeof createCompany>[0] = { name, number };
  for (const f of DATA_FIELDS) {
    const v = cell(mapped, f);
    createData[f] = v || null;
  }
  try {
    await createCompany(createData);
  } catch (err) {
    if (err instanceof CompanyNumberConflictError) {
      return { kind: "failed", message: err.message };
    }
    throw err;
  }
  return { kind: "created" };
}

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
    const presentFields = new Set(headerMap.values());

    if (!presentFields.has("name")) {
      await markOperationFailed(
        operationId,
        organizationId,
        'Coluna "Nome" não encontrada no arquivo.',
      );
      return;
    }

    const summary: CompanyImportSummary = { created: 0, updated: 0, skipped: 0 };

    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      let succeeded = 0;
      let failed = 0;
      const errors: BulkOperationErrorEntry[] = [];

      for (let j = 0; j < slice.length; j++) {
        const raw = slice[j]!;
        const mapped: Record<string, string> = {};
        for (const [src, dest] of headerMap) {
          // Duas colunas no mesmo campo: vale a primeira preenchida.
          if (mapped[dest]) continue;
          mapped[dest] = (raw[src] ?? "").trim();
        }
        const rowNum = i + j + 2;
        let outcome: RowOutcome;
        try {
          outcome = await importCompanyRow(mapped, presentFields, updateExisting);
        } catch (err) {
          outcome = {
            kind: "failed",
            message: err instanceof Error ? err.message : "Falha ao gravar.",
          };
        }
        if (outcome.kind === "failed") {
          failed += 1;
          errors.push({
            itemId: `Linha ${rowNum}`,
            message: outcome.message,
            attempt: job.attemptsMade,
            at: new Date().toISOString(),
          });
          continue;
        }
        // Ignorada (já existe e "atualizar" desligado) conta como sucesso
        // para não falhar o job; o detalhe sai em `payload.summary`.
        succeeded += 1;
        summary[outcome.kind] += 1;
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

    await saveImportSummary(operationId, organizationId, summary);
    await markOperationFinished(operationId, organizationId);
    ctx.info({ rows: rows.length }, "company import done");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.error({ err: msg }, "company import failed");
    await markOperationFailed(operationId, organizationId, msg);
    throw err;
  }
}

/** Grava criadas/atualizadas/ignoradas em `payload.summary` (lido pela UI). */
async function saveImportSummary(
  operationId: string,
  organizationId: string,
  summary: CompanyImportSummary,
): Promise<void> {
  const op = await prismaBase.bulkOperation.findUnique({
    where: { id: operationId },
    select: { organizationId: true, payload: true },
  });
  if (!op || op.organizationId !== organizationId) return;
  const payload =
    op.payload && typeof op.payload === "object" && !Array.isArray(op.payload)
      ? (op.payload as Record<string, unknown>)
      : {};
  await prismaBase.bulkOperation.updateMany({
    where: { id: operationId, organizationId },
    data: { payload: { ...payload, summary } as never },
  });
}
