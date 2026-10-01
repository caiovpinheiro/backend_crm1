import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { assertImportPermission, assertNoActiveImport } from "@/lib/import-guard";
import { validateDealImportHeaders } from "@/lib/deal-import-core";
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  ImportFileError,
  importTooLargeMessage,
} from "@/lib/import-file-guard";
import {
  readDelimiterFlag,
  readImportModeFlag,
  readTagFlag,
  readUpdateExistingFlag,
  readTableFromBuffer,
} from "@/lib/import-helpers";
import { prisma } from "@/lib/prisma";
import { IMPORT_ETL_JOB_NAMES, enqueueImportEtl } from "@/lib/queue";
import { enterRequestContext } from "@/lib/request-context";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/deals/import");

/**
 * Importação de NEGÓCIOS — fluxo ASSÍNCRONO (etl-worker), T3/M1.
 *
 * Antes esta rota processava o arquivo inteiro de forma SÍNCRONA dentro do
 * request HTTP, ocupando um worker Node da API (compartilhado com os demais
 * tenants) por vários minutos em cargas grandes. Agora, igual ao import de
 * contatos:
 *   1. valida permissão + parseia para validar cabeçalho e contar linhas;
 *   2. salva o arquivo no bucket `imports` do storage compartilhado;
 *   3. cria um `BulkOperation` PENDING (fonte da verdade do progresso);
 *   4. enfileira o job `deal-import` na fila `import-etl` e responde 202;
 *   5. o etl-worker (processo/pool separado) processa em chunks.
 *
 * O frontend acompanha via GET /api/bulk-operations/[id] (o ImportPanel já
 * trata 202 { operationId } genericamente para os dois endpoints).
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    const denied = assertImportPermission(session);
    if (denied) return denied;

    if (session?.user?.organizationId) {
      enterRequestContext({
        organizationId: session.user.organizationId,
        userId: session.user.id,
        isSuperAdmin: Boolean(session.user.isSuperAdmin),
        actor: {
          type: "HUMAN",
          label: session.user.name ?? session.user.email ?? session.user.id,
          sublabel: "Importação",
        },
      });
    }

    const permissionDenied = await requirePermissionForUser(
      (session?.user ?? {}) as {
        id: string;
        organizationId: string | null;
        role?: string | null;
        isSuperAdmin?: boolean;
      },
      "deal:create",
    );
    if (permissionDenied) return permissionDenied;

    if (!session?.user?.organizationId) {
      return NextResponse.json({ message: "Sessão sem organização." }, { status: 401 });
    }
    const organizationId = session.user.organizationId;
    const userId = session.user.id;

    // M6 — 1 import ativo por org por vez.
    const activeDenied = await assertNoActiveImport();
    if (activeDenied) return activeDenied;

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { message: 'Envie o arquivo CSV no campo "file" (multipart/form-data).' },
        { status: 400 },
      );
    }

    // SEC2-4: teto de bytes explícito na rota.
    if (file.size > IMPORT_MAX_BYTES) {
      return NextResponse.json(
        { message: importTooLargeMessage(IMPORT_MAX_BYTES) },
        { status: 413 },
      );
    }

    const delimiter = readDelimiterFlag(formData);
    const updateExisting = readUpdateExistingFlag(formData);
    // `importMode` é o novo flag (create/update/upsert). Fallback derivado
    // de `updateExisting` mantém compat com clientes antigos: sem update →
    // "create"; com update → "upsert" (comportamento anterior à correção).
    const importMode =
      readImportModeFlag(formData) ?? (updateExisting ? "upsert" : "create");
    const tagName = readTagFlag(formData);

    // Parseia uma vez para validar cabeçalho e contar as linhas (total do
    // BulkOperation). O worker re-parseia o arquivo salvo no storage.
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > IMPORT_MAX_BYTES) {
      return NextResponse.json(
        { message: importTooLargeMessage(IMPORT_MAX_BYTES) },
        { status: 413 },
      );
    }
    const { headers, rows } = await readTableFromBuffer(buffer, file.name, delimiter, {
      maxRows: IMPORT_MAX_ROWS,
    });
    const headerError = validateDealImportHeaders(headers, {
      allowCreate: importMode !== "update",
    });
    if (headerError) {
      return NextResponse.json({ message: headerError }, { status: 400 });
    }
    if (rows.length === 0) {
      return NextResponse.json({ message: "Arquivo sem linhas de dados." }, { status: 400 });
    }

    const ext = file.name.toLowerCase().endsWith(".xlsx")
      ? "xlsx"
      : file.name.toLowerCase().endsWith(".xls")
        ? "xls"
        : file.name.toLowerCase().endsWith(".ods")
          ? "ods"
          : "csv";
    const fileName = generateFileName({ prefix: "deals", ext });
    await saveFile({ orgId: organizationId, bucket: "imports", fileName, buffer });

    const operation = await prisma.bulkOperation.create({
      data: {
        type: "DEAL_IMPORT",
        status: "PENDING",
        total: rows.length,
        payload: {
          fileName,
          originalName: file.name,
          updateExisting,
          importMode,
          fileContentB64: buffer.toString("base64"),
          ...(delimiter ? { delimiter } : {}),
          ...(tagName ? { tagName } : {}),
        },
        createdById: userId,
      },
      select: { id: true },
    });

    const job = await enqueueImportEtl(IMPORT_ETL_JOB_NAMES.dealImport, {
      operationId: operation.id,
      organizationId,
      initiatedByUserId: userId,
      fileName,
      originalName: file.name,
      delimiter,
      updateExisting,
      importMode,
      tagName,
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
        { message: "Fila de importação indisponível.", operationId: operation.id },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { message: "Importação enfileirada.", operationId: operation.id, total: rows.length },
      { status: 202 },
    );
  } catch (e) {
    if (e instanceof ImportFileError) {
      return NextResponse.json({ message: e.message }, { status: e.status });
    }
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao importar negócios." }, { status: 500 });
  }
}
