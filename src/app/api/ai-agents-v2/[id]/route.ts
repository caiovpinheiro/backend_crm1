import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { reindexFailedKnowledgeDocs } from "@/services/ai/knowledge-docs";
import { getV2Agent, updateV2Agent, deleteV2Agent } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]");

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const orgId = r.session.user.organizationId!;
    log.info({ id, orgId, userId: r.session.user.id }, "[GET /api/ai-agents-v2/[id]] requisição");
    const agent = await getV2Agent(id, orgId);
    if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });
    return NextResponse.json({
      ...agent,
      config: agent.draftConfig ?? agent.publishedConfig,
    });
  } catch (err) {
    log.error({ err }, "[GET /api/ai-agents-v2/[id]] falhou");
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao buscar agente v2." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const body = (await request.json()) as {
      name?: string;
      active?: boolean;
      config?: unknown;
      openaiApiKey?: string | null;
      anthropicApiKey?: string | null;
    };
    const agent = await updateV2Agent(id, r.session.user.organizationId!, body);
    // Chave nova: os materiais que falharam por falta dela voltam a indexar.
    const savedKey = [body.openaiApiKey, body.anthropicApiKey].some((k) => typeof k === "string" && k.trim() !== "");
    if (savedKey) {
      void runInSessionContext(r.session, () => reindexFailedKnowledgeDocs(id)).catch((err) => {
        log.warn({ err, id }, "[PUT /api/ai-agents-v2/[id]] reindexação dos materiais falhou");
      });
    }
    return NextResponse.json(agent);
  } catch (err) {
    log.error({ err }, "[PUT /api/ai-agents-v2/[id]] falhou");
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao atualizar agente v2." },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await deleteV2Agent(id, r.session.user.organizationId!);
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error({ err }, "[DELETE /api/ai-agents-v2/[id]] falhou");
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao deletar agente v2." },
      { status: 500 },
    );
  }
}
