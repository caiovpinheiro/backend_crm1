import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  getProviderConfig,
  updateProviderConfig,
  deleteProviderConfig,
} from "@/services/call-provider-configs";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/call-provider-configs/[id]");

type RouteContext = { params: Promise<{ id: string }> };

const VALID_AUTH_MODES = new Set(["HMAC", "TOKEN"]);
const VALID_RECORDING_DELIVERIES = new Set(["URL", "INLINE", "FETCH_LATER"]);

/**
 * GET /api/call-provider-configs/[id]
 * Detalhe de uma configuração de provedor.
 * RBAC: sip_extension:manage
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:manage");
    if (denied) return denied;

    const config = await getProviderConfig(id);
    if (!config) {
      return NextResponse.json({ message: "Configuração não encontrada." }, { status: 404 });
    }
    return NextResponse.json({ config });
  });
}

/**
 * PUT /api/call-provider-configs/[id]
 * Atualiza uma configuração de provedor.
 * RBAC: sip_extension:manage
 */
export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:manage");
    if (denied) return denied;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const existing = await getProviderConfig(id);
    if (!existing) {
      return NextResponse.json({ message: "Configuração não encontrada." }, { status: 404 });
    }

    const patch: Parameters<typeof updateProviderConfig>[1] = {};

    if (body.fieldMappings !== undefined && typeof body.fieldMappings === "object" && !Array.isArray(body.fieldMappings)) {
      patch.fieldMappings = body.fieldMappings as Record<string, unknown>;
    }

    if (body.authMode !== undefined) {
      const authMode = String(body.authMode).toUpperCase();
      if (!VALID_AUTH_MODES.has(authMode)) {
        return NextResponse.json(
          { ok: false, field: "authMode", message: "authMode deve ser HMAC ou TOKEN." },
          { status: 400 },
        );
      }
      patch.authMode = authMode as "HMAC" | "TOKEN";
    }

    if (typeof body.webhookSecret === "string" && body.webhookSecret) {
      patch.webhookSecret = body.webhookSecret;
    }

    if (body.signatureHeader !== undefined) {
      patch.signatureHeader =
        typeof body.signatureHeader === "string" && body.signatureHeader.trim()
          ? body.signatureHeader.trim()
          : null;
    }

    if (body.recordingDelivery !== undefined) {
      const rd = String(body.recordingDelivery).toUpperCase();
      if (!VALID_RECORDING_DELIVERIES.has(rd)) {
        return NextResponse.json(
          { ok: false, field: "recordingDelivery", message: "recordingDelivery deve ser URL, INLINE ou FETCH_LATER." },
          { status: 400 },
        );
      }
      patch.recordingDelivery = rd as "URL" | "INLINE" | "FETCH_LATER";
    }

    if (body.createContactsForCalls !== undefined) {
      patch.createContactsForCalls = body.createContactsForCalls === true;
    }

    try {
      const config = await updateProviderConfig(id, patch);
      return NextResponse.json({ config });
    } catch (e) {
      log.error({ err: e }, "[call-provider-configs] PUT falhou");
      return NextResponse.json({ message: "Erro ao atualizar configuração." }, { status: 500 });
    }
  });
}

/**
 * DELETE /api/call-provider-configs/[id]
 * Remove uma configuração de provedor.
 * RBAC: sip_extension:manage
 */
export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:manage");
    if (denied) return denied;

    const existing = await getProviderConfig(id);
    if (!existing) {
      return NextResponse.json({ message: "Configuração não encontrada." }, { status: 404 });
    }

    try {
      await deleteProviderConfig(id);
      return NextResponse.json({ ok: true });
    } catch (e) {
      log.error({ err: e }, "[call-provider-configs] DELETE falhou");
      return NextResponse.json({ message: "Erro ao remover configuração." }, { status: 500 });
    }
  });
}
