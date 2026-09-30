import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { listV2PresetsService } from "@/services/ai-v2/agents";

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;

  try {
    const presets = listV2PresetsService().map((p) => ({
      key: p.key,
      label: p.label,
    }));
    return NextResponse.json({ presets });
  } catch (err) {
    console.error("[GET /api/ai-agents-v2/presets]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao listar presets v2." },
      { status: 500 },
    );
  }
}
