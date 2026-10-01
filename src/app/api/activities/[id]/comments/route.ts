import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { getActivityById } from "@/services/activities";
import {
  COMMENT_CONTENT_MAX,
  createActivityComment,
  listActivityComments,
  listActivityCommentHistory,
} from "@/services/activity-comments";
import {
  canAccessActivity,
  canViewActivityCommentHistory,
  type TaskViewer,
} from "@/services/task-visibility";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/activities/[id]/comments");

type RouteContext = { params: Promise<{ id: string }> };

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
  if (!activity) return { status: 404 as const, activity: null };
  if (!(await canAccessActivity(viewer, activity))) {
    return { status: 404 as const, activity: null };
  }
  return { status: 200 as const, activity };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const { searchParams } = new URL(request.url);
      const history = searchParams.get("history") === "1" || searchParams.get("history") === "true";

      const loaded = await loadAccessibleActivity(id, viewerFromAuth(authResult.user));
      if (!loaded.activity) {
        return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
      }

      if (history) {
        if (!canViewActivityCommentHistory(viewerFromAuth(authResult.user))) {
          return NextResponse.json(
            { message: "Apenas administradores e gestores podem ver o histórico." },
            { status: 403 },
          );
        }
        const revisions = await listActivityCommentHistory(id);
        return NextResponse.json({ items: revisions });
      }

      const items = await listActivityComments(id);
      return NextResponse.json({ items });
    });
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao listar comentários." }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id } = await context.params;
      if (!id) {
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

      const loaded = await loadAccessibleActivity(id, viewerFromAuth(authResult.user));
      if (!loaded.activity) {
        return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
      }

      try {
        const comment = await createActivityComment({
          activityId: id,
          authorId: authResult.user.id,
          content: contentRaw,
          activityTitle: loaded.activity.title,
          dealId: loaded.activity.dealId,
          contactId: loaded.activity.contactId,
        });
        return NextResponse.json(comment, { status: 201 });
      } catch (err: unknown) {
        if (err instanceof Error) {
          if (err.message === "INVALID_CONTENT") {
            return NextResponse.json({ message: "Conteúdo é obrigatório." }, { status: 400 });
          }
          if (err.message === "CONTENT_TOO_LONG") {
            return NextResponse.json(
              { message: `Conteúdo excede ${COMMENT_CONTENT_MAX} caracteres.` },
              { status: 400 },
            );
          }
        }
        throw err;
      }
    });
  } catch (e) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao criar comentário." }, { status: 500 });
  }
}
