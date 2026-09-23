import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { loadAuthzContext, can } from "@/lib/authz";
import { requireStageScope } from "@/lib/authz/resource-policy";
import { runWithContext } from "@/lib/request-context";
import { deleteStage, getStageInPipeline, updateStage } from "@/services/pipelines";

type RouteContext = { params: Promise<{ id: string; stageId: string }> };

type SessionUser = {
  id: string;
  role?: string | null;
  organizationId?: string | null;
  isSuperAdmin?: boolean;
};

/**
 * Mesmo padrão usado no POST /api/pipelines/[id]/stages: resolve sessão,
 * normaliza o user e ativa o RequestContext tenant-scoped. Sem isso, o
 * `getOrgIdOrThrow()` chamado dentro de updateStage/deleteStage explode
 * e o catch genérico devolve 500 sem contexto.
 */
async function withSessionContext():
  Promise<
    | { ok: true; user: SessionUser; run: <T>(fn: () => T | Promise<T>) => T | Promise<T> }
    | { ok: false; response: NextResponse }
  > {
  const session = await auth();
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json({ message: "Não autorizado." }, { status: 401 }),
    };
  }
  const u = session.user as SessionUser;
  if (!u.id) {
    return {
      ok: false,
      response: NextResponse.json({ message: "Não autorizado." }, { status: 401 }),
    };
  }
  const run = <T>(fn: () => T | Promise<T>) =>
    runWithContext(
      {
        userId: u.id,
        organizationId: u.organizationId ?? null,
        isSuperAdmin: Boolean(u.isSuperAdmin),
      },
      fn,
    );
  return { ok: true, user: u, run };
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const sess = await withSessionContext();
    if (!sess.ok) return sess.response;
    const { user, run } = sess;

    return await run(async () => {
      const ctxAuth = await loadAuthzContext({
        userId: user.id,
        organizationId: user.organizationId ?? null,
        isSuperAdmin: Boolean(user.isSuperAdmin),
      });
      if (!can(ctxAuth, "pipeline:manage_stages")) {
        return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
      }

      const { id: pipelineId, stageId } = await context.params;
      if (!pipelineId || !stageId) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const stageRow = await getStageInPipeline(pipelineId, stageId);
      if (!stageRow) {
        return NextResponse.json({ message: "Estágio não encontrado." }, { status: 404 });
      }
      const scoped = await requireStageScope(
        { id: user.id, role: user.role ?? null, organizationId: user.organizationId ?? null, isSuperAdmin: user.isSuperAdmin },
        "edit",
        stageId,
      );
      if (scoped) return scoped;

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

      if (b.name !== undefined && (typeof b.name !== "string" || b.name.trim().length < 1)) {
        return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
      }
      if (b.color !== undefined && typeof b.color !== "string") {
        return NextResponse.json({ message: "Cor inválida." }, { status: 400 });
      }
      if (b.winProbability !== undefined) {
        if (typeof b.winProbability !== "number" || !Number.isFinite(b.winProbability)) {
          return NextResponse.json({ message: "winProbability inválido." }, { status: 400 });
        }
      }
      if (b.rottingDays !== undefined) {
        if (typeof b.rottingDays !== "number" || !Number.isInteger(b.rottingDays)) {
          return NextResponse.json({ message: "rottingDays inválido." }, { status: 400 });
        }
      }
      if (b.position !== undefined) {
        if (typeof b.position !== "number" || !Number.isInteger(b.position) || b.position < 0) {
          return NextResponse.json({ message: "position inválido." }, { status: 400 });
        }
      }
      let requiredDealFieldIds: string[] | undefined;
      if (b.requiredDealFieldIds !== undefined) {
        if (
          !Array.isArray(b.requiredDealFieldIds) ||
          b.requiredDealFieldIds.some((id) => typeof id !== "string")
        ) {
          return NextResponse.json(
            { message: "requiredDealFieldIds inválido." },
            { status: 400 },
          );
        }
        requiredDealFieldIds = b.requiredDealFieldIds;
      }

      const hasField =
        b.name !== undefined ||
        b.color !== undefined ||
        b.winProbability !== undefined ||
        b.rottingDays !== undefined ||
        b.position !== undefined ||
        requiredDealFieldIds !== undefined;
      if (!hasField) {
        return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
      }

      try {
        const stage = await updateStage(stageId, {
          name: typeof b.name === "string" ? b.name : undefined,
          color: typeof b.color === "string" ? b.color : undefined,
          winProbability: typeof b.winProbability === "number" ? b.winProbability : undefined,
          rottingDays: typeof b.rottingDays === "number" ? b.rottingDays : undefined,
          position: typeof b.position === "number" ? b.position : undefined,
          requiredDealFieldIds,
        });
        return NextResponse.json(stage);
      } catch (err: unknown) {
        if (err instanceof Error) {
          if (err.message === "INVALID_NAME") {
            return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
          }
          if (err.message === "EMPTY_UPDATE") {
            return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
          }
          if (err.message === "NOT_FOUND") {
            return NextResponse.json({ message: "Estágio não encontrado." }, { status: 404 });
          }
          if (err.message === "INVALID_STAGE_ORDER") {
            return NextResponse.json(
              { message: "Ordem de estágios inválida ou incompleta." },
              { status: 400 }
            );
          }
          if (err.message === "CANNOT_MOVE_TERMINAL_STAGE") {
            return NextResponse.json(
              { message: "Os estágios Ganho e Perdido são fixos no fim do funil." },
              { status: 409 }
            );
          }
          if (err.message === "INVALID_DEAL_FIELD") {
            return NextResponse.json(
              { message: "Selecione apenas campos personalizados do negócio." },
              { status: 400 },
            );
          }
          if (err.message === "TOO_MANY_ENTRY_FIELDS") {
            return NextResponse.json(
              { message: "No máximo 20 campos obrigatórios por etapa." },
              { status: 400 },
            );
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
        return NextResponse.json({ message: "Estágio não encontrado." }, { status: 404 });
      }
      if (code === "P2002") {
        return NextResponse.json({ message: "Conflito de posição entre estágios." }, { status: 409 });
      }
    }
    return NextResponse.json({ message: "Erro ao atualizar estágio." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const sess = await withSessionContext();
    if (!sess.ok) return sess.response;
    const { user, run } = sess;

    return await run(async () => {
      const ctxAuth = await loadAuthzContext({
        userId: user.id,
        organizationId: user.organizationId ?? null,
        isSuperAdmin: Boolean(user.isSuperAdmin),
      });
      if (!can(ctxAuth, "pipeline:manage_stages")) {
        return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
      }

      const { id: pipelineId, stageId } = await context.params;
      if (!pipelineId || !stageId) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const stageRow = await getStageInPipeline(pipelineId, stageId);
      if (!stageRow) {
        return NextResponse.json({ message: "Estágio não encontrado." }, { status: 404 });
      }
      const scoped = await requireStageScope(
        { id: user.id, role: user.role ?? null, organizationId: user.organizationId ?? null, isSuperAdmin: user.isSuperAdmin },
        "edit",
        stageId,
      );
      if (scoped) return scoped;

      try {
        await deleteStage(stageId);
        return NextResponse.json({ ok: true });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "STAGE_HAS_DEALS") {
          return NextResponse.json(
            { message: "Não é possível excluir: existem negócios neste estágio." },
            { status: 409 }
          );
        }
        if (err instanceof Error && err.message === "CANNOT_DELETE_INCOMING_STAGE") {
          return NextResponse.json(
            { message: "O estágio de entrada não pode ser excluído." },
            { status: 409 }
          );
        }
        if (err instanceof Error && err.message === "CANNOT_DELETE_TERMINAL_STAGE") {
          return NextResponse.json(
            { message: "Os estágios Ganho e Perdido são fixos e não podem ser excluídos." },
            { status: 409 }
          );
        }
        throw err;
      }
    });
  } catch (e: unknown) {
    console.error(e);
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025") {
      return NextResponse.json({ message: "Estágio não encontrado." }, { status: 404 });
    }
    return NextResponse.json({ message: "Erro ao excluir estágio." }, { status: 500 });
  }
}
