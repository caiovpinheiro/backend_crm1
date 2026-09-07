/**
 * Base de conhecimento dos agentes — leitura e edicao dos documentos.
 *
 * O `embeddings.ts` cuida do chunking + embedding; aqui fica o CRUD que a
 * API expoe. Toda query passa pelo `prisma` scoped (injeta
 * `organizationId`) E filtra por `agentId` explicitamente: nao existe
 * documento compartilhado entre agentes nem entre tenants.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { scheduleIndexing } from "@/services/ai/embeddings";

export const MAX_CONTENT_CHARS = 500_000;
export const MAX_TITLE_CHARS = 200;
export const DEFAULT_PER_PAGE = 25;
export const MAX_PER_PAGE = 100;

/**
 * Janela maxima de sobreposicao procurada ao remontar o texto a partir dos
 * chunks. O `CHUNK_OVERLAP` do indexador e 300; a folga cobre o `trim()`
 * aplicado em cada chunk.
 */
const OVERLAP_PROBE = 400;

const DOC_LIST_SELECT = {
  id: true,
  title: true,
  source: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  errorMessage: true,
  chunkCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class KnowledgeDocError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Remonta o texto de um documento indexado antes de existir a coluna
 * `content`. Os chunks se sobrepoem em ~300 chars, entao concatenar cru
 * duplicaria trechos: procuramos o maior sufixo do acumulado que e prefixo
 * do proximo chunk e colamos so o resto.
 *
 * O resultado e uma aproximacao (o indexador aplica `trim()` por chunk, o
 * que perde espacos nas bordas). Serve para ler e para pre-preencher o
 * editor; assim que o operador salvar, `content` passa a ser exato.
 */
export function reconstructContentFromChunks(
  chunks: Array<{ content: string; position: number }>,
): string {
  const ordered = [...chunks].sort((a, b) => a.position - b.position);
  let out = "";
  for (const chunk of ordered) {
    const piece = chunk.content;
    if (!piece) continue;
    if (!out) {
      out = piece;
      continue;
    }
    const probe = Math.min(out.length, piece.length, OVERLAP_PROBE);
    let overlap = 0;
    for (let n = probe; n > 0; n -= 1) {
      if (out.endsWith(piece.slice(0, n))) {
        overlap = n;
        break;
      }
    }
    if (overlap > 0) out += piece.slice(overlap);
    else out += out.endsWith("\n") ? piece : `\n\n${piece}`;
  }
  return out;
}

async function requireAgent(agentId: string): Promise<void> {
  const agent = await prisma.aIAgentConfig.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agent) throw new KnowledgeDocError("Agente não encontrado.", 404);
}

export function normalizeTitle(input: unknown): string {
  return typeof input === "string" ? input.trim().slice(0, MAX_TITLE_CHARS) : "";
}

export function normalizeContent(input: unknown): string {
  // `\0` derruba o insert no Postgres e `\r\n` bagunca o chunking.
  return typeof input === "string"
    ? input.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim()
    : "";
}

function assertPayload(title: string, content: string): void {
  if (!title || !content) {
    throw new KnowledgeDocError("Informe título e conteúdo.", 400);
  }
  if (content.length > MAX_CONTENT_CHARS) {
    throw new KnowledgeDocError(
      `Conteúdo muito grande (limite ${MAX_CONTENT_CHARS.toLocaleString("pt-BR")} caracteres).`,
      400,
    );
  }
}

export type ListKnowledgeDocsParams = {
  agentId: string;
  page?: number;
  perPage?: number;
  search?: string;
};

export async function listKnowledgeDocs({
  agentId,
  page = 1,
  perPage = DEFAULT_PER_PAGE,
  search,
}: ListKnowledgeDocsParams) {
  const safePerPage = Math.min(Math.max(1, Math.trunc(perPage)), MAX_PER_PAGE);
  const safePage = Math.max(1, Math.trunc(page));
  const term = search?.trim();

  const where = {
    agentId,
    ...(term
      ? { title: { contains: term, mode: "insensitive" as const } }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.aIAgentKnowledgeDoc.count({ where }),
    prisma.aIAgentKnowledgeDoc.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (safePage - 1) * safePerPage,
      take: safePerPage,
      select: DOC_LIST_SELECT,
    }),
  ]);

  return { items, total, page: safePage, perPage: safePerPage };
}

