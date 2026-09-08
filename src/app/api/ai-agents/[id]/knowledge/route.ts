import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  createKnowledgeDoc,
  KnowledgeDocError,
  listKnowledgeDocs,
} from "@/services/ai/knowledge-docs";

/**
 * GET — lista paginada dos documentos de conhecimento do agente.
 * POST — cria novo doc a partir de texto colado e dispara indexação.
 *
 * Arquivos binários (PDF/DOCX) ficam para uma subfase: por ora
 * aceitamos apenas `{ title, content }` em JSON, que cobre a maior
 * parte dos playbooks, FAQs e roteiros que os usuários já têm em md/doc.
 *
 * Isolamento: `prisma` scoped injeta `organizationId`; o `agentId` da URL
 * entra no where de todas as queries (ver `knowledge-docs.ts`).
 */

// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "ai_agent:view");
    if (denied) return denied;

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const result = await listKnowledgeDocs({
      agentId: id,
      page: Number(searchParams.get("page")) || 1,
      perPage: Number(searchParams.get("perPage")) || undefined,
      search: searchParams.get("q") ?? undefined,
    });
    return NextResponse.json(result);
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "ai_agent:edit");
    if (denied) return denied;

    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    try {
      const doc = await createKnowledgeDoc(id, {
        title: body.title,
        content: body.content,
        validFrom: body.validFrom,
        validUntil: body.validUntil,
        expiredBehavior: body.expiredBehavior,
        expiredInstruction: body.expiredInstruction,
      });
      return NextResponse.json(doc, { status: 201 });
    } catch (e) {
      if (e instanceof KnowledgeDocError) {
        return NextResponse.json({ message: e.message }, { status: e.status });
      }
      throw e;
    }
  });
}
