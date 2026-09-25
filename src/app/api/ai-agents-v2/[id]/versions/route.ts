import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { listV2AgentVersions } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const versions = await listV2AgentVersions(id, r.session.user.organizationId!);
    return NextResponse.json({ versions });
  } catch (err) {
    console.error("[GET /api/ai-agents-v2/[id]/versions]", err);
    return NextResponse.json({ message: "Erro ao carregar as versões." }, { status: 500 });
  }
}
