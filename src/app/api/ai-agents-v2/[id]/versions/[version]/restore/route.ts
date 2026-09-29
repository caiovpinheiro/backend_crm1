import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { restoreV2AgentVersionToDraft } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; version: string }> }) {
  const { id, version } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  const versionNumber = Number.parseInt(version, 10);
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    return NextResponse.json({ message: "Versão inválida." }, { status: 400 });
  }
  try {
    await ensureV2AgentSchema();
    const result = await restoreV2AgentVersionToDraft(id, r.session.user.organizationId!, versionNumber);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro ao restaurar a versão.";
    console.error("[POST /api/ai-agents-v2/[id]/versions/[version]/restore]", err);
    return NextResponse.json({ message }, { status: message === "Versão não encontrada." ? 404 : 500 });
  }
}
