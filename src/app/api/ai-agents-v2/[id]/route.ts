import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { getV2Agent, updateV2Agent, deleteV2Agent } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const agent = await getV2Agent(id, r.session.user.organizationId!);
    if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });
    return NextResponse.json({
      ...agent,
      simpleConfig: agent.draftConfig ?? agent.publishedConfig,
    });
  } catch (err) {
    console.error("[GET /api/ai-agents-v2/[id]]", err);
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
    };
    const agent = await updateV2Agent(id, r.session.user.organizationId!, body);
    return NextResponse.json(agent);
  } catch (err) {
    console.error("[PUT /api/ai-agents-v2/[id]]", err);
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
    console.error("[DELETE /api/ai-agents-v2/[id]]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao deletar agente v2." },
      { status: 500 },
    );
  }
}
