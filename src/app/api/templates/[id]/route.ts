import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  deleteTemplate,
  getTemplateById,
  updateTemplate,
  normalizeTemplateAttachments,
  templateSequenceLimitError,
} from "@/services/templates";

type Ctx = { params: Promise<{ id: string }> };

// Bug 29/mai/26: ver comentário em ../route.ts. Mesma migração:
// auth() direto → withOrgContext, garantindo que a Prisma Extension
// e o `withOrgFromCtx` interno tenham contexto ativo nas operações
// de update/delete (que escrevem em messageTemplate).
export async function GET(_req: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    try {
      const { id } = await ctx.params;
      const template = await getTemplateById(id);
      if (!template)
        return NextResponse.json({ message: "Template não encontrado." }, { status: 404 });
      return NextResponse.json(template);
    } catch (e) {
      console.error("[templates/:id GET]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao carregar template." },
        { status: 500 },
      );
    }
  });
}

export async function PUT(request: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    try {
      const { id } = await ctx.params;
      const body = (await request.json()) as Record<string, unknown>;

      let attachments: ReturnType<typeof normalizeTemplateAttachments> | undefined;
      if ("attachments" in body) {
        if (!Array.isArray(body.attachments)) {
          return NextResponse.json(
            { message: "attachments deve ser uma lista." },
            { status: 400 },
          );
        }
        const limitError = templateSequenceLimitError(body.attachments);
        if (limitError) {
          return NextResponse.json({ message: limitError }, { status: 400 });
        }
        attachments = normalizeTemplateAttachments(body.attachments);
      }

      const template = await updateTemplate(id, {
        name: typeof body.name === "string" ? body.name.trim() : undefined,
        content: typeof body.content === "string" ? body.content.trim() : undefined,
        category:
          typeof body.category === "string"
            ? body.category.trim() || undefined
            : undefined,
        language:
          typeof body.language === "string"
            ? body.language.trim() || undefined
            : undefined,
        status:
          typeof body.status === "string"
            ? (body.status as Parameters<typeof updateTemplate>[1]["status"])
            : undefined,
        channelType:
          body.channelType === null
            ? null
            : typeof body.channelType === "string"
              ? (body.channelType as Parameters<typeof updateTemplate>[1]["channelType"])
              : undefined,
        mediaUrl:
          "mediaUrl" in body
            ? (typeof body.mediaUrl === "string" && body.mediaUrl ? body.mediaUrl : null)
            : undefined,
        mediaType:
          "mediaType" in body
            ? (typeof body.mediaType === "string" && body.mediaType ? body.mediaType : null)
            : undefined,
        mediaName:
          "mediaName" in body
            ? (typeof body.mediaName === "string" && body.mediaName ? body.mediaName : null)
            : undefined,
        attachments,
      });
      return NextResponse.json(template);
    } catch (e) {
      console.error("[templates/:id PUT]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao atualizar template." },
        { status: 500 },
      );
    }
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    try {
      const { id } = await ctx.params;
      await deleteTemplate(id);
      return NextResponse.json({ ok: true });
    } catch (e) {
      console.error("[templates/:id DELETE]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao excluir template." },
        { status: 500 },
      );
    }
  });
}
