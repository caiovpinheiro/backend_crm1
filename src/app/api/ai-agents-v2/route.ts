import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import {
  createV2Agent,
  listV2Agents,
} from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const items = await listV2Agents(r.session.user.organizationId!);
    return NextResponse.json({ agents: items });
  } catch (err) {
    console.error("[GET /api/ai-agents-v2]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao listar agentes v2." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const body = (await request.json()) as {
      name?: string;
      preset?: string;
      config?: unknown;
      active?: boolean;
    };
    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json({ message: "name é obrigatório." }, { status: 400 });
    }
    const agent = await createV2Agent(r.session.user.organizationId!, {
      name: body.name,
      preset: body.preset,
      config: body.config,
      active: body.active,
    });
    return NextResponse.json(agent, { status: 201 });
  } catch (err) {
    console.error("[POST /api/ai-agents-v2]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao criar agente v2." },
      { status: 500 },
    );
  }
}
