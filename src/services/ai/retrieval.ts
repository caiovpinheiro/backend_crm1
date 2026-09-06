/**
 * Recuperação semântica (RAG) nos documentos de conhecimento
 * indexados do agente.
 *
 * Usa o operador `<=>` do pgvector (cosine distance) — quanto menor
 * a distância, mais relevante. Limita o resultado aos docs do agente
 * específico e em status `READY`.
 *
 * Implementação via `$queryRawUnsafe` porque o Prisma não suporta
 * pgvector nativamente. O vetor de consulta é serializado como literal
 * SQL no formato `[0.1,0.2,...]::vector`.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { embedTexts } from "@/services/ai/provider";

export type RetrievedChunk = {
  id: string;
  docId: string;
  docTitle: string;
  content: string;
  distance: number;
};

const MIN_SIMILARITY = 0.6; // distance <= 0.4 ≈ bem relevante. Mantemos folgado.

export async function retrieveRelevantChunks(
  agentId: string,
  query: string,
  apiKey: string,
  topK = 4,
): Promise<RetrievedChunk[]> {
  const text = query.trim();
  if (!text) return [];

  const orgId = getOrgIdOrThrow();

  // Checa rapidamente se o agente tem algo indexado antes de gastar
  // um embedding; evita chamadas à OpenAI quando não há docs. Como
  // passa pela extension scoped, ja garante que o agente pertence
  // a` org corrente.
  const hasDocs = await prisma.aIAgentKnowledgeDoc.findFirst({
    where: { agentId, status: "READY", chunkCount: { gt: 0 } },
    select: { id: true },
  });
  if (!hasDocs) return [];

  const { embeddings } = await embedTexts([text], apiKey);
  const emb = embeddings[0];
  if (!emb) return [];
  const vectorLiteral = `[${emb.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`;

  // Defesa em profundidade: o $queryRawUnsafe NAO passa pela extension.
  // Filtramos por organizationId em chunks E docs (depois da migration
  // multi-tenancy ambas as tabelas tem organizationId NOT NULL). Se algum
  // bug fizer o caller passar agentId de outra org, a query volta vazia
  // em vez de vazar chunks do tenant errado.
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      docId: string;
      title: string;
      content: string;
      distance: number;
    }>
  >(
    `SELECT c.id, c."docId" AS "docId", d.title, c.content,
            (c.embedding <=> $1::vector) AS distance
       FROM "ai_agent_knowledge_chunks" c
       JOIN "ai_agent_knowledge_docs" d ON d.id = c."docId"
      WHERE d."agentId" = $2
        AND d.status = 'READY'
        AND c.embedding IS NOT NULL
        AND d."organizationId" = $4
        AND c."organizationId" = $4
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3`,
    vectorLiteral,
    agentId,
    topK,
    orgId,
  );

  return rows
    .filter((r) => r.distance <= MIN_SIMILARITY)
    .map((r) => ({
      id: r.id,
      docId: r.docId,
      docTitle: r.title,
      content: r.content,
      distance: Number(r.distance),
    }));
}

/**
 * Monta um bloco de texto pronto pra injetar no system prompt.
 * Retorna string vazia se nada relevante foi encontrado.
 */
export function formatRetrievalBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const sections = chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${c.docTitle}\n${c.content.trim()}`,
    )
    .join("\n\n---\n\n");
  return [
    "",
    "BASE DE CONHECIMENTO (use para fundamentar respostas; cite [N] quando aplicável):",
    sections,
  ].join("\n");
}
