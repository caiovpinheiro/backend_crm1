import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { previewSegment, type SegmentFilters } from "@/services/segments";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/campaigns/preview");

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "campaign:view");
    if (denied) return denied;
    try {
      const body = (await request.json()) as { filters?: SegmentFilters };
      const filters = body.filters ?? {};
      const preview = await previewSegment(filters);
      return NextResponse.json(preview);
    } catch (e: unknown) {
      log.error({ err: e }, "POST falhou");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao fazer preview." },
        { status: 500 },
      );
    }
  });
}
