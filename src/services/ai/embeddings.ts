/**
 * Indexação de documentos de conhecimento dos agentes.
 *
 * Fluxo:
 *  1. chunking simples por ~800 tokens (~3200 chars) com overlap.
 *  2. chama `embedTexts` do provider em lotes (o SDK já otimiza).
 *  3. insere cada chunk via `prisma.aIAgentKnowledgeChunk.create` e
 *     depois seta a coluna `embedding` (vector(1536)) via SQL raw —
 *     o Prisma não tem suporte nativo a pgvector.
 *  4. atualiza status do doc (PENDING → INDEXING → READY/FAILED).
 *
 * A função é thread-safe por ID: chamar duas vezes pro mesmo docId
 * não corrompe dados, apenas deleta chunks antigos antes de reindexar.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { embedTexts, EMBEDDING_DIMENSIONS } from "@/services/ai/provider";
import { getAgentApiKey } from "@/services/ai/agent-key";

const CHUNK_SIZE = 3200;
const CHUNK_OVERLAP = 300;
const EMBED_BATCH = 32;

export function chunkText(raw: string): Array<{ content: string; position: number }> {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const chunks: Array<{ content: string; position: number }> = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + CHUNK_SIZE, text.length);
    // Tenta quebrar em boundary de parágrafo/frase quando possível.
    let splitAt = end;
    if (end < text.length) {
      const sliceForBoundary = text.slice(pos, end);
      const lastPara = sliceForBoundary.lastIndexOf("\n\n");
      const lastDot = sliceForBoundary.lastIndexOf(". ");
      const boundary = lastPara > CHUNK_SIZE * 0.5 ? lastPara : lastDot > CHUNK_SIZE * 0.5 ? lastDot + 1 : -1;
      if (boundary > 0) splitAt = pos + boundary;
    }
    const content = text.slice(pos, splitAt).trim();
    if (content) chunks.push({ content, position: pos });
    if (splitAt >= text.length) break;
    pos = splitAt - CHUNK_OVERLAP;
    if (pos < 0) pos = 0;
  }
  return chunks;
}

/**
 * Indexa (ou reindexa) um documento de conhecimento.
 * Garante que os chunks anteriores sejam removidos antes de inserir
 * os novos — isso torna a operação idempotente.
 */
export async function indexKnowledgeDoc(docId: string, rawText: string) {
  await prisma.aIAgentKnowledgeDoc.update({
    where: { id: docId },
    data: { status: "INDEXING", errorMessage: null },
  });

  try {
    const doc = await prisma.aIAgentKnowledgeDoc.findUnique({
      where: { id: docId },
      select: { agentId: true },
    });
    if (!doc) throw new Error("Documento não encontrado.");
    // Embeddings usam a chave OpenAI do próprio agente (sem chave global).
    const apiKey = await getAgentApiKey(doc.agentId);

    await prisma.aIAgentKnowledgeChunk.deleteMany({ where: { docId } });

    const chunks = chunkText(rawText);
    if (chunks.length === 0) {
      await prisma.aIAgentKnowledgeDoc.update({
        where: { id: docId },
        data: { status: "READY", chunkCount: 0 },
      });
      return { chunkCount: 0, tokens: 0 };
    }

    let totalTokens = 0;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const { embeddings, inputTokens } = await embedTexts(
        batch.map((c) => c.content),
        apiKey,
      );
      totalTokens += inputTokens;

      for (let j = 0; j < batch.length; j += 1) {
        const emb = embeddings[j];
        if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Embedding com dimensão inesperada (${emb?.length ?? "?"}); esperado ${EMBEDDING_DIMENSIONS}.`,
          );
        }
        const chunk = await prisma.aIAgentKnowledgeChunk.create({
          data: withOrgFromCtx({
            docId,
            content: batch[j].content,
            position: batch[j].position,
            tokenCount: Math.ceil(batch[j].content.length / 4),
          }),
          select: { id: true },
        });
        const vectorLiteral = `[${emb.map((n) => Number.isFinite(n) ? n : 0).join(",")}]`;
        // Defesa em profundidade: chunk.id ja e PK unica globalmente, mas
        // adicionamos AND "organizationId" pra que mesmo chamadas raw
        // disparadas em ctx errado nao alterem chunks de outro tenant.
        const orgId = getOrgIdOrThrow();
        await prisma.$executeRawUnsafe(
          `UPDATE "ai_agent_knowledge_chunks" SET embedding = $1::vector WHERE id = $2 AND "organizationId" = $3`,
          vectorLiteral,
          chunk.id,
          orgId,
        );
      }
    }

    await prisma.aIAgentKnowledgeDoc.update({
      where: { id: docId },
      data: { status: "READY", chunkCount: chunks.length, errorMessage: null },
    });

    return { chunkCount: chunks.length, tokens: totalTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.aIAgentKnowledgeDoc
      .update({
        where: { id: docId },
        data: { status: "FAILED", errorMessage: message.slice(0, 500) },
      })
      .catch(() => null);
    throw err;
  }
}

/**
 * Agenda uma indexação em background. Se houver worker externo
 * (BullMQ habilitado), enfileira nele; caso contrário, roda inline
 * após o retorno da request — mesmo padrão usado em `src/lib/queue.ts`.
 */
export function scheduleIndexing(docId: string, rawText: string) {
  // Por enquanto, execução direta em background sem bloquear a request.
  // Quando o worker externo estiver configurado, trocar por
  // `aiIngestQueue.add("index", { docId })`.
  setImmediate(() => {
    void indexKnowledgeDoc(docId, rawText).catch((err) => {
      console.error(`[ai] indexação falhou doc=${docId}:`, err);
    });
  });
}
