import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  createKnowledgeDoc,
  KnowledgeDocError,
  listKnowledgeDocs,
} from "@/services/ai/knowledge-docs";
import {
  extractKnowledgeText,
  KnowledgeExtractError,
  MAX_UPLOAD_BYTES,
  titleFromFileName,
} from "@/services/ai/knowledge-extract";

/**
 * GET — lista paginada dos documentos de conhecimento do agente.
 * POST — cria novo doc e dispara indexação. Aceita dois formatos:
 *
 *  - `application/json` com `{ title, content }` — texto colado na tela;
 *  - `multipart/form-data` com o campo `file` — arquivo, cujo texto sai
 *    de `extractKnowledgeText` (txt, md, csv, tsv, docx).
 *
 * PDF é rejeitado com mensagem explícita pelo extrator, e imagem exigiria
 * visão/OCR — ver o cabeçalho de `knowledge-extract.ts`.
 *
 * A extração roda inline: é O(tamanho) em memória, sem I/O de rede, e o
 * upload é limitado a 10 MB. O trabalho pesado (chunking + embeddings)
 * continua em background via `scheduleIndexing`.
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
    const isUpload = (request.headers.get("content-type") ?? "").includes(
      "multipart/form-data",
    );

    try {
      const input = isUpload
        ? await inputFromUpload(request)
        : await inputFromJson(request);
      const doc = await createKnowledgeDoc(id, input);
      return NextResponse.json(doc, { status: 201 });
    } catch (e) {
      // O extrator já formula a mensagem para quem enviou o arquivo
      // ("PDF ainda não é suportado", "limite 10 MB"): repassar é melhor
      // do que traduzir para um 400 genérico.
      if (e instanceof KnowledgeExtractError) {
        return NextResponse.json({ message: e.message }, { status: 400 });
      }
      if (e instanceof KnowledgeDocError) {
        return NextResponse.json({ message: e.message }, { status: e.status });
      }
      throw e;
    }
  });
}

type CreateInput = Parameters<typeof createKnowledgeDoc>[1];

async function inputFromJson(request: Request): Promise<CreateInput> {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return {
    title: body.title,
    content: body.content,
    validFrom: body.validFrom,
    validUntil: body.validUntil,
    expiredBehavior: body.expiredBehavior,
    expiredInstruction: body.expiredInstruction,
  };
}

async function inputFromUpload(request: Request): Promise<CreateInput> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new KnowledgeExtractError("Envie um arquivo no campo `file`.");
  }
  // O limite é checado antes de materializar o buffer: `arrayBuffer()` de
  // um arquivo grande custa a memória inteira dele.
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new KnowledgeExtractError(
      `Arquivo muito grande (limite ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`,
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const extracted = extractKnowledgeText(file.name, buffer);
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() ? v : undefined;
  };

  return {
    title: field("title") ?? titleFromFileName(file.name),
    content: extracted.text,
    // Procedência do ARQUIVO, não do texto extraído.
    origin: {
      source: "upload",
      mimeType: extracted.mimeType,
      sizeBytes: extracted.sizeBytes,
    },
    validFrom: field("validFrom"),
    validUntil: field("validUntil"),
    expiredBehavior: field("expiredBehavior"),
    expiredInstruction: field("expiredInstruction"),
  };
}
