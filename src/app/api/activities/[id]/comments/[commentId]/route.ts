import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { getActivityById } from "@/services/activities";
import {
  COMMENT_CONTENT_MAX,
  softDeleteActivityComment,
  updateActivityComment,
} from "@/services/activity-comments";
import { canAccessActivity, type TaskViewer } from "@/services/task-visibility";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/activities/[id]/comments/[commentId]");

type RouteContext = { params: Promise<{ id: string; commentId: string }> };

function viewerFromAuth(user: {
  id: string;
  role?: string | null;
  organizationId?: string | null;
  isSuperAdmin?: boolean;
}): TaskViewer {
  return {
    id: user.id,
    organizationId: user.organizationId ?? null,
    role: user.role ?? null,
    isSuperAdmin: Boolean(user.isSuperAdmin),
  };
}

async function loadAccessibleActivity(activityId: string, viewer: TaskViewer) {
  const activity = await getActivityById(activityId);
  if (!activity) return null;
  if (!(await canAccessActivity(viewer, activity))) return null;
  return activity;
}

function mapMutationError(err: unknown): NextResponse | null {
  if (!(err instanceof Error)) return null;
  if (err.message === "NOT_FOUND") {
    return NextResponse.json({ message: "Comentário não encontrado." }, { status: 404 });
  }
  if (err.message === "FORBIDDEN_NOT_AUTHOR") {
    return NextResponse.json(
      { message: "Apenas o autor pode alterar este comentário." },
      { status: 403 },
    );
  }
  if (err.message === "INVALID_CONTENT") {
    return NextResponse.json({ message: "Conteúdo é obrigatório." }, { status: 400 });
  }
  if (err.message === "CONTENT_TOO_LONG") {
    return NextResponse.json(
      { message: `Conteúdo excede ${COMMENT_CONTENT_MAX} caracteres.` },
      { status: 400 },
    );
  }
  return null;
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id, commentId } = await context.params;
      if (!id || !commentId) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
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

      const contentRaw = (body as Record<string, unknown>).content;
      if (typeof contentRaw !== "string") {
        return NextResponse.json({ message: "Conteúdo é obrigatório." }, { status: 400 });
      }

      const activity = await loadAccessibleActivity(id, viewerFromAuth(authResult.user));
      if (!activity) {
        return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
      }

      try {
        const comment = await updateActivityComment({
          activityId: id,
          commentId,
          actorId: authResult.user.id,
          content: contentRaw,
          activityTitle: activity.title,
          dealId: activity.dealId,
          contactId: activity.contactId,
        });
        return NextResponse.json(comment);
      } catch (err: unknown) {
        const mapped = mapMutationError(err);
        if (mapped) return mapped;
        throw err;
      }
    });
  } catch (e) {
    log.error({ err: e }, "PUT falhou");
    return NextResponse.json({ message: "Erro ao editar comentário." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id, commentId } = await context.params;
      if (!id || !commentId) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const activity = await loadAccessibleActivity(id, viewerFromAuth(authResult.user));
      if (!activity) {
        return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
      }

      try {
        const comment = await softDeleteActivityComment({
          activityId: id,
          commentId,
          actorId: authResult.user.id,
          activityTitle: activity.title,
          dealId: activity.dealId,
          contactId: activity.contactId,
        });
        return NextResponse.json(comment);
      } catch (err: unknown) {
        const mapped = mapMutationError(err);
        if (mapped) return mapped;
        throw err;
      }
    });
  } catch (e) {
    log.error({ err: e }, "DELETE falhou");
    return NextResponse.json({ message: "Erro ao excluir comentário." }, { status: 500 });
  }
}
