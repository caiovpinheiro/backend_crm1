import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { deleteActivity, getActivityById, isValidActivityType, updateActivity } from "@/services/activities";
import { canAccessActivity, type TaskViewer } from "@/services/task-visibility";
import { createDealEvent } from "@/services/deals";
import { logEvent } from "@/services/activity-log";

type RouteContext = { params: Promise<{ id: string }> };

function viewerFromSession(user: {
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

export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const activity = await getActivityById(id);
      if (!activity) {
        return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
      }

      if (!(await canAccessActivity(viewerFromSession(authResult.user), activity))) {
        return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
      }

      return NextResponse.json(activity);
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao buscar atividade." }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
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

    const b = body as Record<string, unknown>;

    const existing = await getActivityById(id);
    if (!existing) {
      return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
    }

    if (!(await canAccessActivity(viewerFromSession(authResult.user), existing))) {
      return NextResponse.json({ message: "Sem permissão para editar esta tarefa." }, { status: 403 });
    }

    if (b.type !== undefined && (typeof b.type !== "string" || !isValidActivityType(b.type))) {
      return NextResponse.json({ message: "Tipo de atividade inválido." }, { status: 400 });
    }
    if (b.title !== undefined && (typeof b.title !== "string" || b.title.trim().length < 1)) {
      return NextResponse.json({ message: "Título inválido." }, { status: 400 });
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

    const data = {
      type: typeof b.type === "string" && isValidActivityType(b.type) ? b.type : undefined,
      title: typeof b.title === "string" ? b.title : undefined,
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
      dealId:
        b.dealId === null ? null : typeof b.dealId === "string" ? b.dealId : undefined,
      userId:
        b.userId === null ? null : typeof b.userId === "string" ? b.userId : undefined,
      departmentId:
        b.departmentId === null
          ? null
          : typeof b.departmentId === "string"
            ? b.departmentId
            : undefined,
    };

    const payload = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined)
    ) as Parameters<typeof updateActivity>[1];

    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    try {
      const activity = await updateActivity(id, payload);

      const targetDealId = typeof b.dealId === "string" ? b.dealId : existing.dealId;
      const targetContactId =
        typeof b.contactId === "string" ? b.contactId : existing.contactId;
      const uid = authResult.user.id;
      const orgId = existing.organizationId ?? authResult.user.organizationId;

      // Emissor granular de eventos de tarefa. Antes só logávamos quando
      // havia deal (createDealEvent), e com um único ACTIVITY_UPDATED
      // genérico. Agora:
      //   - deal-bound  → createDealEvent (preserva a timeline do deal)
      //   - contato-only→ logEvent(entityType=ACTIVITY) — antes ficava
      //                   sem nenhum log
      // E separamos por natureza (prazo, descrição, título, resultado)
      // conforme pedido (granularidade estilo Kommo).
      const emitActivityEvent = (
        type: string,
        meta: Record<string, unknown>,
        field?: string,
        oldV?: string | null,
        newV?: string | null,
      ) => {
        if (targetDealId) {
          createDealEvent(targetDealId, uid, type, {
            ...meta,
            ...(field ? { field } : {}),
            ...(oldV !== undefined ? { from: oldV } : {}),
            ...(newV !== undefined ? { to: newV } : {}),
          }).catch(() => {});
        } else {
          void logEvent({
            type,
            entityType: "ACTIVITY",
            entityId: id,
            entityLabel: activity.title,
            contactId: targetContactId ?? null,
            field: field ?? null,
            oldValue: oldV ?? null,
            newValue: newV ?? null,
            meta,
            organizationId: orgId,
          });
        }
      };

      const justCompleted = b.completed === true && !existing.completed;
      if (justCompleted) {
        // "Resultado registrado na tarefa": no nosso modelo o resultado
        // é a descrição preenchida ao concluir. Vai no meta pra auditoria.
        emitActivityEvent("ACTIVITY_COMPLETED", {
          title: activity.title,
          activityType: activity.type,
          result: activity.description ?? null,
        });
      }

      // Alteração de prazo
      if (b.scheduledAt !== undefined) {
        const oldISO = existing.scheduledAt
          ? new Date(existing.scheduledAt).toISOString()
          : null;
        const newISO = activity.scheduledAt
          ? new Date(activity.scheduledAt).toISOString()
          : null;
        if (oldISO !== newISO) {
          emitActivityEvent(
            "ACTIVITY_DUE_CHANGED",
            { title: activity.title },
            "scheduledAt",
            oldISO,
            newISO,
          );
        }
      }

      // Alteração de descrição
      if (
        typeof b.description === "string" &&
        b.description !== existing.description
      ) {
        emitActivityEvent(
          "ACTIVITY_DESCRIPTION_CHANGED",
          { title: activity.title },
          "description",
          existing.description ?? null,
          activity.description ?? null,
        );
      }

      // Renomeação
      if (typeof b.title === "string" && b.title !== existing.title) {
        emitActivityEvent(
          "ACTIVITY_RENAMED",
          { activityType: activity.type },
          "title",
          existing.title,
          activity.title,
        );
      }

      // Mudança de tipo
      if (typeof b.type === "string" && b.type !== existing.type) {
        emitActivityEvent(
          "ACTIVITY_UPDATED",
          { title: activity.title },
          "type",
          existing.type,
          activity.type,
        );
      }

      return NextResponse.json(activity);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === "INVALID_TITLE") {
          return NextResponse.json({ message: "Título inválido." }, { status: 400 });
        }
        if (err.message === "EMPTY_UPDATE") {
          return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
        }
        if (err.message === "INVALID_DEPARTMENT") {
          return NextResponse.json({ message: "Departamento inválido." }, { status: 400 });
        }
      }
      throw err;
    }
    });
  } catch (e: unknown) {
    console.error(e);
    if (typeof e === "object" && e !== null && "code" in e) {
      const code = (e as { code: string }).code;
      if (code === "P2025") {
        return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
      }
      if (code === "P2003") {
        return NextResponse.json({ message: "Referência inválida." }, { status: 400 });
      }
    }
    return NextResponse.json({ message: "Erro ao atualizar atividade." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const existing = await getActivityById(id);
    if (!existing) {
      return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
    }

    if (!(await canAccessActivity(viewerFromSession(authResult.user), existing))) {
      return NextResponse.json({ message: "Sem permissão para excluir esta tarefa." }, { status: 403 });
    }

    await deleteActivity(id);

    const uid = authResult.user.id;
    const orgId = existing.organizationId ?? authResult.user.organizationId;
    if (existing.dealId) {
      createDealEvent(existing.dealId, uid, "ACTIVITY_DELETED", {
        title: existing.title,
        activityType: existing.type,
      }).catch(() => {});
    } else {
      // Tarefa ligada apenas a contato (ou solta) também é auditada.
      void logEvent({
        type: "ACTIVITY_DELETED",
        entityType: "ACTIVITY",
        entityId: id,
        entityLabel: existing.title,
        contactId: existing.contactId ?? null,
        meta: { title: existing.title, activityType: existing.type },
        organizationId: orgId,
      });
    }

    return NextResponse.json({ ok: true });
    });
  } catch (e: unknown) {
    console.error(e);
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025") {
      return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
    }
    return NextResponse.json({ message: "Erro ao excluir atividade." }, { status: 500 });
  }
}
