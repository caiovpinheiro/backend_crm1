/**
 * Materiais já enviados na conversa: mensagem pronta mandada há pouco não
 * sai de novo (a trava anti-repetição barrava o texto e o cliente ficava só
 * com o "vou te enviar"), e o #reset do teste zera a contagem.
 * Nenhum domínio de cliente.
 */

import { prismaBase } from "@/lib/prisma-base";
import { SYSTEM_MESSAGE_DEFAULTS, systemMessage, type SystemMessages } from "@/lib/ai-v2/system-messages";

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
};

/** Janela em que a mesma mensagem pronta não é reenviada. */
export const RESEND_WINDOW_MS = 30 * 60 * 1000;

/** Abaixo disto a mensagem pronta não traz o que a resposta explica. */
export const MESSAGE_MODEL_MIN_COVERAGE = 0.5;

// Palavras de ligação: não dizem do que o texto trata.
const FUNCTION_WORDS = new Set([
  "para", "pela", "pelo", "pelas", "pelos", "como", "voce", "voces", "esta", "este", "estes", "estas",
  "isso", "essa", "esse", "isto", "aqui", "mais", "muito", "quando", "depois", "antes", "sobre", "entre",
  "onde", "qual", "quais", "seus", "suas", "meus", "minhas", "nosso", "nossa", "nossos", "nossas", "entao",
  "tambem", "ainda", "apenas", "cada", "todo", "toda", "todos", "todas", "sera", "pode", "podem", "tudo",
  "nada", "algo", "assim", "porque", "pois", "caso", "favor", "sempre", "agora", "hoje", "seja", "tenho",
  "temos", "estao", "sendo", "fazer", "vamos", "claro", "certo", "qualquer", "duvida",
]);

function contentStems(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !FUNCTION_WORDS.has(w))
      .map((w) => w.slice(0, 5)),
  );
}

/** Quantas palavras de conteúdo (pelo começo) dois textos têm em comum. */
export function sharedContentWords(a: string, b: string): number {
  const other = contentStems(b);
  return [...contentStems(a)].filter((w) => other.has(w)).length;
}

/**
 * Quanto do que a resposta explica (fora a introdução) a mensagem pronta
 * traz, de 0 a 1. Compara o começo das palavras de conteúdo: "acesse" e
 * "acessar" contam como a mesma.
 */
export function messageModelCoverage(reply: string, modelText: string): number {
  const intro = contentStems(introBeforeMaterial(reply));
  const body = [...contentStems(reply)].filter((w) => !intro.has(w));
  if (body.length === 0) return 1;
  const model = contentStems(modelText);
  return body.filter((w) => model.has(w)).length / body.length;
}

/** Resposta quando o material pedido acabou de ser enviado. */
export const ALREADY_SENT_REPLY = SYSTEM_MESSAGE_DEFAULTS.materialAlreadySent;

/** Fim da resposta longa que anunciava um anexo já enviado há pouco. */
export const ATTACHMENT_ABOVE_NOTE = SYSTEM_MESSAGE_DEFAULTS.attachmentAbove;

/**
 * Introdução da resposta quando uma mensagem pronta vem a seguir: o texto
 * antes da primeira lista/quebra, até 2 frases e 35 palavras. Vazio quando
 * a resposta já começa pelo conteúdo.
 */
export function introBeforeMaterial(reply: string): string {
  const head = reply.split(/\n\s*(?:\d+[.)]|[-•*📌✅]|\S{1,2}\s)|\n{2,}/u)[0].trim().split("\n")[0].trim();
  const sentences = head.split(/(?<=[.!?])\s+/).slice(0, 2);
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (next.split(/\s+/).length > 35) break;
    out = next;
  }
  if (out && !/[.!?:]$/.test(out)) out = `${out}.`;
  return out.split(/\s+/).length >= 3 ? out : "";
}

/** A resposta anuncia um envio ("segue o vídeo", "vou te mandar", "abaixo"). */
export function announcesSending(reply: string): boolean {
  return /\b(?:segue|seguem|envio|enviei|enviando|mando|mandei|mandando|vou (?:te |lhe )?(?:enviar|mandar)|abaixo|anexo|anexei)\b/i.test(reply);
}

/**
 * A resposta prometeu um envio e o modelo não escolheu mensagem pronta.
 * Devolve a liberada neste assunto que mais combina com o pedido e com o
 * que a resposta disse que ia mandar. Sem combinação, não chuta.
 */
export function pickPromisedModelId(
  reply: string,
  userMessage: string,
  models: Array<{ id: string; name: string; content?: string | null }>,
): string | null {
  if (!announcesSending(reply) || models.length === 0) return null;
  if (models.length === 1) return models[0].id;
  const hay = `${userMessage}\n${reply}`;
  let best: { id: string; score: number } | null = null;
  for (const model of models) {
    const score = sharedContentWords(hay, `${model.name}\n${model.content ?? ""}`);
    if (!best || score > best.score) best = { id: model.id, score };
  }
  return best && best.score > 0 ? best.id : null;
}

/** Erro do executor quando o texto da mensagem pronta foi barrado por repetir uma recente. */
export const MESSAGE_MODEL_REPEATED = "não reenviada: igual a uma mensagem recente";

