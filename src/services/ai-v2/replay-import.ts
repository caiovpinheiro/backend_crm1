/**
 * Conversas anexadas para o "Comparar com humano": exportação do WhatsApp
 * (.txt, ou o .zip com o _chat.txt) ou texto colado no formato
 * "Nome: mensagem". Quem é da equipe é escolhido na tela; o resto vira
 * cliente. Nenhum domínio de cliente.
 */

import { unzipSync } from "fflate";
import type { ReplayMessageRow } from "./replay-extract";

export const IMPORT_LIMITS = { maxTranscripts: 20, maxChars: 300_000, pointsPerTranscript: 30 };

export type TranscriptMessage = { author: string; text: string; at: Date | null; media: string | null };
export type ParsedTranscript = {
  messages: TranscriptMessage[];
  participants: Array<{ name: string; messages: number }>;
  /** Palpite: quem abriu a conversa é o cliente; os demais, equipe. */
  teamGuess: string[];
};

// Android: "24/09/2026 13:19 - Nome: texto"  |  iOS: "[24/09/2026, 13:19:42] Nome: texto"
const WA_LINE =
  /^‎?\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:-\s*)?([^:]{1,60}?):\s?(.*)$/;
// Linha de sistema do WhatsApp (sem autor): criptografia, entrou, mudou o número…
const WA_SYSTEM = /^‎?\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}/;
// Formato colado: "Nome: texto" no começo da linha.
const PLAIN_LINE = /^\s*([\p{L}][\p{L}\p{N} ._'-]{0,39}):\s+(.*)$/u;

const DELETED = /^(esta mensagem foi apagada|mensagem apagada|this message was deleted|você apagou esta mensagem)\.?$/i;

/** Marcador de mídia no lugar do conteúdo ("<Mídia oculta>", "áudio ocultado", "PTT-2026….opus (arquivo anexado)"). */
export function mediaKind(text: string): string | null {
  const t = text.replace(/‎/g, "").trim().toLowerCase();
  const mediaWord = /(m[ií]dia|media|imagem|image|foto|áudio|audio|vídeo|video|figurinha|sticker|documento|document|arquivo|gif)/;
  const isMarker =
    /^<[^>]*(m[ií]dia|media|anexado|attached)[^>]*>$/.test(t) ||
    (t.length <= 40 && mediaWord.test(t) && /(ocultad[oa]|omitted|oculto)$/.test(t)) ||
    /\((arquivo anexado|file attached)\)$/.test(t);
  if (!isMarker) return null;
  if (/(áudio|audio|ptt|\.opus|\.ogg|\.m4a|\.mp3)/.test(t)) return "audio";
  if (/(imagem|image|foto|photo|\.jpe?g|\.png|\.webp)/.test(t)) return "image";
  if (/(vídeo|video|\.mp4)/.test(t)) return "video";
  if (/(figurinha|sticker)/.test(t)) return "sticker";
  return "document";
}

function toDate(d: string, m: string, y: string, hh: string, mm: string, ss?: string, ampm?: string): Date | null {
  let year = Number(y);
  if (year < 100) year += 2000;
  let hour = Number(hh);
  if (ampm) {
    const pm = /^p/i.test(ampm);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const date = new Date(year, Number(m) - 1, Number(d), hour, Number(mm), Number(ss ?? 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseTranscript(raw: string): ParsedTranscript {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const waLines = lines.filter((l) => WA_LINE.test(l)).length;
  const messages: TranscriptMessage[] = [];

  if (waLines > 0) {
    for (const line of lines) {
      const m = WA_LINE.exec(line);
      if (m) {
        const [, d, mo, y, hh, mm, ss, ampm, author, text] = m;
        messages.push({ author: author.replace(/‎/g, "").trim(), text: text ?? "", at: toDate(d, mo, y, hh, mm, ss, ampm), media: null });
      } else if (WA_SYSTEM.test(line)) {
        continue;
      } else if (messages.length > 0 && line.trim()) {
        messages[messages.length - 1].text += `\n${line}`;
      }
    }
  } else {
    // Sem data: só conta como autor um nome que aparece em 2+ linhas, para
    // não confundir "Obs: …" dentro de uma mensagem com troca de autor.
    const counts = new Map<string, number>();
    for (const l of lines) {
      const m = PLAIN_LINE.exec(l);
      if (m) counts.set(m[1].trim(), (counts.get(m[1].trim()) ?? 0) + 1);
    }
    const authors = new Set([...counts].filter(([, n]) => n >= 2).map(([name]) => name));
    for (const line of lines) {
      const m = PLAIN_LINE.exec(line);
      if (m && authors.has(m[1].trim())) messages.push({ author: m[1].trim(), text: m[2], at: null, media: null });
      else if (messages.length > 0 && line.trim()) messages[messages.length - 1].text += `\n${line}`;
    }
  }

  const clean: TranscriptMessage[] = [];
  for (const msg of messages) {
    const text = msg.text.replace(/‎/g, "").trim();
    if (!text || DELETED.test(text)) continue;
    const media = mediaKind(text);
    clean.push({ ...msg, text: media ? "" : text, media });
  }

  const byAuthor = new Map<string, number>();
  for (const msg of clean) byAuthor.set(msg.author, (byAuthor.get(msg.author) ?? 0) + 1);
  const participants = [...byAuthor].map(([name, n]) => ({ name, messages: n }));
  const first = clean[0]?.author;
  return { messages: clean, participants, teamGuess: participants.map((p) => p.name).filter((n) => n !== first) };
}

/** Linhas no formato que a extração de pontos usa: equipe = pessoa, resto = cliente. */
export function transcriptToRows(parsed: ParsedTranscript, teamAuthors: string[]): ReplayMessageRow[] {
  const team = new Set(teamAuthors);
  // Sem data (texto colado): 1 minuto entre mensagens, na ordem.
  const base = Date.UTC(2000, 0, 1);
  let last = 0;
  return parsed.messages.map((msg, i) => {
    let t = msg.at?.getTime() ?? base + i * 60_000;
    if (t < last) t = last; // relógio fora de ordem não inverte a conversa
    last = t;
    const isTeam = team.has(msg.author);
    return {
      direction: isTeam ? "out" : "in",
      authorType: isTeam ? "human" : "contact",
      messageType: msg.media ?? "text",
      content: msg.text,
      createdAt: new Date(t),
    };
  });
}

/** Texto do arquivo: .txt direto; .zip da exportação, o .txt de dentro. */
export function transcriptTextFromFile(name: string, bytes: Uint8Array): string {
  if (/\.zip$/i.test(name)) {
    const entries = unzipSync(bytes, { filter: (f) => /\.txt$/i.test(f.name) });
    const txt = Object.entries(entries).sort(([a], [b]) => Number(/_chat\.txt$/i.test(b)) - Number(/_chat\.txt$/i.test(a)))[0];
    if (!txt) throw new Error("O .zip não tem a conversa (.txt). Exporte a conversa do WhatsApp de novo.");
    return new TextDecoder("utf-8").decode(txt[1]);
  }
  return new TextDecoder("utf-8").decode(bytes);
}
