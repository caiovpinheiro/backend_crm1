import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  createProviderConfig,
  listProviderConfigs,
} from "@/services/call-provider-configs";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/call-provider-configs");

const VALID_AUTH_MODES = new Set(["HMAC", "TOKEN"]);
const VALID_RECORDING_DELIVERIES = new Set(["URL", "INLINE", "FETCH_LATER"]);

/**
 * GET /api/call-provider-configs
 * Lista configurações de provedor da org (sem secret).
 * RBAC: sip_extension:manage (admin de telefonia)
 */
export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:manage");
    if (denied) return denied;

    try {
      const configs = await listProviderConfigs();
      return NextResponse.json({ configs });
    } catch (e) {
      log.error({ err: e }, "[call-provider-configs] GET falhou");
      return NextResponse.json({ message: "Erro ao listar configurações." }, { status: 500 });
    }
  });
}

/**
 * POST /api/call-provider-configs
 * Cria nova configuração de provedor de webhook.
 * RBAC: sip_extension:manage
 */
export async function POST(request: Request) {
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

    const providerKey = typeof body.providerKey === "string" ? body.providerKey.trim() : "";
    if (!providerKey) {
      return NextResponse.json(
        { ok: false, field: "providerKey", message: "providerKey é obrigatório." },
        { status: 400 },
      );
    }

    const authMode = typeof body.authMode === "string" ? body.authMode.toUpperCase() : "";
    if (!VALID_AUTH_MODES.has(authMode)) {
      return NextResponse.json(
        { ok: false, field: "authMode", message: "authMode deve ser HMAC ou TOKEN." },
        { status: 400 },
      );
    }

    const webhookSecret = typeof body.webhookSecret === "string" ? body.webhookSecret : "";
    if (!webhookSecret) {
      return NextResponse.json(
        { ok: false, field: "webhookSecret", message: "webhookSecret é obrigatório." },
        { status: 400 },
      );
    }

    const recordingDelivery =
      typeof body.recordingDelivery === "string" ? body.recordingDelivery.toUpperCase() : "";
    if (!VALID_RECORDING_DELIVERIES.has(recordingDelivery)) {
      return NextResponse.json(
        {
          ok: false,
          field: "recordingDelivery",
          message: "recordingDelivery deve ser URL, INLINE ou FETCH_LATER.",
        },
        { status: 400 },
      );
    }

    const fieldMappings =
      body.fieldMappings && typeof body.fieldMappings === "object" && !Array.isArray(body.fieldMappings)
        ? (body.fieldMappings as Record<string, unknown>)
        : {};

    const signatureHeader =
      typeof body.signatureHeader === "string" && body.signatureHeader.trim()
        ? body.signatureHeader.trim()
        : null;

    try {
      const config = await createProviderConfig({
        providerKey,
        fieldMappings,
        authMode: authMode as "HMAC" | "TOKEN",
        webhookSecret,
        signatureHeader,
        recordingDelivery: recordingDelivery as "URL" | "INLINE" | "FETCH_LATER",
        createContactsForCalls: body.createContactsForCalls === true,
        isActive: body.isActive !== false,
      });
      return NextResponse.json({ config }, { status: 201 });
    } catch (e) {
      log.error({ err: e }, "[call-provider-configs] POST falhou");
      return NextResponse.json({ message: "Erro ao criar configuração." }, { status: 500 });
    }
  });
}
