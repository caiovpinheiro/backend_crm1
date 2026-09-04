import { NextResponse } from "next/server";
import { BulkOperationType } from "@prisma/client";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { assertNoActiveImport } from "@/lib/import-guard";
import {
  readDelimiterFlag,
  readUpdateExistingFlag,
  readUploadedTable,
} from "@/lib/import-helpers";
import { prisma } from "@/lib/prisma";
import { IMPORT_ETL_JOB_NAMES, enqueueImportEtl } from "@/lib/queue";
import { generateFileName, saveFile } from "@/lib/storage/local";

const MAX_ROWS = 10_000;

/**
 * POST /api/companies/import
 * CSV remapeado (1 linha = 1 empresa). Processamento no etl-worker (202).
 */
export async function POST(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const role = (authResult.user as { role?: string }).role;
      if (role !== "ADMIN" && role !== "MANAGER") {
        return NextResponse.json(
          { message: "Apenas administradores e gerentes podem importar dados." },
          { status: 403 },
        );
      }
      const denied = await requirePermissionForUser(
        authResult.user,
        "company:create",
      );
      if (denied) return denied;

      const organizationId = authResult.user.organizationId;
      if (!organizationId) {
        return NextResponse.json({ message: "Sessão sem organização." }, { status: 401 });
      }

      const activeDenied = await assertNoActiveImport();
      if (activeDenied) return activeDenied;

      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { message: 'Envie o arquivo CSV no campo "file".' },
          { status: 400 },
        );
      }

      const delimiter = readDelimiterFlag(formData);
      const updateExisting = readUpdateExistingFlag(formData);
      const { rows } = await readUploadedTable(file, delimiter);

      if (rows.length === 0) {
        return NextResponse.json({ message: "Arquivo sem linhas de dados." }, { status: 400 });
      }
      if (rows.length > MAX_ROWS) {
        return NextResponse.json(
          { message: `Limite de ${MAX_ROWS} linhas por importação.` },
          { status: 400 },
        );
      }

      const lower = file.name.toLowerCase();
      const ext = lower.endsWith(".xlsx")
        ? "xlsx"
        : lower.endsWith(".xls")
          ? "xls"
          : lower.endsWith(".ods")
            ? "ods"
            : "csv";
      const fileName = generateFileName({ prefix: "companies", ext });
      const buffer = Buffer.from(await file.arrayBuffer());
      await saveFile({ orgId: organizationId, bucket: "imports", fileName, buffer });

      const operation = await prisma.bulkOperation.create({
        // Cast: Prisma Exact<> + $extends atrasa o enum novo no tipo gerado.
        data: {
          organizationId,
          type: BulkOperationType.COMPANY_IMPORT,
          status: "PENDING",
          total: rows.length,
          payload: {
            fileName,
            originalName: file.name,
            updateExisting,
            ...(delimiter ? { delimiter } : {}),
          },
          createdById: authResult.user.id,
        } as never,
        select: { id: true },
      });

      const job = await enqueueImportEtl(IMPORT_ETL_JOB_NAMES.companyImport, {
        operationId: operation.id,
        organizationId,
        initiatedByUserId: authResult.user.id,
        fileName,
        originalName: file.name,
        delimiter,
        updateExisting,
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
        { operationId: operation.id, total: rows.length },
        { status: 202 },
      );
    });
  } catch (e) {
    console.error("[companies/import]", e);
    return NextResponse.json(
      { message: "Erro ao importar empresas." },
      { status: 500 },
    );
  }
}
