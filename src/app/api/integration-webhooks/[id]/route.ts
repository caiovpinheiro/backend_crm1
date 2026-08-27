import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  deleteIntegrationWebhook,
  getIntegrationWebhook,
} from "@/services/integration-webhooks";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const denied = await requirePermissionForUser(authResult.user, "deal:view");
      if (denied) return denied;

      const { id } = await context.params;
      if (!id) return NextResponse.json({ message: "ID inválido." }, { status: 400 });

      const row = await getIntegrationWebhook(id);
      if (!row) return NextResponse.json({ message: "Webhook não encontrado." }, { status: 404 });
      return NextResponse.json(row);
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao buscar webhook." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const denied = await requirePermissionForUser(authResult.user, "deal:edit");
      if (denied) return denied;

      const { id } = await context.params;
      if (!id) return NextResponse.json({ message: "ID inválido." }, { status: 400 });

      const existing = await getIntegrationWebhook(id);
      if (!existing) {
        return NextResponse.json({ message: "Webhook não encontrado." }, { status: 404 });
      }

      await deleteIntegrationWebhook(id);
      return NextResponse.json({ ok: true });
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao remover webhook." }, { status: 500 });
  }
}
