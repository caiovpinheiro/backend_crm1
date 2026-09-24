import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getPainelInsights } from "@/services/painel-insights";
import { computePainelRange } from "@/services/painel-period";
import { getDefaultPipelineId } from "@/services/pipelines";

export const dynamic = "force-dynamic";

function csv(value: string | null): string[] {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
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
      let pipelineIds = csv(searchParams.get("pipelineIds"));
      if (!pipelineIds.length) {
        const fallback = await getDefaultPipelineId();
        pipelineIds = fallback ? [fallback] : [];
      }
      const taskGroups = csv(searchParams.get("taskGroups")).filter(
        (g): g is "user" | "department" => g === "user" || g === "department",
      );
      const data = await getPainelInsights({
        range,
        pipelineIds,
        stageIds: csv(searchParams.get("stageIds")),
        inboundOwners: searchParams.get("inboundOwners") === "1",
        taskGroups,
      });
      return NextResponse.json(data);
    } catch (e) {
      console.error("[api/painel/insights]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Falha ao carregar os cards." },
        { status: 500 },
      );
    }
  });
}
