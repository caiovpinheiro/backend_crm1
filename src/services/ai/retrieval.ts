/**
 * Recuperação semântica (RAG) nos documentos de conhecimento
 * indexados do agente.
 *
 * Usa o operador `<=>` do pgvector (cosine distance) — quanto menor
 * a distância, mais relevante. Limita o resultado aos docs do agente
 * específico, em status `READY` e DENTRO da janela de validade.
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

/**
 * Documento relevante para a pergunta cuja validade JÁ PASSOU. Não entra
 * como fato; serve para o prompt receber a orientação do operador em vez
 * de silêncio (`formatExpiredKnowledgeBlock`).
 */
export type ExpiredKnowledgeDoc = {
  docId: string;
  title: string;
  /** Texto do próprio documento. `null` = usar o default do agente. */
  instruction: string | null;
};

export type KnowledgeRetrieval = {
  chunks: RetrievedChunk[];
  expired: ExpiredKnowledgeDoc[];
};

const MIN_SIMILARITY = 0.6; // distance <= 0.4 ≈ bem relevante. Mantemos folgado.

const EMPTY: KnowledgeRetrieval = { chunks: [], expired: [] };

export async function retrieveAgentKnowledge(
  agentId: string,
  query: string,
  apiKey: string,
  topK = 4,
  now: Date = new Date(),
): Promise<KnowledgeRetrieval> {
  const text = query.trim();
  if (!text) return EMPTY;

  const orgId = getOrgIdOrThrow();

  // Checa rapidamente se o agente tem algo indexado antes de gastar
  // um embedding; evita chamadas à OpenAI quando não há docs. Como
  // passa pela extension scoped, ja garante que o agente pertence
  // a` org corrente.
  //
  // O `orderBy validUntil asc` aproveita a mesma ida ao banco para saber se
  // existe documento vencido: no Postgres ASC manda NULL para o fim, então
  // se a primeira linha não tem validade vencida, nenhuma tem.
  const probe = await prisma.aIAgentKnowledgeDoc.findFirst({
    where: { agentId, status: "READY", chunkCount: { gt: 0 } },
    orderBy: { validUntil: "asc" },
    select: { validUntil: true },
  });
  if (!probe) return EMPTY;
  const hasExpired =
    probe.validUntil !== null && probe.validUntil.getTime() < now.getTime();

  const { embeddings } = await embedTexts([text], apiKey);
  const emb = embeddings[0];
  if (!emb) return EMPTY;
  const vectorLiteral = `[${emb.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`;

  // Defesa em profundidade: o $queryRawUnsafe NAO passa pela extension.
  // Filtramos por organizationId em chunks E docs (depois da migration
  // multi-tenancy ambas as tabelas tem organizationId NOT NULL). Se algum
  // bug fizer o caller passar agentId de outra org, a query volta vazia
  // em vez de vazar chunks do tenant errado.
  //
  // O corte por validade e parte do WHERE, nao um filtro posterior: doc
  // fora da janela nem disputa as `topK` vagas, senao um doc vencido
  // relevante roubaria o lugar de um doc valido.
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
        AND (d."validFrom" IS NULL OR d."validFrom" <= $5)
        AND (d."validUntil" IS NULL OR d."validUntil" >= $5)
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3`,
    vectorLiteral,
    agentId,
    topK,
    orgId,
    now,
  );

  const chunks = rows
    .filter((r) => r.distance <= MIN_SIMILARITY)
    .map((r) => ({
      id: r.id,
      docId: r.docId,
      docTitle: r.title,
      content: r.content,
      distance: Number(r.distance),
    }));

  if (!hasExpired) return { chunks, expired: [] };

  // Segunda consulta, mesmo embedding: quais documentos VENCIDOS seriam
  // relevantes para esta pergunta. Só os que o operador marcou para
  // orientar o agente — `silent` apenas para de ser servido.
  const expiredRows = await prisma.$queryRawUnsafe<
    Array<{
      docId: string;
      title: string;
      instruction: string | null;
      distance: number;
    }>
  >(
    `SELECT d.id AS "docId", d.title, d."expiredInstruction" AS instruction,
            MIN(c.embedding <=> $1::vector) AS distance
       FROM "ai_agent_knowledge_chunks" c
       JOIN "ai_agent_knowledge_docs" d ON d.id = c."docId"
      WHERE d."agentId" = $2
        AND d.status = 'READY'
        AND c.embedding IS NOT NULL
        AND d."organizationId" = $4
        AND c."organizationId" = $4
        AND d."expiredBehavior" = 'instruct'
        AND d."validUntil" IS NOT NULL
        AND d."validUntil" < $5
      GROUP BY d.id, d.title, d."expiredInstruction"
      ORDER BY MIN(c.embedding <=> $1::vector)
      LIMIT $3`,
    vectorLiteral,
    agentId,
    topK,
    orgId,
    now,
  );

  const expired = expiredRows
    .filter((r) => Number(r.distance) <= MIN_SIMILARITY)
    .map((r) => ({
      docId: r.docId,
      title: r.title,
      instruction: r.instruction?.trim() ? r.instruction.trim() : null,
    }));

  return { chunks, expired };
}

/**
 * Precedência do que foi recuperado. Uma linha de "use para fundamentar"
 * não disputa com as dezenas de linhas de transferência/roteamento que o
 * resto do prompt traz: o modelo lia o bloco como material de apoio e
 * encaminhava assunto que estava documentado na base.
 *
 * Genérica de propósito — nenhum tema, departamento ou vertical.
 */
export const KNOWLEDGE_PRECEDENCE_RULE =
  "PRECEDÊNCIA: se as referências acima cobrem a pergunta, responda com elas nesta mensagem — não transfira nem encaminhe por esse assunto.";

/**
 * Monta um bloco de texto pronto pra injetar no system prompt.
 * Retorna string vazia se nada relevante foi encontrado — e sem trecho
 * recuperado a regra de precedência também não entra no prompt.
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
    // O [N] numera os trechos só para o modelo se orientar. Mandar "cite [N]"
    // fazia o índice do chunk chegar no WhatsApp do aluno.
    "BASE DE CONHECIMENTO (use para fundamentar respostas). O [N] é índice interno: PROIBIDO escrever [1], [2] ou qualquer marcador de fonte na resposta ao cliente.",
    sections,
    KNOWLEDGE_PRECEDENCE_RULE,
  ].join("\n");
}

/** Quantos documentos vencidos entram no bloco — o prompt já é longo. */
const MAX_EXPIRED_IN_PROMPT = 3;

/**
 * Orientação determinística para o turno em que um documento vencido seria
 * recuperado. O modelo NÃO decide que algo venceu: quem decide é o corte por
 * validade na consulta; aqui ele só recebe o que fazer no lugar.
 *
 * Sem documento vencido relevante — ou sem texto configurado nem no documento
 * nem no agente — devolve string vazia e nada é acrescentado ao prompt.
 */
export function formatExpiredKnowledgeBlock(
  expired: ExpiredKnowledgeDoc[],
  defaultInstruction: string | null,
): string {
  if (expired.length === 0) return "";

  // Agrupa por texto: dois documentos vencidos com a mesma orientação viram
  // uma linha, não duas.
  const byInstruction = new Map<string, string[]>();
  for (const doc of expired.slice(0, MAX_EXPIRED_IN_PROMPT)) {
    const instruction = (doc.instruction ?? defaultInstruction ?? "").trim();
    if (!instruction) continue;
    const titles = byInstruction.get(instruction) ?? [];
    titles.push(doc.title.trim() || "documento sem título");
    byInstruction.set(instruction, titles);
  }
  if (byInstruction.size === 0) return "";

  const lines = ["", "CONHECIMENTO FORA DE VALIDADE (fato do sistema):"];
  for (const [instruction, titles] of byInstruction) {
    lines.push(`- ${titles.join("; ")} → ${instruction}`);
  }
  lines.push(
    "NÃO afirme prazo, valor ou condição desses assuntos: o que havia registrado expirou. Siga a orientação acima.",
  );
  return lines.join("\n");
}
