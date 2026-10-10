/**
 * Recuperação lexical dos modelos internos do CRM (`MessageTemplate`)
 * para o agente citar procedimentos e enviar os anexos deles.
 *
 * Não envia o texto integral ao cliente — só injeta referência no prompt.
 * Quais modelos o agente pode usar é configuração do agente, não regra
 * daqui. Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { isOrgOwnedStorageUrl } from "@/lib/storage/read-for-send";
import { normalizeTemplateAttachments } from "@/services/templates";

export type AgentFaqMedia = {
  url: string;
  mimeType: string | null;
  name: string | null;
};

export type RetrievedMessageModel = {
  id: string;
  name: string;
  content: string;
  score: number;
  media: AgentFaqMedia[];
};

/**
 * Score mínimo para anexar tutorial (evita vídeo do tema errado). 4 exigia
 * casar título + duas palavras do corpo: o anexo quase nunca saía, mesmo
 * com o modelo certo escolhido. 3 ainda exige título + corpo.
 */
export const FAQ_MEDIA_MIN_SCORE = 3;

const STOP = new Set([
  "o",
  "a",
  "os",
  "as",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "e",
  "em",
  "no",
  "na",
  "nos",
  "nas",
  "um",
  "uma",
  "meu",
  "minha",
  "me",
  "eu",
  "para",
  "por",
  "com",
  "que",
  "nao",
  "se",
  "sua",
  "seu",
  "ja",
  "esta",
  "estou",
  "preciso",
  "quero",
  "como",
  "esse",
  "essa",
  "isso",
  "the",
  "app",
  "msg",
  "pra",
]);

/**
 * 700 cortava o procedimento no meio — e o que fica no fim do modelo é
 * justamente o link e os últimos passos. Modelo é fonte da verdade: entra
 * inteiro até este teto.
 */
const MAX_CONTENT_CHARS = 1400;
/** Score mínimo para injetar (evita falso positivo fraco). */
const MIN_SCORE = 2.5;


function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeForModelMatch(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length > 2 && !STOP.has(t));
}


/** Score lexical: overlap + boost no título. */

export function scoreMessageModelMatch(
  query: string,
  model: { name: string; content: string; category?: string | null },
): number {
  const qt = new Set(tokenizeForModelMatch(query));
  if (qt.size === 0) return 0;
  const titleTok = new Set(tokenizeForModelMatch(model.name));
  const bodyTok = new Set([
    ...tokenizeForModelMatch(model.content.slice(0, 1200)),
    ...tokenizeForModelMatch(model.category ?? ""),
  ]);
  let bodyHits = 0;
  let titleHits = 0;
  for (const t of qt) {
    if (titleTok.has(t)) titleHits++;
    if (bodyTok.has(t)) bodyHits++;
  }
  let score = bodyHits + titleHits * 1.5;
  return score;
}

function truncateContent(content: string): string {
  const t = content.trim().replace(/\s+/g, " ");
  if (t.length <= MAX_CONTENT_CHARS) return t;
  return `${t.slice(0, MAX_CONTENT_CHARS - 1)}…`;
}

/**
 * Busca até `topK` modelos internos relevantes à mensagem do cliente.
 * Escopo multi-tenant via Prisma extension + organizationId explícito.
 */
export async function retrieveRelevantMessageModels(
  query: string,
  topK = 3,
): Promise<RetrievedMessageModel[]> {
  const q = query.trim();
  if (!q) return [];

  const orgId = getOrgIdOrThrow();

  const rows = await prisma.messageTemplate.findMany({
    where: {
      organizationId: orgId,
      status: { not: "REJECTED" },
      content: { not: "" },
    },
    select: {
      id: true,
      name: true,
      content: true,
      category: true,
      mediaUrl: true,
      mediaType: true,
      mediaName: true,
      attachments: true,
    },
    take: 300,
  });

  const scored: RetrievedMessageModel[] = [];
  for (const r of rows) {
    const score = scoreMessageModelMatch(q, r);
    if (score < MIN_SCORE) continue;
    scored.push({
      id: r.id,
      name: r.name,
      content: truncateContent(r.content),
      score,
      media: mediaFromTemplateRow(r),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function formatMessageModelsBlock(
  models: RetrievedMessageModel[],
): string {
  if (models.length === 0) return "";
  const sections = models
    .map((m, i) => {
      const mediaLine =
        m.media.length > 0
          ? `\nTUTORIAL ANEXO (o sistema envia depois do seu texto): ${m.media
              .map((att) => att.name || att.mimeType || "arquivo")
              .join(", ")}`
          : "";
      return `[M${i + 1}] ${m.name}${mediaLine}\n${m.content}`;
    })
    .join("\n\n---\n\n");
  return [
    "",
    "MODELOS INTERNOS DE REFERÊNCIA (procedimentos operacionais do time):",
    "- Use como FONTE da verdade. Resuma em poucas frases no WhatsApp e **envie os links/URLs** que aparecerem no modelo.",
    "- Se o cliente pediu como fazer, pediu o site/link, ou confirmou (sim/pode ser/manda/envie): ENTREGUE passos + link agora. PROIBIDO só perguntar se ele quer o passo a passo de novo.",
    "- Se o modelo tiver TUTORIAL ANEXO, o sistema envia o arquivo depois do seu texto. Diga em 1 frase que segue o vídeo/print. PROIBIDO inventar URL de arquivo, escrever '[Envio do vídeo]' ou prometer um tutorial que o modelo não tem.",
    "- Sem anexo: oriente só em texto + links https do modelo.",
    "- NÃO copie o card inteiro com muitos passos numerados; 3–5 passos curtos + link bastam.",
    "- Se o modelo cobrir o assunto, tende a confiança ALTA (0.8+).",
    sections,
  ].join("\n");
}

export function pickFollowUpMedia(
  models: RetrievedMessageModel[],
): AgentFaqMedia[] {
  const best = models.find(
    (m) => m.media.length > 0 && m.score >= FAQ_MEDIA_MIN_SCORE,
  );
  if (!best) return [];
  return best.media.slice(0, 2);
}

export function mediaFromTemplateRow(row: {
  mediaUrl: string | null;
  mediaType: string | null;
  mediaName: string | null;
  attachments: unknown;
}): AgentFaqMedia[] {
  const fromJson = normalizeTemplateAttachments(row.attachments);
  const raw =
    fromJson.length > 0
      ? fromJson
      : row.mediaUrl
        ? [
            {
              url: row.mediaUrl,
              mimeType: row.mediaType,
              name: row.mediaName,
            },
          ]
        : [];
  const out: AgentFaqMedia[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const url = item.url.trim();
    if (!url || seen.has(url) || !isOrgOwnedStorageUrl(url)) continue;
    seen.add(url);
    out.push({
      url,
      mimeType: item.mimeType ?? null,
      name: item.name ?? null,
    });
  }
  return out;
}
