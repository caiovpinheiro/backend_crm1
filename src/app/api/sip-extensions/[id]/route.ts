import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  getExtension,
  updateExtension,
  deleteExtension,
} from "@/services/sip-extensions";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/sip-extensions/[id]");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/sip-extensions/[id]
 * Detalhe de um ramal.
 * RBAC: sip_extension:view
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:view");
    if (denied) return denied;

    const ext = await getExtension(id);
    if (!ext) {
      return NextResponse.json({ message: "Ramal não encontrado." }, { status: 404 });
    }
    return NextResponse.json({ extension: ext });
  });
}

/**
 * PUT /api/sip-extensions/[id]
 * Atualiza um ramal existente.
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

    const existing = await getExtension(id);
    if (!existing) {
      return NextResponse.json({ message: "Ramal não encontrado." }, { status: 404 });
    }

    const label = typeof body.label === "string" ? body.label.trim() : existing.label;
    const sipUri = typeof body.sipUri === "string" ? body.sipUri.trim() : existing.sipUri;
    const authUser = typeof body.authUser === "string" ? body.authUser.trim() : existing.authUser;
    const wsServer = typeof body.wsServer === "string" ? body.wsServer.trim() : existing.wsServer;

    // authPassword é obrigatório no upsert (sempre re-cifra)
    const authPassword = typeof body.authPassword === "string" ? body.authPassword : "";
    if (!authPassword) {
      return NextResponse.json(
        { ok: false, field: "authPassword", message: "authPassword é obrigatório na atualização." },
        { status: 400 },
      );
    }

    const stunServers = Array.isArray(body.stunServers)
      ? (body.stunServers as unknown[]).filter((s) => typeof s === "string").map(String)
      : (existing.stunServers as string[]);

    const turnServer =
      body.turnServer && typeof body.turnServer === "object"
        ? (body.turnServer as { urls?: unknown; username?: unknown; credential?: unknown })
        : null;

    try {
      const ext = await updateExtension(id, {
        userId: existing.userId,
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
              credential:
                typeof turnServer.credential === "string" ? turnServer.credential : undefined,
            }
          : null,
        status: typeof body.status === "string" ? (body.status as "ACTIVE" | "INACTIVE") : undefined,
      });
      return NextResponse.json({ extension: ext });
    } catch (e) {
      log.error({ err: e }, "[sip-extensions] PUT falhou");
      return NextResponse.json({ message: "Erro ao atualizar ramal." }, { status: 500 });
    }
  });
}

/**
 * DELETE /api/sip-extensions/[id]
 * Remove um ramal.
 * RBAC: sip_extension:manage
 */
export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:manage");
    if (denied) return denied;

    const existing = await getExtension(id);
    if (!existing) {
      return NextResponse.json({ message: "Ramal não encontrado." }, { status: 404 });
    }

    try {
      await deleteExtension(id);
      return NextResponse.json({ ok: true });
    } catch (e) {
      log.error({ err: e }, "[sip-extensions] DELETE falhou");
      return NextResponse.json({ message: "Erro ao remover ramal." }, { status: 500 });
    }
  });
}
