/**
 * "Digitando…" do agente (`POST /api/conversations/:id/typing`).
 *
 * O cliente bate a cada 3 s enquanto há texto no composer — é a rota de
 * maior volume do CRM. O caminho quente é: sessão → acesso em cache →
 * evento SSE `typing`. Nenhuma escrita no banco e nenhuma chamada externa
 * aguardada; no acerto do cache, zero consultas ao Postgres.
 *
 * O indicador no WhatsApp do cliente (Graph API) sai FORA da requisição,
 * no máximo 1 por conversa a cada 20 s, com 1 tentativa e timeout curto.
 * Antes a rota aguardava a Graph (até 3 tentativas × 20 s) e reenviava o
 * `status: "read"` a cada 3 s.
 */
import type { NextResponse } from "next/server";

import { cache } from "@/lib/cache";
import { channelSendsReadReceipts } from "@/lib/channels/config";
import {
  CONVERSATION_ACCESS_SELECT,
  requireConversationAccessAndLoad,
} from "@/lib/conversation-access";
import { getLogger } from "@/lib/logger";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { prisma } from "@/lib/prisma";

const log = getLogger("conversation-typing");

/**
 * Acesso do usuário à conversa, guardado por 60 s (Redis; sem Redis, Map do
 * processo — `cache.get/set`). Só o "pode" é guardado — negado volta ao
 * banco na próxima batida. Perda de acesso leva até 60 s para valer aqui; o
 * que passa nesse intervalo é o "digitando…" do próprio agente.
 */
export const TYPING_ACCESS_TTL_SEC = 60;

/**
 * Uma chamada à Graph por conversa a cada 20 s (claim `SET NX` no Redis,
 * vale entre réplicas). O indicador da Meta dura ~25 s ou até a próxima
 * mensagem; repetir a cada 3 s só remarcava a mensagem como lida — a Graph
 * acopla o indicador ao `status: "read"`, não existe um sem o outro.
 */
export const META_TYPING_DEDUPE_SEC = 20;

/** Timeout da chamada à Graph (fora da requisição, 1 tentativa). */
export const META_TYPING_TIMEOUT_MS = 5_000;

/** O que o caminho quente precisa da conversa — sem `config` do canal (token). */
export type TypingTarget = {
  conversationId: string;
  organizationId: string;
  contactId: string | null;
  channelId: string | null;
  /** Canal Meta configurado e com recibo de leitura ligado. */
  metaTyping: boolean;
};

type TypingSession = Parameters<typeof requireConversationAccessAndLoad>[0] & {
  user: { id: string; organizationId?: string | null };
};

export function typingAccessKey(orgId: string, userId: string, ref: string): string {
  return `typing_acl:${orgId}:${userId}:${ref}`;
}

export function metaTypingDedupeKey(orgId: string, conversationId: string): string {
  return `typing_meta:${orgId}:${conversationId}`;
}

function isTypingTarget(v: unknown): v is TypingTarget {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.conversationId === "string" &&
    typeof t.organizationId === "string" &&
    typeof t.metaTyping === "boolean"
  );
}

/**
 * O "digitando…" da Meta sai no MESMO request que marca a mensagem como
 * lida. Canal com a confirmação de leitura desligada não manda o indicador
 * — senão vaza o visto azul.
 */
function metaTypingEnabled(config: Record<string, unknown> | null | undefined): boolean {
  return metaClientFromConfig(config).configured && channelSendsReadReceipts(config);
}

/**
 * Acesso + dados da conversa: do cache, ou checagem completa
 * (`requireConversationAccessAndLoad` — uma leitura da linha) e guarda.
 * `ref` é o id da URL (CUID ou número na org).
 */
export async function resolveTypingTarget(
  session: TypingSession,
  ref: string,
): Promise<{ target: TypingTarget; response?: undefined } | { response: NextResponse }> {
  const orgId = session.user.organizationId ?? "";
  const key = typingAccessKey(orgId, session.user.id, ref);
  if (orgId) {
    const cached = await cache.get<unknown>(key);
    if (isTypingTarget(cached) && cached.organizationId === orgId) {
      return { target: cached };
    }
  }

  const access = await requireConversationAccessAndLoad(session, ref, (where) =>
    prisma.conversation.findFirst({
      where,
      select: {
        ...CONVERSATION_ACCESS_SELECT,
        channelRef: { select: { config: true } },
      },
    }),
  );
  if (access.response) return { response: access.response };
  const conv = access.conversation;
  const target: TypingTarget = {
    conversationId: conv.id,
    organizationId: conv.organizationId,
    contactId: conv.contactId ?? null,
    channelId: conv.channelId ?? null,
    metaTyping: metaTypingEnabled(
      conv.channelRef?.config as Record<string, unknown> | null | undefined,
    ),
  };
  if (orgId && conv.organizationId === orgId) {
    await cache.set(key, target, TYPING_ACCESS_TTL_SEC);
  }
  return { target };
}

/**
 * Indicador no WhatsApp do cliente. Chamado SEM await pela rota: dedupe por
 * conversa, canal e última inbound lidos aqui, 1 tentativa, timeout curto.
 * Nunca lança — erro só vai para o log (o "digitando…" é cosmético).
 */
export async function dispatchMetaTyping(target: TypingTarget): Promise<void> {
  try {
    if (!target.metaTyping || !target.channelId) return;
    const claimed = await cache.tryClaim(
      metaTypingDedupeKey(target.organizationId, target.conversationId),
      META_TYPING_DEDUPE_SEC,
    );
    if (!claimed) return;
    // CRITICO: o indicador sai pelo canal da conversa (token/phoneId desse
    // tenant), nunca pelo singleton do env — senão "digitando…" aparecia no
    // número de outra org.
    const [channel, lastInbound] = await Promise.all([
      prisma.channel.findUnique({
        where: { id: target.channelId },
        select: { config: true },
      }),
      prisma.message.findFirst({
        where: {
          conversationId: target.conversationId,
          direction: "in",
          externalId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: { externalId: true },
      }),
    ]);
    const config = channel?.config as Record<string, unknown> | null | undefined;
    if (!lastInbound?.externalId || !metaTypingEnabled(config)) return;
    await metaClientFromConfig(config).sendTypingIndicator(lastInbound.externalId, {
      maxAttempts: 1,
      timeoutMs: META_TYPING_TIMEOUT_MS,
    });
  } catch (err) {
    log.warn({ err, conversationId: target.conversationId }, "[typing] indicador Meta falhou");
  }
}
