/**
 * Regra ÚNICA de "esta mensagem é só um placeholder de mídia".
 *
 * O webhook Meta grava `content="[Imagem]"` / `"[Vídeo]"` / `"[Documento]"`
 * quando a mídia chega sem legenda (`src/lib/meta-webhook/handler.ts`), e o
 * worker Baileys grava `"[image] 👁"` / `"[audio]"` / `"[ptt]"`. Nada disso é
 * pergunta do cliente: é AUSÊNCIA de conteúdo textual.
 *
 * A regra vivia duplicada (`MEDIA_PLACEHOLDER_RE` em `audio-inbound.ts`) e o
 * resto do runtime não conhecia. Resultado em produção: "[Imagem]" chegou ao
 * modelo como pergunta e, por ter menos de 25 caracteres, ainda autorizou o
 * enriquecimento da query de RAG com perguntas antigas do cliente. Módulo
 * compartilhado justamente para não repetir a divergência de regra.
 *
 * Sem dependência de Prisma/config — é só o reconhecimento do texto.
 */

/** Tipos de mídia que o operador configura na tela do agente. */
export type MediaKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "other";

export const MEDIA_KINDS: MediaKind[] = [
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
  "other",
];

/**
 * Placeholder de qualquer mídia num PREFIXO (`[Imagem]`, `[audio] 👁`…).
 * Mantido exportado porque `audio-inbound` usa a forma frouxa para decidir
 * "ruído"; para saber se a mensagem INTEIRA é placeholder use
 * `mediaPlaceholderKind`.
 */
export const MEDIA_PLACEHOLDER_RE = /^\[[^\]]{1,30}\]/;

/** Placeholder isolado: nada além dele além de espaço, pontuação ou emoji. */
const PLACEHOLDER_ONLY_RE = /^\[\s*([^\]]{1,30}?)\s*\][\s\p{P}\p{S}]*$/u;

/** Token dentro dos colchetes → tipo de mídia. */
const KIND_BY_TOKEN: Record<string, MediaKind> = {
  imagem: "image",
  image: "image",
  foto: "image",
  photo: "image",
  video: "video",
  audio: "audio",
  ptt: "audio",
  voice: "audio",
  "voice note": "audio",
  "mensagem de voz": "audio",
  documento: "document",
  document: "document",
  doc: "document",
  arquivo: "document",
  file: "document",
  pdf: "document",
  sticker: "sticker",
  figurinha: "sticker",
  localizacao: "location",
  location: "location",
  contato: "contact",
  contact: "contact",
  contacts: "contact",
  "contato compartilhado": "contact",
};

/** `Message.messageType` gravado por canal → tipo de mídia. */
const KIND_BY_MESSAGE_TYPE: Record<string, MediaKind> = {
  image: "image",
  photo: "image",
  video: "video",
  audio: "audio",
  ptt: "audio",
  voice: "audio",
  voice_note: "audio",
  document: "document",
  file: "document",
  sticker: "sticker",
  location: "location",
  contact: "contact",
  contacts: "contact",
};

/** Minúsculas, sem acento, espaços normalizados. */
export function foldMediaText(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tipo da mídia quando o conteúdo é SÓ o placeholder. Legenda/transcrição
 * junto do placeholder devolve `null`: aí existe pedido de verdade e o
 * modelo pode atender.
 */
export function mediaPlaceholderKind(
  content: string | null | undefined,
): MediaKind | null {
  const folded = foldMediaText(content);
  if (!folded) return null;
  const match = PLACEHOLDER_ONLY_RE.exec(folded);
  if (!match) return null;
  const token = match[1].replace(/[\s_-]+/g, " ").trim();
  return KIND_BY_TOKEN[token] ?? "other";
}

/** True quando o conteúdo é apenas placeholder de mídia. */
export function isMediaPlaceholderText(
  content: string | null | undefined,
): boolean {
  return mediaPlaceholderKind(content) !== null;
}

/**
 * Conteúdo AUSENTE: mensagem vazia ou só placeholder de mídia. Não é
 * "mensagem curta" — é falta de texto do cliente.
 */
export function isContentlessInbound(
  content: string | null | undefined,
): boolean {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return true;
  return isMediaPlaceholderText(trimmed);
}

/**
 * Remove do texto agregado as linhas sem conteúdo (placeholder/vazias).
 * Devolve "" quando o cliente não escreveu nada — a query de recuperação
 * precisa disso para não buscar "[Imagem]".
 */
export function stripMediaPlaceholders(
  text: string | null | undefined,
): string {
  return (text ?? "")
    .split("\n")
    .filter((line) => !isContentlessInbound(line))
    .join("\n")
    .trim();
}

export type InboundMediaProbe = {
  /// Tipo da mídia identificado por `messageType` ou pelo placeholder.
  kind: MediaKind | null;
  /// O cliente não deixou texto utilizável nesta mensagem.
  contentless: boolean;
};

/**
 * Inspeciona uma mensagem inbound. `messageType` tem prioridade sobre o
 * texto: um documento nomeado `[relatorio].pdf` não deve ser lido como
 * placeholder, e uma imagem com legenda continua sendo imagem — só não é
 * `contentless`.
 */
export function probeInboundMedia(input: {
  content: string | null | undefined;
  messageType?: string | null;
}): InboundMediaProbe {
  const byType = KIND_BY_MESSAGE_TYPE[foldMediaText(input.messageType)] ?? null;
  const byText = mediaPlaceholderKind(input.content);
  return {
    kind: byType ?? byText,
    contentless: isContentlessInbound(input.content),
  };
}
