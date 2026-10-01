import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { addMaterialAttachment, listMaterialAttachments, MATERIAL_ATTACHMENT_LIMITS } from "@/services/ai-v2/material-attachments";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/materials/[docId]/attachments");

type Params = { params: Promise<{ id: string; docId: string }> };

/** Anexos do material (vídeo, imagem, áudio, PDF) que o agente pode enviar. */
export async function GET(_request: Request, { params }: Params) {
  const { id, docId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const attachments = await listMaterialAttachments(r.session.user.organizationId!, id, docId);
      return NextResponse.json({ attachments, limits: MATERIAL_ATTACHMENT_LIMITS });
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/[id]/materials/[docId]/attachments]");
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao listar os anexos." }, { status: 500 });
    }
  });
}

/** Liga ao material um arquivo já enviado (url do upload). */
export async function POST(request: Request, { params }: Params) {
  const { id, docId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const attachment = await addMaterialAttachment({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        docId,
        url: body.url,
        mimeType: body.mimeType,
        name: body.name,
        description: body.description,
      });
      return NextResponse.json({ attachment }, { status: 201 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao anexar.";
      const status = msg.includes("não encontrado") ? 404 : msg.includes("inválido") || msg.includes("até") ? 400 : 500;
      if (status === 500) log.error(
        { err },
        "[POST /api/ai-agents-v2/[id]/materials/[docId]/attachments]",
      );
      return NextResponse.json({ message: msg }, { status });
    }
  });
}
