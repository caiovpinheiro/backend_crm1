import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  assertWebhookUrl,
  createIntegrationWebhook,
  listIntegrationWebhooks,
  normalizeWebhookEvents,
} from "@/services/integration-webhooks";

export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const denied = await requirePermissionForUser(authResult.user, "deal:view");
      if (denied) return denied;
      if (!authResult.user.organizationId) {
        return NextResponse.json({ message: "Sem organização." }, { status: 400 });
      }

      const items = await listIntegrationWebhooks();
      return NextResponse.json(items);
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao listar webhooks." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const denied = await requirePermissionForUser(authResult.user, "deal:edit");
      if (denied) return denied;
      const orgId = authResult.user.organizationId;
      if (!orgId) {
        return NextResponse.json({ message: "Sem organização." }, { status: 400 });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }
      if (!body || typeof body !== "object") {
        return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
      }

      const b = body as Record<string, unknown>;
      const url = typeof b.url === "string" ? b.url.trim() : "";
      const urlError = assertWebhookUrl(url);
      if (urlError) return NextResponse.json({ message: urlError }, { status: 400 });

      const events = normalizeWebhookEvents(b.events);
      if (!events) {
        return NextResponse.json(
          { message: "events deve ser um array com ao menos um evento conhecido (ou *)." },
          { status: 400 },
        );
      }

      const name =
        typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 200) : null;

      try {
        const created = await createIntegrationWebhook({
          url,
          events,
          name,
          organizationId: orgId,
        });
        return NextResponse.json(created, { status: 201 });
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code: unknown }).code)
            : "";
        if (code === "P2002") {
          return NextResponse.json(
            { message: "Já existe um webhook com esta URL nesta organização." },
            { status: 409 },
          );
        }
        throw err;
      }
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao criar webhook." }, { status: 500 });
  }
}