/** Último #reset da conversa (sessão de teste), ou null. */
export async function lastV2ResetAt(conversationId: string): Promise<Date | null> {
  const rows = await db.$queryRawUnsafe<Array<{ at: Date | null }>>(
    `SELECT MAX("createdAt") AS "at" FROM "ai_simple_turn_logs" WHERE "conversationId"=$1 AND "prompt"='reset'`,
    conversationId,
  );
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

/** Ids das mensagens prontas enviadas com sucesso nestes logs de turno. */
export function sentMessageModelIds(rows: Array<{ executedActions: unknown }>): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.executedActions)) continue;
    for (const res of row.executedActions as Array<Record<string, unknown>>) {
      const action = (res?.action ?? {}) as Record<string, unknown>;
      if (res?.ok === true && action.type === "send_message_model" && typeof action.modelId === "string") out.add(action.modelId);
    }
  }
  return out;
}

/** Início da janela: 30 min atrás, ou o último #reset se for mais recente. */
export function resendWindowStart(now: number, lastReset: Date | null): Date {
  const windowStart = now - RESEND_WINDOW_MS;
  return new Date(lastReset ? Math.max(windowStart, lastReset.getTime()) : windowStart);
}

/** Quais destas mensagens prontas já saíram na conversa dentro da janela. */
export async function recentlySentMessageModels(conversationId: string, modelIds: string[]): Promise<Set<string>> {
  if (modelIds.length === 0) return new Set();
  const since = resendWindowStart(Date.now(), await lastV2ResetAt(conversationId));
  const rows = await db.$queryRawUnsafe<Array<{ executedActions: unknown }>>(
    `SELECT "executedActions" FROM "ai_simple_turn_logs" WHERE "conversationId"=$1 AND "createdAt" >= $2 ORDER BY "createdAt" DESC LIMIT 50`,
    conversationId, since,
  );
  const sent = sentMessageModelIds(rows);
  return new Set(modelIds.filter((id) => sent.has(id)));
}

/** O cliente diz que o arquivo não chegou ("não recebi o vídeo", "cadê a imagem?"). */
export function saysNotReceived(message: string): boolean {
  const m = message.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const media = "(?:video|arquivo|imagem|foto|pdf|documento|material|anexo|audio|link|tutorial|nada)";
  return (
    /\bnao (?:recebi|chegou|veio|apareceu|baixou|abriu|carregou|consegui (?:ver|abrir|baixar))\b/.test(m) ||
    new RegExp(`\\bcade (?:o |a )?${media}\\b|\\bnao (?:tem|ta|esta|veio) (?:o |a |nenhum |nenhuma )?${media}\\b|\\b${media} nao (?:chegou|veio|apareceu|abriu|carregou)\\b`).test(m)
  );
}

export type MediaDelivery = { status: string | null; error: string | null; type: string; at: Date };
const MEDIA_TYPES = ["image", "video", "audio", "ptt", "document", "file"];

/** Anexos que o agente mandou nesta conversa desde `since`, com o que aconteceu no envio. */
export async function recentMediaDeliveries(conversationId: string, since: Date): Promise<MediaDelivery[]> {
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.message.findMany({
    where: { conversationId, direction: "out", messageType: { in: MEDIA_TYPES }, createdAt: { gte: since } },
    select: { sendStatus: true, sendError: true, messageType: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  return rows.map((r) => ({ status: r.sendStatus ?? null, error: r.sendError ?? null, type: r.messageType, at: new Date(r.createdAt) }));
}

const MEDIA_LABEL: Record<string, string> = { image: "a imagem", video: "o vídeo", audio: "o áudio", ptt: "o áudio", document: "o arquivo", file: "o arquivo" };

export type MediaResendPlan = { resend: boolean; handoff: boolean; reply: string; trace: string };

/**
 * O cliente diz que não recebeu o anexo. Decide com base no que saiu de
 * fato: reenvia uma vez; se o envio falhou (ou já foi tentado duas vezes),
 * diz a verdade e chama alguém da equipe — antes a resposta era "te enviei
 * logo acima 👆" com a entrega marcada como falha.
 */
export function mediaResendPlan(
  deliveries: MediaDelivery[],
  config?: { systemMessages?: SystemMessages | null } | null,
): MediaResendPlan | null {
  if (deliveries.length === 0) return null;
  const last = deliveries[deliveries.length - 1];
  const label = MEDIA_LABEL[last.type] ?? "o arquivo";
  const failed = deliveries.filter((d) => (d.status ?? "").toLowerCase() === "failed").length;
  const attempts = deliveries.length;
  if (attempts >= 2) {
    return {
      resend: false,
      handoff: true,
      reply: systemMessage(config, failed > 0 ? "mediaCannotSend" : "mediaNotArriving", { anexo: label, Anexo: `${label.charAt(0).toUpperCase()}${label.slice(1)}` }),
      trace: `Cliente diz que não recebeu ${label} (${attempts} envios, ${failed} com falha) → não reenvia; transfere`,
    };
  }
  return {
    resend: true,
    handoff: false,
    reply: systemMessage(config, failed > 0 ? "mediaResentAfterFailure" : "mediaResent", { anexo: label, Anexo: `${label.charAt(0).toUpperCase()}${label.slice(1)}` }),
    trace: `Cliente diz que não recebeu ${label} (${failed > 0 ? "o envio anterior falhou" : "o envio anterior consta como entregue"}) → reenvia só o anexo, uma vez`,
  };
}
