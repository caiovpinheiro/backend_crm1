/**
 * Regras puras do classificador de tabulação.
 * Sem Prisma, sem I/O — o serviço só aplica o resultado.
 */

import { probeInboundMedia } from "@/lib/ai-agents/media-placeholder";

export type AttendanceMessage = {
  direction: string;
  isPrivate?: boolean | null;
  content?: string | null;
  messageType?: string | null;
  mediaUrl?: string | null;
  authorType?: string | null;
  senderName?: string | null;
  aiAgentUserId?: string | null;
};

export type TabulationCatalogLeaf = {
  id: string;
  number: number;
  path: string;
  departmentId: string;
  departmentName: string;
};

const ACK_WORDS = new Set([
  "ok",
  "okay",
  "oke",
  "okk",
  "blz",
  "beleza",
  "obrigado",
  "obrigada",
  "obg",
  "obgg",
  "vlw",
  "valeu",
  "thanks",
  "thank",
  "thx",
  "tmj",
  "show",
  "perfeito",
  "entendi",
  "certo",
  "ta",
  "fechou",
  "combinado",
  "tchau",
  "flw",
  "falou",
]);

/** Cumprimento solto: não é dúvida nem pedido. */
const GREETING_WORDS = new Set([
  ...ACK_WORDS,
  "oi",
  "ola",
  "oie",
  "oii",
  "oiii",
  "oiee",
  "hey",
  "hi",
  "hello",
  "opa",
  "eai",
  "eae",
  "iae",
  "bom",
  "boa",
  "dia",
  "tarde",
  "noite",
  "tudo",
  "bem",
  "td",
  "esta",
  "bomdia",
  "boatarde",
  "boanoite",
  "tudobem",
]);

function tokenizePromptText(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/\p{Emoji_Component}/gu, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const MEDIA_MESSAGE_TYPES = new Set([
  "image",
  "photo",
  "video",
  "audio",
  "ptt",
  "voice",
  "voice_note",
  "document",
  "file",
  "sticker",
]);

export function isEventMessageType(
  messageType: string | null | undefined,
): boolean {
  if (!messageType) return false;
  return messageType === "event" || messageType.startsWith("event:");
}

export function isSystemEventMessage(msg: AttendanceMessage): boolean {
  if (msg.direction === "system") return true;
  if (msg.authorType === "system") return true;
  return isEventMessageType(msg.messageType);
}

/** Ack curto: ok, obrigado, beleza, só emoji. Sem pergunta/pedido. */
export function isShortAckText(text: string | null | undefined): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  const words = tokenizePromptText(raw);
  if (words.length === 0) return true;
  return words.every((w) => ACK_WORDS.has(w));
}

/** "Bom dia", "Oi Bia tarde", "Tudo bem?" — sem dúvida/pedido. */
export function isGreetingOnlyText(text: string | null | undefined): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  const words = tokenizePromptText(raw);
  if (words.length === 0) return true;
  if (words.length > 6) return false;
  const greetCount = words.filter((w) => GREETING_WORDS.has(w)).length;
  return greetCount >= Math.ceil(words.length * 0.6);
}

/** Ack curto ou cumprimento solto — política de produto, não tenant. */
export function isAckOrGreetingText(text: string | null | undefined): boolean {
  return isShortAckText(text) || isGreetingOnlyText(text);
}

export function messageHasMedia(msg: AttendanceMessage): boolean {
  if (msg.mediaUrl?.trim()) return true;
  const type = (msg.messageType ?? "").toLowerCase();
  if (MEDIA_MESSAGE_TYPES.has(type)) return true;
  return probeInboundMedia({
    content: msg.content,
    messageType: msg.messageType,
  }).kind != null;
}

export function isEligibleInbound(msg: AttendanceMessage): boolean {
  if (msg.direction !== "in") return false;
  if (msg.isPrivate) return false;
  if (isSystemEventMessage(msg)) return false;
  return true;
}

