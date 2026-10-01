import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { loadAuthzContext, can } from "@/lib/authz";
import { requirePipelineScope } from "@/lib/authz/resource-policy";
import { deletePipeline, getPipelineById, updatePipeline } from "@/services/pipelines";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/pipelines/[id]");

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const ctxAuth = await loadAuthzContext({
      userId: session.user.id,
      organizationId: (session.user as { organizationId?: string | null }).organizationId ?? null,
      isSuperAdmin: Boolean((session.user as { isSuperAdmin?: boolean }).isSuperAdmin),
    });
    if (!can(ctxAuth, "pipeline:view")) {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const pipeline = await getPipelineById(id);
    if (!pipeline) {
      return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
    }
    const scoped = await requirePipelineScope(
      session.user as { id: string; role?: string | null; organizationId: string | null; isSuperAdmin?: boolean },
      "view",
      pipeline.id,
    );
    if (scoped) return scoped;

    return NextResponse.json(pipeline);
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao buscar pipeline." }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const ctxAuth = await loadAuthzContext({
      userId: session.user.id,
      organizationId: (session.user as { organizationId?: string | null }).organizationId ?? null,
      isSuperAdmin: Boolean((session.user as { isSuperAdmin?: boolean }).isSuperAdmin),
    });
    if (!can(ctxAuth, "pipeline:edit")) {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }

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
    const existing = await getPipelineById(id);
    if (!existing) {
      return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
    }
    const scoped = await requirePipelineScope(
      session.user as { id: string; role?: string | null; organizationId: string | null; isSuperAdmin?: boolean },
      "edit",
      existing.id,
    );
    if (scoped) return scoped;

    if (b.name !== undefined && (typeof b.name !== "string" || b.name.trim().length < 1)) {
      return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
    }
    if (b.isDefault !== undefined && typeof b.isDefault !== "boolean") {
      return NextResponse.json({ message: "isDefault inválido." }, { status: 400 });
    }
    if (b.allowDuplicateDeals !== undefined && typeof b.allowDuplicateDeals !== "boolean") {
      return NextResponse.json({ message: "allowDuplicateDeals inválido." }, { status: 400 });
    }

    if (
      b.name === undefined &&
      b.isDefault === undefined &&
      b.allowDuplicateDeals === undefined
    ) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    try {
      const pipeline = await updatePipeline(id, {
        name: typeof b.name === "string" ? b.name : undefined,
        isDefault: typeof b.isDefault === "boolean" ? b.isDefault : undefined,
        allowDuplicateDeals:
          typeof b.allowDuplicateDeals === "boolean" ? b.allowDuplicateDeals : undefined,
      });
      return NextResponse.json(pipeline);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === "INVALID_NAME") {
          return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
        }
        if (err.message === "EMPTY_UPDATE") {
          return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
        }
        if (err.message.startsWith("DUPLICATE_DEALS:")) {
          return NextResponse.json(
            { message: err.message.slice("DUPLICATE_DEALS:".length) },
            { status: 500 },
          );
        }
      }
      throw err;
    }
  } catch (e: unknown) {
    log.error({ err: e }, "PUT falhou");
    if (typeof e === "object" && e !== null && "code" in e) {
      const code = (e as { code: string }).code;
      if (code === "P2025") {
        return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
      }
    }
    return NextResponse.json({ message: "Erro ao atualizar pipeline." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const ctxAuth = await loadAuthzContext({
      userId: session.user.id,
      organizationId: (session.user as { organizationId?: string | null }).organizationId ?? null,
      isSuperAdmin: Boolean((session.user as { isSuperAdmin?: boolean }).isSuperAdmin),
    });
    if (!can(ctxAuth, "pipeline:delete")) {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const existing = await getPipelineById(id);
    if (!existing) {
      return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
    }
    const scoped = await requirePipelineScope(
      session.user as { id: string; role?: string | null; organizationId: string | null; isSuperAdmin?: boolean },
      "edit",
      existing.id,
    );
    if (scoped) return scoped;

    try {
      await deletePipeline(id);
      return NextResponse.json({ ok: true });
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e) {
        const code = (e as { code: string }).code;
        if (code === "P2003" || code === "P2014") {
          return NextResponse.json(
            { message: "Não é possível excluir: existem negócios ou vínculos ativos." },
            { status: 409 }
          );
        }
        if (code === "P2025") {
          return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
        }
      }
      throw e;
    }
  } catch (e) {
    log.error({ err: e }, "DELETE falhou");
    return NextResponse.json({ message: "Erro ao excluir pipeline." }, { status: 500 });
  }
}
