import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { getCall, updateCall } from "@/services/calls";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/calls/[id]");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/calls/[id]
 * Detalhe de uma chamada com eventos e contato vinculado.
 * RBAC: call:view
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "call:view");
    if (denied) return denied;

    try {
      const call = await getCall(id);
      if (!call) {
        return NextResponse.json({ message: "Chamada não encontrada." }, { status: 404 });
      }
      return NextResponse.json({ call });
    } catch (e) {
      log.error({ err: e }, "[calls] GET [id] falhou");
      return NextResponse.json({ message: "Erro ao buscar chamada." }, { status: 500 });
    }
  });
}

/**
 * PATCH /api/calls/[id]
 * Atualiza campos de uma chamada (anotação manual ou atualização interna).
 * RBAC: call:annotate
 */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "call:annotate");
    if (denied) return denied;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const existing = await getCall(id);
    if (!existing) {
      return NextResponse.json({ message: "Chamada não encontrada." }, { status: 404 });
    }

    const patch: Parameters<typeof updateCall>[1] = {};

    if (body.status !== undefined) {
      const validStatuses = new Set(["RINGING", "ANSWERED", "COMPLETED", "MISSED", "BUSY", "FAILED"]);
      const status = String(body.status).toUpperCase();
      if (!validStatuses.has(status)) {
        return NextResponse.json(
          { ok: false, field: "status", message: "status inválido." },
          { status: 400 },
        );
      }
      patch.status = status as Parameters<typeof updateCall>[1]["status"];
    }

    if (body.recordingUrl !== undefined) {
      patch.recordingUrl =
        typeof body.recordingUrl === "string" && body.recordingUrl.trim()
          ? body.recordingUrl.trim()
          : null;
    }

    try {
      const call = await updateCall(id, patch);
      return NextResponse.json({ call });
    } catch (e) {
      log.error({ err: e }, "[calls] PATCH [id] falhou");
      return NextResponse.json({ message: "Erro ao atualizar chamada." }, { status: 500 });
    }
  });
}
