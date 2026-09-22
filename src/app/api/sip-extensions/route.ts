import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  createOrUpdateExtension,
  listExtensions,
} from "@/services/sip-extensions";

/**
 * GET /api/sip-extensions
 * Lista todos os ramais da org.
 * RBAC: sip_extension:view
 */
export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:view");
    if (denied) return denied;

    try {
      const extensions = await listExtensions();
      return NextResponse.json({ extensions });
    } catch (e) {
      console.error("[sip-extensions] GET:", e);
      return NextResponse.json(
        { message: "Erro ao listar ramais." },
        { status: 500 },
      );
    }
  });
}

/**
 * POST /api/sip-extensions
 * Cria ou atualiza o ramal do usuário corrente (ou de outro usuário se admin).
 * A senha chega em texto puro e é cifrada antes de persistir.
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

    // userId pode ser omitido → usa o próprio usuário autenticado
    const userId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId.trim()
        : authResult.user.id;

    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) {
      return NextResponse.json(
        { ok: false, field: "label", message: "Label é obrigatório." },
        { status: 400 },
      );
    }

    const sipUri = typeof body.sipUri === "string" ? body.sipUri.trim() : "";
    if (!sipUri) {
      return NextResponse.json(
        { ok: false, field: "sipUri", message: "sipUri é obrigatório." },
        { status: 400 },
      );
    }

    const authUser = typeof body.authUser === "string" ? body.authUser.trim() : "";
    if (!authUser) {
      return NextResponse.json(
        { ok: false, field: "authUser", message: "authUser é obrigatório." },
        { status: 400 },
      );
    }

    const authPassword = typeof body.authPassword === "string" ? body.authPassword : "";
    if (!authPassword) {
      return NextResponse.json(
        { ok: false, field: "authPassword", message: "authPassword é obrigatório." },
        { status: 400 },
      );
    }

    const wsServer = typeof body.wsServer === "string" ? body.wsServer.trim() : "";
    if (!wsServer) {
      return NextResponse.json(
        { ok: false, field: "wsServer", message: "wsServer é obrigatório." },
        { status: 400 },
      );
    }

    const stunServers = Array.isArray(body.stunServers)
      ? (body.stunServers as unknown[]).filter((s) => typeof s === "string").map(String)
      : [];

    const turnServer =
      body.turnServer && typeof body.turnServer === "object"
        ? (body.turnServer as { urls?: unknown; username?: unknown; credential?: unknown })
        : null;

    try {
      const ext = await createOrUpdateExtension({
        userId,
        label,
        sipUri,
        authUser,
        authPassword,
        wsServer,
        stunServers,
        turnServer: turnServer
          ? {
              urls: String(turnServer.urls ?? ""),
              username: typeof turnServer.username === "string" ? turnServer.username : undefined,
              credential: typeof turnServer.credential === "string" ? turnServer.credential : undefined,
            }
          : null,
      });
      return NextResponse.json({ extension: ext }, { status: 201 });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 400) {
        return NextResponse.json(
          { message: e instanceof Error ? e.message : "Requisição inválida." },
          { status: 400 },
        );
      }
      console.error("[sip-extensions] POST:", e);
      return NextResponse.json(
        { message: "Erro ao criar/atualizar ramal." },
        { status: 500 },
      );
    }
  });
}
