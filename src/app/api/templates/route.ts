import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import { withOrgContext } from "@/lib/auth-helpers";
import {
  createTemplate,
  getTemplates,
  normalizeTemplateAttachments,
  templateSequenceLimitError,
} from "@/services/templates";

// Bug 29/mai/26: usavamos `auth()` direto. createTemplate chama
// `withOrgFromCtx({...})` que exige RequestContext ativo, e
// getTemplates depende da Prisma Extension multi-tenant pra filtrar
// por organizationId. Sem `withOrgContext` envolvendo o handler:
//   - GET retornava silenciosamente templates de outras orgs ou nada
//     (`__none__` filter), dependendo do estado do AsyncLocalStorage.
//   - POST falhava com 500 silencioso porque `withOrgFromCtx` jogava
//     erro genérico capturado pelo catch.
// UI mostrava "Criar" sem efeito visual — clique morria no 500.
// Migrado pra `withOrgContext` (padrão das demais 26 rotas corrigidas).
// Auth hibrida (Bearer OU sessao) no GET: o node do n8n monta o dropdown de
// "modelo interno" a partir daqui. Leitura ja e tenant-scoped pela Prisma
// Extension via `withApiAuthContext`. O POST segue so por sessao — criar
// modelo continua sendo acao de UI.
export async function GET(request: Request) {
  return withApiAuthContext(request, async () => {
    try {
      const templates = await getTemplates();
      return NextResponse.json(templates);
    } catch (e) {
      console.error("[templates GET]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao listar templates." },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: Request) {
  return withOrgContext(async () => {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!name || !content) {
        return NextResponse.json(
          { message: "name e content são obrigatórios." },
          { status: 400 },
        );
      }

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

      const template = await createTemplate({
        name,
        content,
        category:
          typeof body.category === "string" ? body.category.trim() || undefined : undefined,
        language:
          typeof body.language === "string" ? body.language.trim() || undefined : undefined,
        channelType:
          typeof body.channelType === "string"
            ? (body.channelType as Parameters<typeof createTemplate>[0]["channelType"])
            : undefined,
        mediaUrl:
          typeof body.mediaUrl === "string" && body.mediaUrl ? body.mediaUrl : null,
        mediaType:
          typeof body.mediaType === "string" && body.mediaType ? body.mediaType : null,
        mediaName:
          typeof body.mediaName === "string" && body.mediaName ? body.mediaName : null,
        attachments,
      });
      return NextResponse.json(template, { status: 201 });
    } catch (e) {
      console.error("[templates POST]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao criar template." },
        { status: 500 },
      );
    }
  });
}
