import { NextResponse } from "next/server";
import { v2AuxModel } from "@/lib/ai-v2/models";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { extractKnowledgeText, KnowledgeExtractError, MAX_UPLOAD_BYTES } from "@/services/ai/knowledge-extract";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { getV2Agent } from "@/services/ai-v2/agents";
import { importCalendarText } from "@/services/ai-v2/calendar-import";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

/**
 * Lê um calendário (arquivo PDF/TXT/CSV/DOCX ou texto colado) e devolve os
 * eventos para a tela revisar. Nada é gravado aqui: salvar é pelo rascunho.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  try {
    const organizationId = r.session.user.organizationId!;
    const agent = await getV2Agent(id, organizationId);
    if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });
    const config = (agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;

    let text = "";
    let forceAi = false;
    let year = new Date().getFullYear();
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ message: "Envie um arquivo." }, { status: 400 });
      if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ message: "Arquivo acima de 10 MB." }, { status: 400 });
      text = (await extractKnowledgeText(file.name, Buffer.from(await file.arrayBuffer()))).text;
      // PDF de calendário quase sempre vem de tabela: o mês fica longe do dia.
      forceAi = /\.pdf$/i.test(file.name) || form.get("forceAi") === "1";
      const y = Number(form.get("year"));
      if (Number.isInteger(y) && y > 2000) year = y;
    } else {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as { text?: unknown; year?: unknown; forceAi?: unknown };
      text = typeof body.text === "string" ? body.text : "";
      forceAi = body.forceAi === true;
      if (typeof body.year === "number" && body.year > 2000) year = body.year;
    }
    if (!text.trim()) return NextResponse.json({ message: "Não encontrei texto para ler." }, { status: 400 });

    const result = await importCalendarText({
      text,
      defaultYear: year,
      model: v2AuxModel(config.model),
      apiKey: await tryGetAgentApiKey(id),
      forceAi,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof KnowledgeExtractError) return NextResponse.json({ message: err.message }, { status: 400 });
    const message = err instanceof Error ? err.message : "Não foi possível ler o calendário.";
    console.error("[POST /api/ai-agents-v2/[id]/calendar/import]", err);
    return NextResponse.json({ message }, { status: 500 });
  }
}
