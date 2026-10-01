import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { loadAuthzContext, can } from "@/lib/authz";
import { requirePipelineScope } from "@/lib/authz/resource-policy";
import { runWithContext } from "@/lib/request-context";
import { createStage, getPipelineMeta, reorderStages } from "@/services/pipelines";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/pipelines/[id]/stages");

type RouteContext = { params: Promise<{ id: string }> };

type SessionUser = {
  id: string;
  role?: string | null;
  organizationId?: string | null;
  isSuperAdmin?: boolean;
};

/**
 * Resolve a session do NextAuth e ja entrega o user num shape comum +
 * ativa o RequestContext tenant-scoped via runWithContext. Sem isso, o
 * `getOrgIdOrThrow()` dentro dos services (ex.: createStage) explode com
 * "organization context ausente" e o handler retorna 500 genérico.
 *
 * Retorna ou:
 *   - { ok: true, run } onde `run(fn)` executa fn dentro do ctx, OU
 *   - { ok: false, response } com o 401 pronto.
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

export async function POST(request: Request, context: RouteContext) {
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

      const { id: pipelineId } = await context.params;
      if (!pipelineId) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const meta = await getPipelineMeta(pipelineId);
      if (!meta) {
        return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
      }
      const scoped = await requirePipelineScope(
        { id: user.id, role: user.role ?? null, organizationId: user.organizationId ?? null, isSuperAdmin: user.isSuperAdmin },
        "edit",
        pipelineId,
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
      if (typeof b.name !== "string" || b.name.trim().length < 1) {
        return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
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

      try {
        const stage = await createStage(pipelineId, {
          name: b.name,
          color: typeof b.color === "string" ? b.color : undefined,
          winProbability: typeof b.winProbability === "number" ? b.winProbability : undefined,
          rottingDays: typeof b.rottingDays === "number" ? b.rottingDays : undefined,
          position: typeof b.position === "number" ? b.position : undefined,
        });
        return NextResponse.json(stage, { status: 201 });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "INVALID_NAME") {
          return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
        }
        throw err;
      }
    });
  } catch (e: unknown) {
    log.error({ err: e }, "POST falhou");
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2003") {
      return NextResponse.json({ message: "Referência inválida." }, { status: 400 });
    }
    return NextResponse.json({ message: "Erro ao criar estágio." }, { status: 500 });
  }
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

      const { id: pipelineId } = await context.params;
      if (!pipelineId) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const meta = await getPipelineMeta(pipelineId);
      if (!meta) {
        return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
      }
      const scoped = await requirePipelineScope(
        { id: user.id, role: user.role ?? null, organizationId: user.organizationId ?? null, isSuperAdmin: user.isSuperAdmin },
        "edit",
        pipelineId,
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
      if (!Array.isArray(b.stageIds) || b.stageIds.some((x) => typeof x !== "string")) {
        return NextResponse.json({ message: "stageIds deve ser um array de strings." }, { status: 400 });
      }

      try {
        await reorderStages(pipelineId, b.stageIds as string[]);
        return NextResponse.json({ ok: true });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "INVALID_STAGE_ORDER") {
          return NextResponse.json(
            { message: "Ordem de estágios inválida ou incompleta." },
            { status: 400 }
          );
        }
        throw err;
      }
    });
  } catch (e) {
    log.error({ err: e }, "PUT falhou");
    return NextResponse.json({ message: "Erro ao reordenar estágios." }, { status: 500 });
  }
}
