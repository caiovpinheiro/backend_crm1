import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  deleteKnowledgeDoc,
  getKnowledgeDoc,
  KnowledgeDocError,
  reindexKnowledgeDoc,
  updateKnowledgeDoc,
} from "@/services/ai/knowledge-docs";

/**
 * GET    — documento com o texto integral (para visualizar/editar).
 * PUT    — salva título e/ou conteúdo; reindexa se o texto mudou.
 * PATCH  — `{ action: "reindex" }`, destrava doc FAILED sem reescrever.
 * DELETE — remove o doc (cascata apaga chunks e embeddings).
 *
 * Todo acesso filtra por `agentId` da URL + `organizationId` injetado pela
 * extension do `prisma` scoped.
 */

function toResponse(e: unknown): NextResponse {
  if (e instanceof KnowledgeDocError) {
    return NextResponse.json({ message: e.message }, { status: e.status });
  }
  throw e;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "ai_agent:view");
    if (denied) return denied;

    const { id, docId } = await params;
    try {
      return NextResponse.json(await getKnowledgeDoc(id, docId));
    } catch (e) {
      return toResponse(e);
    }
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "ai_agent:edit");
    if (denied) return denied;

    const { id, docId } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    try {
      const doc = await updateKnowledgeDoc(id, docId, {
        title: body.title,
        content: body.content,
        validFrom: body.validFrom,
        validUntil: body.validUntil,
        expiredBehavior: body.expiredBehavior,
        expiredInstruction: body.expiredInstruction,
      });
      return NextResponse.json(doc);
    } catch (e) {
      return toResponse(e);
    }
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "ai_agent:edit");
    if (denied) return denied;

    const { id, docId } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (body.action !== "reindex") {
      return NextResponse.json({ message: "Ação inválida." }, { status: 400 });
    }
    try {
      return NextResponse.json(await reindexKnowledgeDoc(id, docId));
    } catch (e) {
      return toResponse(e);
    }
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "ai_agent:edit");
    if (denied) return denied;

    const { id, docId } = await params;
    try {
      await deleteKnowledgeDoc(id, docId);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return toResponse(e);
    }
  });
}
