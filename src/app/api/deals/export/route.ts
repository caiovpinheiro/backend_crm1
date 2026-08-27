import { NextResponse } from "next/server";

import type { Prisma } from "@prisma/client";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { csvDate, escapeCsvCell, DEFAULT_CSV_DELIMITER } from "@/lib/csv-stringify";
import { resolveContactDisplayName } from "@/lib/display-name";
import { prisma } from "@/lib/prisma";
import { getVisibilityFilter } from "@/lib/visibility";
import { isValidDealStatus } from "@/services/deals";
import {
  buildDealWhereFromFilters,
  parseAdvancedDealFiltersFromParams,
} from "@/services/kanban-filters";

const MAX_ROWS = 100_000;
const BATCH_SIZE = 400;

/**
 * GET /api/deals/export?pipelineId=<id>&status=<OPEN|WON|LOST>&filters=<json>
 *
 * Exporta negócios em CSV (streaming em lotes) para não estourar memória/
 * timeout em pipelines grandes (ex.: ACADÊMICO). Sem `pipelineId` (ou
 * `pipelineId=all`) exporta todos os pipelines da org.
 *
 * `filters` (JSON) / `f` (base64url) aceitam o mesmo `AdvancedDealFilters` do
 * board — é assim que a UI exporta "somente a base filtrada" em vez do funil
 * inteiro. Sem eles, exporta tudo que o usuário pode ver.
 */

