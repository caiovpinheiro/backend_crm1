import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  getApi4ComIntegration,
  updateApi4ComIntegration,
} from "@/services/call-provider-configs";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/call-provider-configs/api4com");

const PatchSchema = z.object({
  serviceToken: z.string().nullable().optional(),
  gateway: z.string().optional(),
});

/**
 * GET /api/call-provider-configs/api4com
 * Garante o webhook da org e devolve token/gateway (sem o secret).
 */
export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:manage");
    if (denied) return denied;

    try {
      const integration = await getApi4ComIntegration();
      return NextResponse.json(integration);
    } catch (e) {
      log.error({ err: e }, "[call-provider-configs/api4com] GET falhou");
      return NextResponse.json({ message: "Erro ao carregar integração Api4Com." }, { status: 500 });
    }
  });
}

/**
 * PATCH /api/call-provider-configs/api4com
 * Salva token/gateway da org e registra o webhook na Api4Com.
 */
export async function PATCH(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:manage");
    if (denied) return denied;

    const body = await request.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Body inválido. Esperado: { serviceToken?, gateway? }." },
        { status: 400 },
      );
    }

    try {
      const integration = await updateApi4ComIntegration(parsed.data);
      return NextResponse.json(integration);
    } catch (e) {
      log.error({ err: e }, "[call-provider-configs/api4com] PATCH falhou");
      return NextResponse.json({ message: "Erro ao salvar integração Api4Com." }, { status: 500 });
    }
  });
}
