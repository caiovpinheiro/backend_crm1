import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { deleteMaterialAttachment, updateMaterialAttachment } from "@/services/ai-v2/material-attachments";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/materials/[docId]/attachments/[attachmentId]");

type Params = { params: Promise<{ id: string; docId: string; attachmentId: string }> };

/** Muda o nome ou o "quando enviar" do anexo. */
export async function PATCH(request: Request, { params }: Params) {
  const { id, attachmentId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const attachment = await updateMaterialAttachment({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        attachmentId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.autoSend !== undefined ? { autoSend: body.autoSend } : {}),
        ...(body.resendWindow !== undefined ? { resendWindow: body.resendWindow } : {}),
      });
      if (!attachment) return NextResponse.json({ message: "Anexo não encontrado." }, { status: 404 });
      return NextResponse.json({ attachment });
    } catch (err) {
      log.error(
        { err },
        "[PATCH /api/ai-agents-v2/[id]/materials/[docId]/attachments/[attachmentId]]",
      );
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao salvar o anexo." }, { status: 500 });
    }
  });
}

/** Tira o anexo do material (o arquivo fica no armazenamento). */
export async function DELETE(_request: Request, { params }: Params) {
  const { id, attachmentId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const ok = await deleteMaterialAttachment(r.session.user.organizationId!, id, attachmentId);
      if (!ok) return NextResponse.json({ message: "Anexo não encontrado." }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      log.error(
        { err },
        "[DELETE /api/ai-agents-v2/[id]/materials/[docId]/attachments/[attachmentId]]",
      );
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao remover o anexo." }, { status: 500 });
    }
  });
}