/**
 * Documento com o texto integral. Se `content` for null (doc anterior a
 * migration), remonta a partir dos chunks e marca `contentReconstructed`
 * para a UI avisar que o texto e aproximado.
 */
export async function getKnowledgeDoc(agentId: string, docId: string) {
  const doc = await prisma.aIAgentKnowledgeDoc.findFirst({
    where: { id: docId, agentId },
    select: { ...DOC_LIST_SELECT, content: true },
  });
  if (!doc) throw new KnowledgeDocError("Documento não encontrado.", 404);

  if (doc.content != null) {
    return { ...doc, contentReconstructed: false };
  }

  const chunks = await prisma.aIAgentKnowledgeChunk.findMany({
    where: { docId },
    orderBy: { position: "asc" },
    select: { content: true, position: true },
  });
  return {
    ...doc,
    content: reconstructContentFromChunks(chunks),
    contentReconstructed: chunks.length > 0,
  };
}

export async function createKnowledgeDoc(
  agentId: string,
  input: { title: unknown; content: unknown },
) {
  const title = normalizeTitle(input.title);
  const content = normalizeContent(input.content);
  assertPayload(title, content);
  await requireAgent(agentId);

  const doc = await prisma.aIAgentKnowledgeDoc.create({
    data: withOrgFromCtx({
      agentId,
      title,
      content,
      source: "paste",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      status: "PENDING" as const,
    }),
    select: DOC_LIST_SELECT,
  });

  scheduleIndexing(doc.id, content);
  return doc;
}

/**
 * Atualiza titulo e/ou conteudo. Reindexa somente quando o texto muda —
 * renomear um documento nao deve gastar embedding nem zerar os chunks.
 */
export async function updateKnowledgeDoc(
  agentId: string,
  docId: string,
  input: { title?: unknown; content?: unknown },
) {
  const current = await getKnowledgeDoc(agentId, docId);

  const title =
    input.title === undefined ? current.title : normalizeTitle(input.title);
  const content =
    input.content === undefined
      ? (current.content ?? "")
      : normalizeContent(input.content);
  assertPayload(title, content);

  // Doc remontado a partir dos chunks tem texto aproximado: se o operador
  // salvou sem mexer no texto, ainda assim gravamos `content` para o
  // documento passar a ter fonte da verdade exata.
  const contentChanged =
    input.content !== undefined && content !== current.content;
  const needsPersistContent = contentChanged || current.contentReconstructed;

  const doc = await prisma.aIAgentKnowledgeDoc.update({
    where: { id: docId },
    data: {
      title,
      ...(needsPersistContent
        ? {
            content,
            sizeBytes: Buffer.byteLength(content, "utf8"),
          }
        : {}),
      ...(contentChanged
        ? { status: "PENDING" as const, errorMessage: null }
        : {}),
    },
    select: DOC_LIST_SELECT,
  });

  if (contentChanged) scheduleIndexing(docId, content);
  return doc;
}

/** Reindexa sem alterar o conteudo — usado para destravar doc FAILED. */
export async function reindexKnowledgeDoc(agentId: string, docId: string) {
  const current = await getKnowledgeDoc(agentId, docId);
  const content = current.content ?? "";
  if (!content) {
    throw new KnowledgeDocError(
      "Documento sem texto para reindexar. Edite o conteúdo e salve.",
      400,
    );
  }
  const doc = await prisma.aIAgentKnowledgeDoc.update({
    where: { id: docId },
    data: {
      status: "PENDING" as const,
      errorMessage: null,
      // Doc antigo: aproveita a remontagem para gravar `content`.
      ...(current.contentReconstructed ? { content } : {}),
    },
    select: DOC_LIST_SELECT,
  });
  scheduleIndexing(docId, content);
  return doc;
}

export async function deleteKnowledgeDoc(agentId: string, docId: string) {
  const doc = await prisma.aIAgentKnowledgeDoc.findFirst({
    where: { id: docId, agentId },
    select: { id: true },
  });
  if (!doc) throw new KnowledgeDocError("Documento não encontrado.", 404);
  // A cascata onDelete remove os chunks e seus embeddings.
  await prisma.aIAgentKnowledgeDoc.delete({ where: { id: docId } });
}
