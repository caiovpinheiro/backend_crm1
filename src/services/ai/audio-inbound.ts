/**
 * Áudio/voz do aluno → transferência determinística.
 *
 * O WhatsApp entrega áudio como mídia: o webhook Meta grava a Message com
 * `messageType="audio"` e conteúdo `"[Áudio]"`; o worker Baileys grava
 * `messageType="audio"|"ptt"` e conteúdo `"[audio]"`/`"[ptt]"`. Ou seja, o
 * que chega ao LLM é só um placeholder — sem transcrição automática.
 *
 * Antes o modelo improvisava ("não consegui ouvir o áudio, pode escrever?").
 * A regra da operação é outra: áudio → acolhe e distribui para um humano.
 * Por isso a decisão é feita aqui, no inbound, sem depender do prompt.
 */

import { prisma } from "@/lib/prisma";
import {
  buildAssignedConsultantNotice,
  humanAttendanceStartHint,
  isHumanAttendanceWindowOpen,
} from "@/services/ai/human-queue-policy";

/** `Message.messageType` gravados para áudio/voz nos canais WhatsApp. */
const AUDIO_MESSAGE_TYPES = new Set(["audio", "ptt", "voice", "voice_note"]);

/** Placeholders de conteúdo usados quando o áudio não tem texto. */
const AUDIO_PLACEHOLDER_RE = /^\[\s*(audio|ptt|voice|voice_note)\s*\]/;

/** Placeholder de qualquer mídia (`[Imagem]`, `[Documento]`, `[audio] 👁`…). */
const MEDIA_PLACEHOLDER_RE = /^\[[^\]]{1,30}\]/;

/** Ruído sem pedido útil: saudação, desculpa, ack curto. */
const NOISE_TEXT_RE =
  /^(oi+|ola+|oie+|hey|hello|opa|bom dia|boa tarde|boa noite|tudo bem|td bem|desculpa|desculpe|foi mal|vamos continuar|continuando|ok|okay|obrigad[oa]|valeu|vlw|blz|beleza|certo|ta|entendi)$/;

function normalize(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[!?.…,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True se o conteúdo é só o placeholder de um áudio (sem transcrição). */
export function isAudioPlaceholderText(content: string | null | undefined): boolean {
  const n = normalize(content ?? "");
  return AUDIO_PLACEHOLDER_RE.test(n);
}

/** True se o texto não carrega pedido algum (placeholder de mídia, saudação, ack). */
function isNoiseText(content: string | null | undefined): boolean {
  const n = normalize(content ?? "");
  if (!n) return true;
  if (MEDIA_PLACEHOLDER_RE.test(n)) return true;
  if (n.length <= 40 && NOISE_TEXT_RE.test(n)) return true;
  return false;
}

export type InboundAudioCheck = {
  /** O aluno mandou pelo menos um áudio nesta rodada. */
  hasAudio: boolean;
  /** Existe texto aproveitável junto (transcrição, legenda ou pergunta escrita). */
  hasUsableText: boolean;
  /** Áudio sem nada aproveitável → transferir para humano. */
  shouldHandoff: boolean;
};

/**
 * Inspeciona as mensagens inbound ainda não respondidas (mesma janela do
 * debounce: tudo depois da última outbound) para decidir se a rodada é
 * essencialmente um áudio.
 */
export async function detectInboundAudio(args: {
  conversationId: string;
  userMessage: string;
}): Promise<InboundAudioCheck> {
  let hasAudio = false;
  let hasUsableText = false;

  try {
    const lastOut = await prisma.message.findFirst({
      where: {
        conversationId: args.conversationId,
        direction: "out",
        isPrivate: false,
        messageType: { not: "note" },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    const inbound = await prisma.message.findMany({
      where: {
        conversationId: args.conversationId,
        direction: "in",
        ...(lastOut ? { createdAt: { gt: lastOut.createdAt } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: 30,
      select: { content: true, authorType: true, messageType: true },
    });

    for (const m of inbound) {
      if (m.authorType === "bot" || m.authorType === "system") continue;
      if (m.messageType === "note") continue;
      const isAudioMsg =
        AUDIO_MESSAGE_TYPES.has((m.messageType ?? "").toLowerCase()) ||
        isAudioPlaceholderText(m.content);
      if (isAudioMsg) {
        hasAudio = true;
        // Áudio com transcrição/legenda salva no conteúdo já é atendível.
        if (!isNoiseText(m.content)) hasUsableText = true;
        continue;
      }
      if (!isNoiseText(m.content)) hasUsableText = true;
    }
  } catch (e) {
    console.error("[ai] detectInboundAudio failed", e);
  }

  // Fallback: sem linha no banco (ex.: caminho sem persistência), o texto
  // agregado ainda denuncia o áudio pelo placeholder.
  if (!hasAudio) {
    const lines = args.userMessage.split("\n");
    for (const line of lines) {
      if (isAudioPlaceholderText(line)) {
        hasAudio = true;
      } else if (!isNoiseText(line)) {
        hasUsableText = true;
      }
    }
  }

  return { hasAudio, hasUsableText, shouldHandoff: hasAudio && !hasUsableText };
}

/**
 * Aviso ao aluno quando o áudio dispara a transferência.
 * Nunca diz que "não conseguiu ouvir" nem pede para escrever de novo.
 * Fora do expediente, não promete consultor imediato — informa o retorno.
 */
export function buildAudioHandoffMessage(args: {
  assignedToHuman: boolean;
  now?: Date;
}): string {
  const now = args.now ?? new Date();
  if (args.assignedToHuman) {
    return `Recebi seu áudio! 💛 ${buildAssignedConsultantNotice()}`;
  }
  if (isHumanAttendanceWindowOpen(now)) {
    return (
      "Recebi seu áudio! 💛 Pra te ajudar do jeito certo, já pedi para um(a) " +
      "*consultor(a)* da equipe continuar com você por aqui. " +
      "Fica tranquila que seu pedido já está registrado, tá?"
    );
  }
  const { startHour, dayLabel } = humanAttendanceStartHint(now);
  return (
    `Recebi seu áudio! 💛 Já registrei seu atendimento com a equipe. ` +
    `O atendimento humano retoma às *${startHour}h* ${dayLabel} e ` +
    `continuam com você por aqui, tá?`
  );
}

/** Trechos do aviso de áudio — evita repetir a bolha em áudios seguidos. */
const AUDIO_NOTICE_MARKERS = ["recebi seu audio", "recebi seu áudio"];

export function messageLooksLikeAudioNotice(
  content: string | null | undefined,
): boolean {
  if (!content) return false;
  const n = normalize(content);
  return AUDIO_NOTICE_MARKERS.some((m) => n.includes(normalize(m)));
}
