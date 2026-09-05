/**
 * Recuperação lexical dos modelos internos do CRM (`MessageTemplate`)
 * para enriquecer o prompt do agente ATENDIMENTO.
 *
 * Não envia o texto integral ao aluno — só injeta referência no system
 * prompt. Modelos de cancelamento/trancamento/retenção/transferência
 * são excluídos (handoff de Retenção continua nas regras do agente).
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

/** Score mínimo para anexar tutorial (evita vídeo do tema errado). */
export const FAQ_MEDIA_MIN_SCORE = 4;

/** Títulos/conteúdos sensíveis — nunca entram no contexto do agente. */
export const MESSAGE_MODEL_EXCLUDE_RE =
  /cancel|tranc|desist|reten|transfer[eê]ncia|transferencia/i;

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

const MAX_CONTENT_CHARS = 700;
/** Score mínimo para injetar (evita falso positivo fraco). */
const MIN_SCORE = 2.5;

/** Expande a query com sinônimos de acesso (PC ≠ só "Duda celular"). */
const ACCESS_SYNONYMS: Array<{ match: RegExp; extra: string }> = [
  {
    match: /computador|notebook|pc\b|navegador|browser|desktop|\bsite\b|portal/i,
    extra:
      "portal aluno acessar conteudo portal do aluno blackboard ava ambiente virtual site web novoportal",
  },
  {
    match: /aula|aulas|conteudo|conteúdo|disciplina/i,
    extra: "acesso conteudo portal duda blackboard ava",
  },
  {
    match: /\bduda\b/i,
    extra: "aplicativo duda app mobile",
  },
];

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

export function isExcludedMessageModel(parts: {
  name: string;
  content: string;
  category?: string | null;
}): boolean {
  return MESSAGE_MODEL_EXCLUDE_RE.test(
    `${parts.name}\n${parts.content}\n${parts.category ?? ""}`,
  );
}

/** Score lexical: overlap + boost no título. */
function expandQueryForAccess(query: string): string {
  let expanded = query;
  for (const { match, extra } of ACCESS_SYNONYMS) {
    if (match.test(query)) expanded = `${expanded} ${extra}`;
  }
  return expanded;
}

export function scoreMessageModelMatch(
  query: string,
  model: { name: string; content: string; category?: string | null },
): number {
  const qt = new Set(tokenizeForModelMatch(expandQueryForAccess(query)));
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
  // PC/navegador → prioriza modelo "portal do aluno" sobre só "Duda".
  const wantsPc =
    /computador|notebook|\bpc\b|navegador|browser|desktop|\bsite\b|portal/i.test(
      query,
    );
  const nameN = normalize(model.name);
  if (wantsPc && nameN.includes("portal")) score += 4;
  if (wantsPc && nameN.includes("duda") && !nameN.includes("portal")) {
    score -= 1.5;
  }
  return score;
}

function truncateContent(content: string): string {
  const t = content.trim().replace(/\s+/g, " ");
  if (t.length <= MAX_CONTENT_CHARS) return t;
  return `${t.slice(0, MAX_CONTENT_CHARS - 1)}…`;
}

/**
 * Busca até `topK` modelos internos relevantes à mensagem do aluno.
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
    if (isExcludedMessageModel(r)) continue;
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
    "- Se o aluno pediu como fazer, pediu o site/link, ou confirmou (sim/pode ser/manda/envie): ENTREGUE passos + link agora. PROIBIDO só perguntar se ele quer o passo a passo de novo.",
    "- Se o modelo tiver TUTORIAL ANEXO, o sistema envia o arquivo depois do seu texto. Diga em 1 frase que segue o vídeo/print. PROIBIDO inventar URL de arquivo, escrever '[Envio do vídeo]' ou prometer um tutorial que o modelo não tem.",
    "- Sem anexo: oriente só em texto + links https do modelo.",
    "- NÃO copie o card inteiro com muitos passos numerados; 3–5 passos curtos + link bastam.",
    "- NUNCA use (nem parafraseie) modelos de cancelamento/trancamento/desistência/retenção/transferência — nesses casos transfira para Retenção com as tools.",
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

function mediaFromTemplateRow(row: {
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
