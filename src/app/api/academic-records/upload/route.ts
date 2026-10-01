import { NextResponse } from "next/server";
import { BulkOperationType } from "@prisma/client";

import { requireAdmin } from "@/lib/auth-helpers";
import { assertNoActiveImport } from "@/lib/import-guard";
import { prisma } from "@/lib/prisma";
import { IMPORT_ETL_JOB_NAMES, enqueueImportEtl } from "@/lib/queue";
import { generateFileName, saveFile } from "@/lib/storage/local";
import {
  ACADEMIC_IMPORT_MAX_BYTES,
  ACADEMIC_IMPORT_MAX_ROWS,
  ImportFileError,
  assertImportFileSignature,
  importKindFromName,
} from "@/lib/import-file-guard";
import { readTableFromBuffer } from "@/lib/import-helpers";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/academic-records/upload");

/** Upload só valida + enfileira; o etl-worker faz o replace da base. */
export const maxDuration = 60;

const MAX_FILE_SIZE = ACADEMIC_IMPORT_MAX_BYTES;

/**
 * Upload do relatório de matriculados (Excel/CSV). Substitui todos os
 * registros acadêmicos da org (assíncrono via import-etl). Somente ADMIN.
 */
export async function POST(request: Request) {
  const r = await requireAdmin();
  if (!r.ok) return r.response;
  const orgId = r.session.user.organizationId;
  if (!orgId) {
    return NextResponse.json(
      { message: "Selecione uma organização antes de subir dados." },
      { status: 400 },
    );
  }

  const activeDenied = await assertNoActiveImport();
  if (activeDenied) return activeDenied;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ message: "Erro ao processar upload." }, { status: 400 });
  }

  const raw = form.get("file");
  if (!raw || !(raw instanceof Blob)) {
    return NextResponse.json({ message: 'Envie o arquivo no campo "file".' }, { status: 400 });
  }
  const file = raw as Blob & { name?: string };
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { message: `Arquivo excede o limite de ${MAX_FILE_SIZE / 1024 / 1024} MB.` },
      { status: 413 },
    );
  }
  const originalName = file.name ?? "matriculados.xlsx";
  const lower = originalName.toLowerCase();
  const kind = /\.(xlsx|xls|ods|csv)$/.test(lower) ? importKindFromName(lower) : null;
  if (!kind) {
    return NextResponse.json(
      { message: "Formato não suportado. Envie .xlsx, .xls, .ods ou .csv." },
      { status: 415 },
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_FILE_SIZE) {
      return NextResponse.json(
        { message: `Arquivo excede o limite de ${MAX_FILE_SIZE / 1024 / 1024} MB.` },
        { status: 413 },
      );
    }
    // SEC2-4: assinatura real (PK\x03\x04 / OLE2 / texto) antes do SheetJS —
    // extensão sozinha aceitava HTML/zip bomb renomeados.
    assertImportFileSignature(buffer, kind);
    // Conta linhas só para o total do BulkOperation; o worker re-parseia.
    const { rows } = await readTableFromBuffer(buffer, originalName, undefined, {
      maxRows: ACADEMIC_IMPORT_MAX_ROWS,
    });
    if (rows.length === 0) {
      return NextResponse.json({ message: "Arquivo sem linhas de dados." }, { status: 400 });
    }

    const ext = lower.endsWith(".csv")
      ? "csv"
      : lower.endsWith(".xls")
        ? "xls"
        : lower.endsWith(".ods")
          ? "ods"
          : "xlsx";
    const fileName = generateFileName({ prefix: "academic", ext });
    await saveFile({ orgId, bucket: "imports", fileName, buffer });

    const operation = await prisma.bulkOperation.create({
      // Cast: Prisma Exact<> + $extends atrasa o enum novo no tipo gerado.
      data: {
        organizationId: orgId,
        type: BulkOperationType.ACADEMIC_IMPORT,
        status: "PENDING",
        total: rows.length,
        payload: {
          fileName,
          originalName,
        },
        createdById: r.session.user.id,
      } as never,
      select: { id: true },
    });

    const job = await enqueueImportEtl(IMPORT_ETL_JOB_NAMES.academicImport, {
      operationId: operation.id,
      organizationId: orgId,
      initiatedByUserId: r.session.user.id,
      fileName,
      originalName,
      updateExisting: true,
    });

    if (!job) {
      await prisma.bulkOperation.update({
        where: { id: operation.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          errors: [
            {
              itemId: "__operation__",
              message: "Fila de jobs indisponível (Redis offline)",
              attempt: 0,
              at: new Date().toISOString(),
            },
          ],
        },
      });
      return NextResponse.json(
        { message: "Fila de importação indisponível. Tente novamente." },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { operationId: operation.id, total: rows.length, fileName: originalName },
      { status: 202 },
    );
  } catch (e) {
    if (e instanceof ImportFileError) {
      return NextResponse.json({ message: e.message }, { status: e.status });
    }
    log.error({ err: e }, "[academic-records] upload error");
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro interno ao importar." },
      { status: 500 },
    );
  }
}
