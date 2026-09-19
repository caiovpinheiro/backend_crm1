import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { createActivity, getActivities, isValidActivityType } from "@/services/activities";
import { getTaskVisibility } from "@/services/task-visibility";
import { createDealEvent } from "@/services/deals";
import { logEvent } from "@/services/activity-log";

function parseIntParam(v: string | null, fallback: number) {
  if (v === null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const { searchParams } = new URL(request.url);
    const dealId = searchParams.get("dealId") ?? undefined;
    const contactId = searchParams.get("contactId") ?? undefined;
    const userId = searchParams.get("userId") ?? undefined;
    const departmentId = searchParams.get("departmentId") ?? undefined;
    const typeRaw = searchParams.get("type");
    const type = typeRaw && isValidActivityType(typeRaw) ? typeRaw : undefined;
    const completedParam = searchParams.get("completed");
    let completed: boolean | undefined;
    if (completedParam === "true") completed = true;
    else if (completedParam === "false") completed = false;
    const page = parseIntParam(searchParams.get("page"), 1);
    const perPage = parseIntParam(searchParams.get("perPage"), 20);

    // Visibilidade por departamento: ADMIN/MANAGER veem tudo; demais veem
    // apenas suas tarefas + as dos seus departamentos. `scope` refina:
    //   mine        → só as minhas (userId = eu)
    //   department  → só as dos meus departamentos
    //   all/ausente → tudo que posso ver (own + departamentos)
    //
    // IMPORTANTE: só aplicamos a visibilidade de tarefa na LISTA GLOBAL
    // (tela de Tarefas). Em views escopadas por entidade (dealId/contactId
    // — ex.: aba de atividades de um negócio), mostramos todas as
    // atividades daquela entidade; o acesso já é gated pela visibilidade
    // do próprio deal/contato.
    const scope = searchParams.get("scope");
    let viewerWhere: Prisma.ActivityWhereInput = {};
    if (!dealId && !contactId) {
      const visibility = await getTaskVisibility(authResult.user);
      viewerWhere = visibility.where;
      if (scope === "mine") {
        viewerWhere = { userId: authResult.user.id };
      } else if (scope === "department") {
        viewerWhere = visibility.departmentIds.length
          ? { departmentId: { in: visibility.departmentIds } }
          : // Sem departamentos → não retorna nada nesse escopo.
            { id: "__none__" };
      }
    }

    const result = await getActivities({
      dealId,
      contactId,
      userId,
      departmentId,
      type,
      completed,
      page,
      perPage,
      viewerWhere,
    });

    return NextResponse.json(result);
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao listar atividades." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
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

    if (typeof b.type !== "string" || !isValidActivityType(b.type)) {
      return NextResponse.json({ message: "Tipo de atividade inválido." }, { status: 400 });
    }
    if (typeof b.title !== "string" || b.title.trim().length < 1) {
      return NextResponse.json({ message: "Título é obrigatório." }, { status: 400 });
    }

    if (b.completed !== undefined && typeof b.completed !== "boolean") {
      return NextResponse.json({ message: "completed inválido." }, { status: 400 });
    }

    let scheduledAt: Date | string | null | undefined;
    if (b.scheduledAt === null) {
      scheduledAt = null;
    } else if (typeof b.scheduledAt === "string") {
      const d = new Date(b.scheduledAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ message: "scheduledAt inválido." }, { status: 400 });
      }
      scheduledAt = d;
    } else if (b.scheduledAt !== undefined) {
      return NextResponse.json({ message: "scheduledAt inválido." }, { status: 400 });
    }

    let completedAt: Date | string | null | undefined;
    if (b.completedAt === null) {
      completedAt = null;
    } else if (typeof b.completedAt === "string") {
      const d = new Date(b.completedAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ message: "completedAt inválido." }, { status: 400 });
      }
      completedAt = d;
    } else if (b.completedAt !== undefined) {
      return NextResponse.json({ message: "completedAt inválido." }, { status: 400 });
    }

    try {
      const resolvedDealId =
        b.dealId === null ? null : typeof b.dealId === "string" ? b.dealId : undefined;

      // Responsável: departamento (compartilhada) e/ou usuário. Se nada
      // for informado, atribui ao próprio criador (compat retroativa).
      const departmentId =
        typeof b.departmentId === "string" && b.departmentId ? b.departmentId : undefined;
      const assigneeUserId =
        typeof b.userId === "string" && b.userId ? b.userId : undefined;
      const resolvedUserId = departmentId
        ? (assigneeUserId ?? null)
        : (assigneeUserId ?? authResult.user.id);

      const activity = await createActivity({
        type: b.type,
        title: b.title,
        description:
          b.description === null
            ? null
            : typeof b.description === "string"
              ? b.description
              : undefined,
        completed: typeof b.completed === "boolean" ? b.completed : undefined,
        scheduledAt,
        completedAt,
        contactId:
          b.contactId === null
            ? null
            : typeof b.contactId === "string"
              ? b.contactId
              : undefined,
        dealId: resolvedDealId,
        userId: resolvedUserId,
        departmentId,
        createdById: authResult.user.id,
      });

      if (resolvedDealId) {
        const uid = authResult.user.id;
        createDealEvent(resolvedDealId, uid, "ACTIVITY_ADDED", {
          activityType: b.type,
          title: b.title,
        }).catch(() => {});
      } else {
        // Tarefa criada ligada só a contato (ou solta) — também loga.
        void logEvent({
          type: "ACTIVITY_ADDED",
      actorType: "HUMAN",
          entityType: "ACTIVITY",
          entityId: activity.id,
          entityLabel: b.title,
          contactId: typeof b.contactId === "string" ? b.contactId : null,
          meta: { activityType: b.type, title: b.title },
        });
      }

      return NextResponse.json(activity, { status: 201 });
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === "INVALID_TITLE") {
          return NextResponse.json({ message: "Título inválido." }, { status: 400 });
        }
        if (err.message === "INVALID_DEPARTMENT") {
          return NextResponse.json({ message: "Departamento inválido." }, { status: 400 });
        }
        if (err.message === "MISSING_ASSIGNEE") {
          return NextResponse.json(
            { message: "Informe um responsável (usuário ou departamento)." },
            { status: 400 },
          );
        }
      }
      throw err;
    }
    });
  } catch (e: unknown) {
    console.error(e);
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2003") {
      return NextResponse.json({ message: "Referência inválida." }, { status: 400 });
    }
    return NextResponse.json({ message: "Erro ao criar atividade." }, { status: 500 });
  }
}
