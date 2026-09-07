/**
 * Mídia inbound sem legenda → decisão determinística, nunca prompt.
 *
 * Mesmo padrão arquitetural de `audio-inbound.ts`: a política é resolvida
 * aqui, no inbound, e o placeholder (`[Imagem]`, `[Documento]`, `[Vídeo]`…)
 * jamais chega ao modelo como se fosse a pergunta do cliente. Áudio já tinha
 * esse tratamento; imagem/vídeo/documento não tinham, e um "[Imagem]" virou
 * pergunta de 25 caracteres que arrastou histórico velho no RAG.
 *
 * A ação é configurável por agente (`inboxPolicy.media`) e vale para agente
 * sem `verticalPack`: o handoff usa a distribuição genérica quando o pack não
 * oferece rota de departamento.
 */

import {
  MEDIA_KINDS,
  probeInboundMedia,
  type MediaKind,
} from "@/lib/ai-agents/media-placeholder";
import type {
  InboxPolicy,
  MediaInboundAction,
} from "@/lib/ai-agents/steering";
import { prisma } from "@/lib/prisma";

/** Quanto mais grave, maior — decide quando o lote mistura tipos. */
const ACTION_SEVERITY: Record<MediaInboundAction, number> = {
  ignore: 0,
  ask_text: 1,
  handoff: 2,
};

export type InboundMediaVerdict = {
  /// Tipos de mídia que chegaram sem texto utilizável.
  kinds: MediaKind[];
  /// Alguma mensagem do lote trouxe texto de verdade (legenda, pergunta).
  hasUsableText: boolean;
  /// Ação a executar. `null` = segue o fluxo normal (LLM).
  action: MediaInboundAction | null;
};

/**
 * Inspeciona o lote inbound ainda não respondido (tudo depois da última
 * outbound, com o mesmo teto temporal do turno) e resolve a ação.
 *
 * Mídia COM legenda não dispara nada: existe pedido de verdade e o modelo
 * pode atender — o placeholder já saiu da query de recuperação.
 */
export async function evaluateInboundMedia(args: {
  conversationId: string;
  userMessage: string;
  policy: InboxPolicy;
}): Promise<InboundMediaVerdict> {
  const kinds = new Set<MediaKind>();
  let hasUsableText = false;
  let sawRow = false;

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
      select: {
        content: true,
        authorType: true,
        messageType: true,
        createdAt: true,
      },
    });

    const usable = inbound.filter(
      (m) =>
        m.authorType !== "bot" &&
        m.authorType !== "system" &&
        m.messageType !== "note",
    );
    const batch = withinBatchWindow(usable, args.policy.inboundBatchWindowMinutes);

    for (const m of batch) {
      sawRow = true;
      const probe = probeInboundMedia({
        content: m.content,
        messageType: m.messageType,
      });
      if (!probe.contentless) {
        hasUsableText = true;
        continue;
      }
      if (probe.kind) kinds.add(probe.kind);
    }
  } catch (e) {
    console.error("[ai] evaluateInboundMedia failed", e);
  }

  // Fallback sem linha no banco: o texto agregado denuncia a mídia pelo
  // placeholder (mesmo recurso do detector de áudio).
  if (!sawRow) {
    for (const line of (args.userMessage ?? "").split("\n")) {
      const probe = probeInboundMedia({ content: line });
      if (!probe.contentless) {
        hasUsableText = true;
        continue;
      }
      if (probe.kind) kinds.add(probe.kind);
    }
  }

  const list = MEDIA_KINDS.filter((k) => kinds.has(k));
  if (hasUsableText || list.length === 0) {
    return { kinds: list, hasUsableText, action: null };
  }

  let action: MediaInboundAction = "ignore";
  for (const kind of list) {
    const candidate = args.policy.media.actions[kind] ?? "handoff";
    if (ACTION_SEVERITY[candidate] > ACTION_SEVERITY[action]) action = candidate;
  }
  return { kinds: list, hasUsableText, action };
}

/** Mantém só as mensagens dentro da janela, ancorada na mais NOVA do lote. */
function withinBatchWindow<T extends { createdAt: Date }>(
  rows: T[],
  windowMinutes: number,
): T[] {
  if (windowMinutes <= 0 || rows.length === 0) return rows;
  const newest = rows[rows.length - 1].createdAt.getTime();
  const cutoff = newest - windowMinutes * 60_000;
  return rows.filter((r) => r.createdAt.getTime() >= cutoff);
}

const KIND_NOUN: Record<MediaKind, string> = {
  image: "sua imagem",
  video: "seu vídeo",
  audio: "seu áudio",
  document: "seu documento",
  sticker: "sua figurinha",
  location: "sua localização",
  contact: "o contato que você enviou",
  other: "seu arquivo",
};

/** Aviso ao cliente quando a mídia dispara transferência. */
export function buildMediaHandoffMessage(args: {
  kinds: MediaKind[];
  assignedToHuman: boolean;
  policy: InboxPolicy;
}): string {
  if (args.policy.media.handoffMessage) return args.policy.media.handoffMessage;
  const noun = KIND_NOUN[args.kinds[0] ?? "other"];
  if (args.assignedToHuman) {
    return `Recebi ${noun}! Já passei seu atendimento para uma pessoa da equipe, que continua com você por aqui.`;
  }
  return `Recebi ${noun}! Para te ajudar do jeito certo, já registrei seu atendimento com a equipe e alguém continua com você por aqui.`;
}

/** Pedido de texto — nunca diz que "não conseguiu abrir/ver" a mídia. */
export function buildMediaAskTextMessage(args: {
  kinds: MediaKind[];
  policy: InboxPolicy;
}): string {
  if (args.policy.media.askTextMessage) return args.policy.media.askTextMessage;
  const noun = KIND_NOUN[args.kinds[0] ?? "other"];
  return `Recebi ${noun}! Para eu te ajudar por aqui, me conta em texto o que você precisa?`;
}

/**
 * Transferência para humano após mídia. Usa a rota de departamento do pack
 * quando existe; sem pack, chama a Distribuição Inteligente direto — é o que
 * mantém a correção válida para comercial, SAC, retenção, qualquer ramo.
 */
export async function queueMediaHandoff(args: {
  conversationId: string;
  contactId: string;
  dealId?: string | null;
  userMessage: string;
  reason: string;
  policy: InboxPolicy;
  packHandoff?: ((input: {
    conversationId: string;
    contactId: string | null;
    dealId?: string | null;
    userMessage?: string | null;
    reason?: string;
    policy?: InboxPolicy | null;
  }) => Promise<unknown>) | null;
}): Promise<void> {
  if (args.packHandoff) {
    await args
      .packHandoff({
        conversationId: args.conversationId,
        contactId: args.contactId,
        dealId: args.dealId ?? null,
        userMessage: args.userMessage,
        reason: args.reason,
        policy: args.policy,
      })
      .catch(() => null);
    return;
  }

  const conv = await prisma.conversation
    .findUnique({
      where: { id: args.conversationId },
      select: { departmentId: true },
    })
    .catch(() => null);
  const { executeDistribution } = await import("@/services/distribution");
  await executeDistribution({
    dealId: args.dealId ?? null,
    contactId: args.contactId,
    conversationId: args.conversationId,
    triggerSource: "SYSTEM",
    departmentId: conv?.departmentId ?? null,
    // Fronteira de departamento estrita, igual ao resto do inbox.
    allowOrgWideFallback: false,
  }).catch(() => null);
}
