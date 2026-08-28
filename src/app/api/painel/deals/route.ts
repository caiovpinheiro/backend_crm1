import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  getPainelDeals,
  parseDealSections,
  type PainelDealFilters,
} from "@/services/painel-deals";
import {
  computePainelRange,
  parseStalledDays,
} from "@/services/painel-period";
import { resolvePipelineByPublicRef } from "@/services/pipelines";

function csv(value: string | null): string[] {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Vazio = todos os funis (soma).
 * Aceita `pipelineIds`, `pipelineId` e `pipeline` (number/slug/CUID), CSV.
 */
async function resolvePipelineIds(
  pipelineIdsRaw: string,
  pipelineId: string,
  pipelineRef: string | null,
): Promise<string[]> {
  const refs = [
    ...csv(pipelineIdsRaw),
    ...csv(pipelineId),
    ...csv(pipelineRef),
  ];
  const unique = [...new Set(refs)];
  if (
    unique.length === 0 ||
    unique.includes("all") ||
    unique.includes("__all__")
  ) {
    return [];
  }
  const ids: string[] = [];
  for (const ref of unique) {
    if (/^\d+$/.test(ref)) {
      const resolved = await resolvePipelineByPublicRef(ref);
      if (resolved) ids.push(resolved.id);
    } else {
      ids.push(ref);
    }
  }
  return [...new Set(ids)];
}

export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
      const { searchParams } = new URL(request.url);
      const range = computePainelRange(
        searchParams.get("period"),
        searchParams.get("startDate"),
        searchParams.get("endDate"),
      );
      const pipelineIds = await resolvePipelineIds(
        searchParams.get("pipelineIds") || "",
        searchParams.get("pipelineId") || "",
        searchParams.get("pipeline"),
      );
      const filters: PainelDealFilters = {
        range,
        pipelineIds,
        stageIds: csv(searchParams.get("stages")),
        tagIds: csv(searchParams.get("tags")),
        ownerIds: csv(searchParams.get("owners")),
        sources: csv(searchParams.get("sources")),
        stalledDays: parseStalledDays(searchParams.get("stalledDays")),
        fieldIds: csv(searchParams.get("fieldIds")),
      };
      const data = await getPainelDeals(
        filters,
        parseDealSections(searchParams.get("section")),
      );
      return NextResponse.json(data);
    } catch (e) {
      console.error("[api/painel/deals]", e);
      return NextResponse.json(
        { message: "Erro ao carregar o painel de negócios." },
        { status: 500 },
      );
    }
  });
}
