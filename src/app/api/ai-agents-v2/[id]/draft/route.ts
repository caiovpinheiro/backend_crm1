import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { DraftConflictError, saveV2AgentDraft } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/draft");

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const body = (await request.json()) as { config?: unknown; expectedDraftVersion?: unknown };
    const agent = await saveV2AgentDraft(id, r.session.user.organizationId!, {
      config: body.config,
      ...(typeof body.expectedDraftVersion === "number" ? { expectedDraftVersion: body.expectedDraftVersion } : {}),
    });
    return NextResponse.json(agent);
  } catch (err) {
    // O rascunho mudou desde que a tela o carregou: a tela avisa e recarrega.
    if (err instanceof DraftConflictError) {
      return NextResponse.json({ message: err.message, code: err.code, draftVersion: err.draftVersion }, { status: 409 });
    }
    log.error({ err }, "[PUT /api/ai-agents-v2/[id]/draft]");
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao salvar rascunho." },
      { status: 500 },
    );
  }
}
