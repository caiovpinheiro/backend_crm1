/**
 * Webchat v2 — grava a linha do tempo do site e transforma evento
 * importante em nota interna (docs/decisoes/webchat-widget.md §9.3).
 * Roda no contexto de org do canal (`inWebchatOrg`).
 *
 * Importante = flag do site OU nome em `config.v2.events.important`
 * (`isImportantWebchatEvent`). Vira nota privada na conversa webchat ativa
 * do contato no canal; sem conversa ativa, só abre uma se
 * `importantOpensConversation` e houver contato. Visitante anônimo (sem
 * contato) não gera nota: não há conversa a que ligar.
 */
import type { Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import type { LiveContextOwner } from "@/lib/webchat/live-context";
import {
  createWebchatSiteNote,
  findActiveWebchatConversation,
} from "@/lib/webchat/conversation-notes";
import { findOrCreateWebchatConversation } from "@/lib/webchat/inbound";
import { isImportantWebchatEvent, type WebchatV2Config } from "@/lib/webchat/v2-config";

import { buildImportantEventNote, type SanitizedWebchatEvent } from "./events";
import type { WebchatEventDto } from "./realtime";

const log = getLogger("webchat-tracking");

/**
 * Teto de notas por lote: um lote cheio de eventos importantes não vira
 * uma parede de notas na conversa (os eventos continuam gravados como
 * importantes na linha do tempo).
 */
export const WEBCHAT_MAX_NOTES_PER_BATCH = 5;

/** Grava os eventos já validados e devolve como DTO (com o id gerado). */
export async function recordWebchatEvents(args: {
  channelId: string;
  owner: LiveContextOwner;
  events: SanitizedWebchatEvent[];
  config: WebchatV2Config;
}): Promise<WebchatEventDto[]> {
  if (args.events.length === 0) return [];
  const contactId = "contactId" in args.owner ? args.owner.contactId : null;
  const sessionId = "sessionId" in args.owner ? args.owner.sessionId : null;
  const rows = await prisma.webchatEvent.createManyAndReturn({
    data: args.events.map((e) =>
      withOrgFromCtx({
        channelId: args.channelId,
        contactId,
        sessionId,
        name: e.name,
        data: (e.data ?? undefined) as Prisma.InputJsonValue | undefined,
        important: isImportantWebchatEvent(e.name, e.flaggedImportant, args.config),
        occurredAt: e.occurredAt,
      }),
    ),
    select: { id: true, name: true, data: true, important: true, occurredAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    data: (r.data as WebchatEventDto["data"]) ?? null,
    important: r.important,
    occurredAt: r.occurredAt.toISOString(),
  }));
}

/**
 * Notas dos eventos importantes do lote (em ordem de ocorrência, até
 * `WEBCHAT_MAX_NOTES_PER_BATCH`). Best-effort: falha é logada sem dados do
 * visitante e não desfaz a gravação dos eventos. Devolve quantas notas
 * foram criadas.
 */
export async function noteImportantWebchatEvents(args: {
  organizationId: string;
  channelId: string;
  contactId: string | null;
  events: WebchatEventDto[];
  config: WebchatV2Config;
}): Promise<number> {
  const important = args.events
    .filter((e) => e.important)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .slice(0, WEBCHAT_MAX_NOTES_PER_BATCH);
  if (!args.contactId || important.length === 0) return 0;
  const contactId = args.contactId;
  try {
    let conversation: { id: string } | null = await findActiveWebchatConversation(
      contactId,
      args.channelId,
    );
    if (!conversation && args.config.events.importantOpensConversation) {
      conversation = await findOrCreateWebchatConversation(contactId, args.channelId);
    }
    if (!conversation) return 0;
    let created = 0;
    for (const event of important) {
      await createWebchatSiteNote({
        organizationId: args.organizationId,
        conversationId: conversation.id,
        contactId,
        content: buildImportantEventNote(event, args.config.context.labels),
      });
      created++;
    }
    return created;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), channelId: args.channelId },
      "nota de evento importante do site falhou",
    );
    return 0;
  }
}
