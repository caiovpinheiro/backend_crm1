/**
 * Pontos de comparação de uma conversa atendida por pessoa: cada bloco de
 * mensagens do cliente seguido da resposta humana. O histórico até ali vai
 * junto, para o agente responder no mesmo ponto da conversa.
 * Tudo sai mascarado (documento, e-mail, senha, cartão).
 * Nenhum domínio de cliente.
 */

import { maskSensitive } from "./sensitive";

export type ReplayMessageRow = {
  direction: string;
  authorType: string | null;
  messageType: string | null;
  content: string | null;
  createdAt: Date;
};

export type ReplayPoint = {
  index: number;
  /** Mensagens do cliente neste turno, juntas. */
  clientText: string;
  /** Resposta da pessoa (texto das mensagens humanas até o cliente falar de novo). */
  humanText: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** Motivo para não avaliar (resposta só em áudio, cliente só mandou mídia…). */
  skipReason: string | null;
  at: string;
};

const MEDIA_LABEL: Record<string, string> = {
  image: "imagem",
  audio: "áudio",
  ptt: "áudio",
  voice: "áudio",
  video: "vídeo",
  document: "documento",
  sticker: "figurinha",
  unsupported: "mensagem não suportada",
};
const IGNORED_TYPES = new Set(["reaction", "note", "sticker"]);
// Legenda automática que o canal grava no lugar de mídia sem texto.
const PLACEHOLDER_RE = /^\s*(\[(imagem|áudio|audio|vídeo|video|documento|contato compartilhado)\]|📎.*)\s*$/i;

function textOf(row: ReplayMessageRow): { text: string; isMedia: boolean } {
  const type = (row.messageType ?? "text").toLowerCase();
  const raw = (row.content ?? "").trim();
  const media = MEDIA_LABEL[type];
  if (!media) return { text: raw, isMedia: false };
  const caption = raw && !PLACEHOLDER_RE.test(raw) ? raw : "";
  return { text: caption ? `[${media}] ${caption}` : `[${media}]`, isMedia: !caption };
}

type Kind = "client" | "human" | "other";

function kindOf(row: ReplayMessageRow): Kind {
  if (row.direction === "in") return "client";
  if ((row.authorType ?? "").toLowerCase() === "human") return "human";
  return "other";
}

export function extractReplayPoints(
  rows: ReplayMessageRow[],
  opts: { maxPoints?: number; historyLimit?: number } = {},
): ReplayPoint[] {
  const maxPoints = opts.maxPoints ?? 6;
  const historyLimit = opts.historyLimit ?? 10;
  const items = rows
    .filter((r) => !IGNORED_TYPES.has((r.messageType ?? "").toLowerCase()))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => ({ kind: kindOf(r), at: r.createdAt, ...textOf(r) }))
    .filter((r) => r.text);

  const points: ReplayPoint[] = [];
  const history: ReplayPoint["history"] = [];
  let i = 0;
  while (i < items.length && points.length < maxPoints) {
    if (items[i].kind !== "client") {
      history.push({ role: "assistant", content: maskSensitive(items[i].text).text });
      i++;
      continue;
    }
    // Bloco do cliente.
    const client: typeof items = [];
    while (i < items.length && items[i].kind === "client") client.push(items[i++]);
    // Resposta: tudo que não é cliente até ele falar de novo. Conta como
    // ponto só se uma pessoa respondeu (resposta só de robô não compara).
    const answer: typeof items = [];
    while (i < items.length && items[i].kind !== "client") answer.push(items[i++]);
    const human = answer.filter((a) => a.kind === "human");

    const clientText = maskSensitive(client.map((c) => c.text).join("\n")).text;
    const answerText = maskSensitive(answer.map((a) => a.text).join("\n")).text;

    if (human.length > 0) {
      let skipReason: string | null = null;
      if (client.every((c) => c.isMedia)) skipReason = "Cliente mandou só mídia (sem transcrição/leitura ainda)";
      else if (human.every((h) => h.isMedia)) skipReason = "Resposta da pessoa só em mídia (áudio/arquivo)";
      points.push({
        index: points.length,
        clientText,
        humanText: maskSensitive(human.map((h) => h.text).join("\n")).text,
        history: history.slice(-historyLimit),
        skipReason,
        at: client[0].at.toISOString(),
      });
    }
    history.push({ role: "user", content: clientText });
    if (answerText) history.push({ role: "assistant", content: answerText });
  }
  return points;
}