export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const role = (authResult.user as { role?: string }).role;
      if (role !== "ADMIN" && role !== "MANAGER") {
        return NextResponse.json(
          { message: "Apenas administradores e gerentes podem exportar dados." },
          { status: 403 },
        );
      }
      const denied = await requirePermissionForUser(authResult.user, "deal:view");
      if (denied) return denied;

      const { searchParams } = new URL(request.url);
      const pipelineParam = searchParams.get("pipelineId");
      const pipelineId =
        pipelineParam && pipelineParam !== "all" ? pipelineParam : undefined;

      const statusParam = searchParams.get("status");
      const status =
        statusParam && statusParam !== "ALL" && isValidDealStatus(statusParam)
          ? statusParam
          : undefined;

      const advancedFilters = parseAdvancedDealFiltersFromParams(searchParams);
      const filterConditions =
        Object.keys(advancedFilters).length > 0
          ? await buildDealWhereFromFilters(advancedFilters)
          : [];

      const visibility = await getVisibilityFilter(
        authResult.user as { id: string; role: "ADMIN" | "MANAGER" | "MEMBER" },
      );

      const fieldDefs = await prisma.customField.findMany({
        where: { entity: { in: ["deal", "contact"] } },
        select: { id: true, name: true, entity: true },
        orderBy: { name: "asc" },
      });
      const dealFields = fieldDefs.filter((f) => f.entity === "deal");
      const contactFields = fieldDefs.filter((f) => f.entity === "contact");

      const emailCfIds = ["email"]
        .map((n) => dealFields.find((f) => f.name === n)?.id)
        .filter((id): id is string => Boolean(id));

      const baseHeaders = [
        "Número do negócio",
        "Título",
        "Valor",
        "Status",
        "Pipeline",
        "Etapa",
        "Responsável",
        "E-mail do responsável",
        "Nome do contato",
        "E-mail do contato",
        "Telefone do contato",
        "Empresa do contato",
        "Ciclo de vida do contato",
        "Origem do contato",
        "Tags",
        "Previsão de fechamento",
        "Motivo da perda",
        "Posição",
        "Criado em",
        "Atualizado em",
        "Fechado em",
      ];
      const dealCfHeaders = dealFields.map((f) => f.name);
      const contactCfHeaders = contactFields.map((f) => `Contato — ${f.name}`);
      const headers = [...baseHeaders, ...dealCfHeaders, ...contactCfHeaders];
      const delimiter = DEFAULT_CSV_DELIMITER;

      // Lookup de custom field values por lote (`WHERE dealId = ANY(...)`):
      // restringe às colunas realmente exportadas e ignora valores vazios
      // (o map em memória trata ausência como "" de qualquer forma). Sem o
      // filtro a query trazia ~1.900 linhas por lote de 400 deals — 32,9M
      // linhas na janela do stress sa221601. Quando a org não tem campos da
      // entidade, o include é omitido e a query nem roda.
      const dealFieldIds = dealFields.map((f) => f.id);
      const contactFieldIds = contactFields.map((f) => f.id);

      const where: Prisma.DealWhereInput = {
        AND: [
          visibility.dealWhere,
          ...(pipelineId ? [{ stage: { pipelineId } }] : []),
          ...(status ? [{ status }] : []),
          ...filterConditions,
        ],
      };

      const stamp = new Date().toISOString().slice(0, 10);
      const filtered = filterConditions.length > 0 || !!status;
      const filename = `negocios${filtered ? "-filtrado" : ""}-${stamp}.csv`;
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (s: string) => controller.enqueue(encoder.encode(s));
          try {
            write("\ufeff");
            write(
              headers.map((h) => escapeCsvCell(h, delimiter)).join(delimiter) +
                "\r\n",
            );

            let cursor: string | undefined;
            let exported = 0;

            while (exported < MAX_ROWS) {
              const take = Math.min(BATCH_SIZE, MAX_ROWS - exported);
              const batch = await prisma.deal.findMany({
                where,
                take,
                orderBy: { id: "asc" },
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
                include: {
                  stage: {
                    include: { pipeline: { select: { id: true, name: true } } },
                  },
                  owner: { select: { id: true, name: true, email: true } },
                  tags: { include: { tag: { select: { name: true } } } },
                  ...(dealFieldIds.length > 0
                    ? {
                        customFields: {
                          where: {
                            customFieldId: { in: dealFieldIds },
                            value: { not: "" },
                          },
                          select: { customFieldId: true, value: true },
                        },
                      }
                    : {}),
                  contact: {
                    include: {
                      company: { select: { name: true } },
                      ...(contactFieldIds.length > 0
                        ? {
                            customFields: {
                              where: {
                                customFieldId: { in: contactFieldIds },
                                value: { not: "" },
                              },
                              select: { customFieldId: true, value: true },
                            },
                          }
                        : {}),
                    },
                  },
                },
              });

              if (batch.length === 0) break;

              for (const deal of batch) {
                try {
                  const dealCfMap = new Map(
                    (deal.customFields ?? []).map((v) => [
                      v.customFieldId,
                      v.value,
                    ]),
                  );
                  const contactCfMap = new Map(
                    (deal.contact?.customFields ?? []).map((v) => [
                      v.customFieldId,
                      v.value,
                    ]),
                  );

                  const values: unknown[] = [
                    deal.number,
                    deal.title,
                    deal.value != null ? String(deal.value) : "",
                    deal.status,
                    deal.stage?.pipeline?.name ?? "",
                    deal.stage?.name ?? "",
                    deal.owner?.name ?? "",
                    deal.owner?.email ?? "",
                    resolveContactDisplayName(deal.contact?.name, deal.title),
                    deal.contact?.email ||
                      emailCfIds
                        .map((id) => dealCfMap.get(id))
                        .find((v) => typeof v === "string" && v.includes("@")) ||
                      "",
                    (deal.contact?.phone ?? "").replace(/^\+/, ""),
                    deal.contact?.company?.name ?? "",
                    deal.contact?.lifecycleStage ?? "",
                    deal.contact?.source ?? "",
                    deal.tags
                      .map((t) => t.tag?.name)
                      .filter((n): n is string => !!n)
                      .join("; "),
                    csvDate(deal.expectedClose),
                    deal.lostReason ?? "",
                    deal.position,
                    csvDate(deal.createdAt),
                    csvDate(deal.updatedAt),
                    csvDate(deal.closedAt),
                  ];
                  for (const f of dealFields) {
                    values.push(dealCfMap.get(f.id) ?? "");
                  }
                  for (const f of contactFields) {
                    values.push(contactCfMap.get(f.id) ?? "");
                  }

                  write(
                    values
                      .map((v) => escapeCsvCell(v, delimiter))
                      .join(delimiter) + "\r\n",
                  );
                  exported += 1;
                } catch (rowErr) {
                  console.error(
                    "[deals/export] linha ignorada",
                    deal.id,
                    rowErr,
                  );
                }
              }

              cursor = batch[batch.length - 1]!.id;
              if (batch.length < take) break;
            }
          } catch (e) {
            console.error("[deals/export] stream error", e);
            try {
              controller.error(e);
              return;
            } catch {
              /* already closed */
            }
          }
          controller.close();
        },
      });

      return new NextResponse(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  } catch (e) {
    console.error("[deals/export]", e);
    const detail = e instanceof Error ? e.message : "Erro desconhecido";
    return NextResponse.json(
      { message: `Erro ao exportar negócios: ${detail}` },
      { status: 500 },
    );
  }
}