/** Inbound público no recorte: dúvida/pedido/mídia. Ack, cumprimento, vazio e evento não. */
export function inboundMessageShowsDemand(msg: AttendanceMessage): boolean {
  if (!isEligibleInbound(msg)) return false;
  if (messageHasMedia(msg)) return true;
  const text = (msg.content ?? "").trim();
  if (!text) return false;
  if (isShortAckText(text)) return false;
  if (isGreetingOnlyText(text)) return false;
  return true;
}

export function conversationHasAttendanceDemand(
  messages: AttendanceMessage[],
): boolean {
  return messages.some(inboundMessageShowsDemand);
}

/** Resposta de humano ou IA de atendimento. Automação e o próprio tabulador não. */
export function isStaffAttendanceReply(
  msg: AttendanceMessage,
  classifierUserId?: string | null,
): boolean {
  if (msg.direction !== "out") return false;
  if (msg.isPrivate) return false;
  if (isSystemEventMessage(msg)) return false;
  if (msg.authorType === "human") return true;
  if (msg.authorType === "bot" && msg.aiAgentUserId) {
    if (classifierUserId && msg.aiAgentUserId === classifierUserId) return false;
    return true;
  }
  return false;
}

/** Dúvida/pedido inbound + resposta de atendente (humano ou IA de atendimento). */
export function conversationHasRealAttendance(
  messages: AttendanceMessage[],
  classifierUserId?: string | null,
): boolean {
  return (
    conversationHasAttendanceDemand(messages) &&
    messages.some((m) => isStaffAttendanceReply(m, classifierUserId))
  );
}

/** Automação `conversation_tabulated` só quando o ticket realmente fecha. */
export function shouldFireConversationTabulatedTrigger(
  closed: boolean,
): boolean {
  return closed === true;
}

export function partitionCatalogLeaves(
  leaves: TabulationCatalogLeaf[],
  preferredDepartmentId?: string | null,
): { preferred: TabulationCatalogLeaf[]; other: TabulationCatalogLeaf[] } {
  if (!preferredDepartmentId) {
    return { preferred: [], other: [...leaves] };
  }
  const preferred: TabulationCatalogLeaf[] = [];
  const other: TabulationCatalogLeaf[] = [];
  for (const leaf of leaves) {
    if (leaf.departmentId === preferredDepartmentId) preferred.push(leaf);
    else other.push(leaf);
  }
  return { preferred, other };
}

function leafLine(leaf: TabulationCatalogLeaf): string {
  return `- ${leaf.departmentName} / ${leaf.path} [${leaf.number}] id=${leaf.id}`;
}

/**
 * Texto do catálogo no prompt. Sem “fallback de encerramento”.
 * Folhas do departamento da conversa vêm primeiro.
 */
export function formatTabulationCatalogText(
  leaves: TabulationCatalogLeaf[],
  preferredDepartmentId?: string | null,
): string {
  const lines = [
    "",
    "## Catálogo de tabulações (somente folhas)",
    "Prefira as folhas do departamento da conversa. Folha de outro departamento só se as mensagens deixarem isso claro. Use SOMENTE estes IDs. Não invente. Não há fallback de encerramento — se nenhuma folha casar, não tabule.",
  ];
  if (leaves.length === 0) {
    lines.push("Nenhuma folha ativa na organização.");
    return lines.join("\n");
  }

  const { preferred, other } = partitionCatalogLeaves(
    leaves,
    preferredDepartmentId,
  );
  if (preferredDepartmentId) {
    lines.push("### Departamento da conversa (preferido)");
    if (preferred.length === 0) {
      lines.push("Nenhuma folha ativa neste departamento.");
    } else {
      for (const leaf of preferred) lines.push(leafLine(leaf));
    }
    if (other.length > 0) {
      lines.push(
        "### Outros departamentos (só se as mensagens deixarem claro)",
      );
      for (const leaf of other) lines.push(leafLine(leaf));
    }
    return lines.join("\n");
  }

  for (const leaf of leaves) lines.push(leafLine(leaf));
  return lines.join("\n");
}
