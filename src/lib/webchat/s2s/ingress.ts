/**
 * Webchat v2 — efeito da entrada servidor a servidor
 * (docs/decisoes/webchat-widget.md §9.6). Chamado pela rota
 * `POST /api/public/webchat/s2s/{publicKey}` já autenticada, com a chave de
 * idempotência reservada, dentro do contexto de org do canal.
 *
 * Ordem: contato pelo campo de match (desconhecido → cria) → `fields` no
 * contexto vivo → conversa webchat ativa (ou nova, com a tag da fila) →
 * nota privada (`text` + `links`) → `ref` → regras de category/priority.
 * Ids configurados que não existem na org são ignorados (não quebram).
 */
import { Prisma } from "@prisma/client";

import { noteMessageChange } from "@/lib/cache/message-versions";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { publishConversationUpdated } from "@/lib/realtime-events";
import { explicitAppOrigin } from "@/lib/app-origin";
import { buildTenantUrl } from "@/lib/tenant-url";
import { findContactByWebchatIdentity, setContactWebchatIdentity } from "@/lib/webchat/contact-match";
import { recordWebchatConversationRef } from "@/lib/webchat/conversation-ref";
import { createWebchatSiteNote, findActiveWebchatConversation } from "@/lib/webchat/conversation-notes";
import { findOrCreateWebchatConversation } from "@/lib/webchat/inbound";
import { sanitizeContextPatch, writeLiveContext } from "@/lib/webchat/live-context";
import { publishWebchatContextChange } from "@/lib/webchat/tracking/realtime";
import type { WebchatChannel } from "@/lib/webchat/session";
import { matchWebchatRoutingRules, type WebchatMatchField } from "@/lib/webchat/v2-config";
import { buildWebchatS2SNote, type WebchatS2SRequest } from "@/lib/webchat/s2s/body";
import { fireTrigger } from "@/services/automation-triggers";
import { insertContactWithNextNumber, isPrismaUniqueViolation } from "@/services/contacts";
import { addTagToContact } from "@/services/tags";

const log = getLogger("webchat-s2s");

const SOURCE_NAME = "Webchat";

export type WebchatS2SResult = {
  conversationId: string;
  conversationNumber: number;
  contactId: string;
  contactCreated: boolean;
  conversationCreated: boolean;
  noteId: string | null;
};

/** Campo de match configurado; campo personalizado inexistente → `externalId`. */
async function effectiveMatchField(configured: WebchatMatchField): Promise<WebchatMatchField> {
  if (configured.type === "externalId") return configured;
  const field = await prisma.customField.findFirst({
    where: { id: configured.customFieldId, entity: "contact" },
    select: { id: true },
  });
  return field ? configured : { type: "externalId" };
}

/**
 * Contato do `external_id`; desconhecido → cria (nome = external_id,
 * `source: "Webchat"`, identidade gravada no campo de match). Corrida com
 * outra entrada do mesmo `external_id` cai no unique de `externalId`.
 */
export async function findOrCreateS2SContact(
  matchField: WebchatMatchField,
  externalId: string,
): Promise<{ id: string; created: boolean }> {
  const found = await findContactByWebchatIdentity(matchField, externalId);
  if (found) return { id: found.id, created: false };

  let created: { id: string };
  try {
    created = (await insertContactWithNextNumber(
      {
        name: externalId,
        lifecycleStage: "LEAD",
        source: SOURCE_NAME,
        ...(matchField.type === "externalId" ? { externalId } : {}),
      } as Omit<Prisma.ContactUncheckedCreateInput, "number" | "organizationId">,
      { id: true },
    )) as { id: string };
  } catch (err) {
    if (!isPrismaUniqueViolation(err)) throw err;
    const won = await findContactByWebchatIdentity(matchField, externalId);
    if (!won) throw err;
    return { id: won.id, created: false };
  }
  if (matchField.type === "customField") {
    await setContactWebchatIdentity(created.id, matchField, externalId);
  }
  fireTrigger("contact_created", {
    contactId: created.id,
    data: { source: SOURCE_NAME, channel: SOURCE_NAME },
  }).catch((err) => log.warn({ err }, "Falha no gatilho contact_created"));
  return { id: created.id, created: true };
}

/** Tag existente na org, aplicada uma vez. Nunca lança. */
async function applyTag(contactId: string, tagId: string): Promise<void> {
  try {
    const tag = await prisma.tag.findFirst({ where: { id: tagId }, select: { id: true } });
    if (!tag) return;
    const already = await prisma.tagOnContact.findFirst({
      where: { contactId, tagId: tag.id },
      select: { contactId: true },
    });
    if (already) return;
    await addTagToContact(contactId, tag.id);
  } catch (err) {
    if (isPrismaUniqueViolation(err)) return;
    log.warn({ err }, "tag do S2S não aplicada (não-fatal)");
  }
}

async function setDepartment(organizationId: string, conversationId: string, departmentId: string): Promise<void> {
  try {
    const dep = await prisma.department.findFirst({ where: { id: departmentId }, select: { id: true } });
    if (!dep) return;
    await prisma.conversation.update({ where: { id: conversationId }, data: { departmentId: dep.id } });
    try {
      publishConversationUpdated({ organizationId, conversationId, departmentId: dep.id });
    } catch {
      /* best-effort */
    }
  } catch (err) {
    log.warn({ err }, "departamento do S2S não aplicado (não-fatal)");
  }
}

async function pinNote(organizationId: string, conversationId: string, noteId: string): Promise<void> {
  try {
    await prisma.conversation.update({ where: { id: conversationId }, data: { pinnedNoteId: noteId } });
    void noteMessageChange(organizationId, conversationId, "meta");
  } catch (err) {
    log.warn({ err }, "nota do S2S não fixada (não-fatal)");
  }
}

export async function processWebchatS2SIngress(
  channel: WebchatChannel,
  req: WebchatS2SRequest,
): Promise<WebchatS2SResult> {
  const v2 = channel.v2;
  const matchField = await effectiveMatchField(v2.identity.matchField);
  const contact = await findOrCreateS2SContact(matchField, req.externalId);

  if (req.fields) {
    const patch = sanitizeContextPatch(req.fields, { maxValueChars: v2.context.maxValueChars });
    if (patch) {
      const written = await writeLiveContext({
        channelId: channel.id,
        owner: { contactId: contact.id },
        patch,
        maxKeys: v2.context.maxKeys,
      });
      // Painel "No site agora" ao vivo (publicador da frente B, best-effort).
      if (written.changed) {
        publishWebchatContextChange({
          organizationId: channel.organizationId,
          channelId: channel.id,
          contactId: contact.id,
          state: written.state,
          updatedAt: written.updatedAt,
        });
      }
    }
  }

  const noteContent = buildWebchatS2SNote(req.text, req.links);
  let conversation = await findActiveWebchatConversation(contact.id, channel.id);
  let conversationCreated = false;
  if (!conversation) {
    const opened = await findOrCreateWebchatConversation(contact.id, channel.id, {
      content: noteContent,
      messageType: "note",
    });
    const row = await prisma.conversation.findFirst({
      where: { id: opened.id },
      select: { id: true, number: true },
    });
    if (!row) throw new Error("webchat s2s: conversa sumiu logo após abrir");
    conversation = row;
    conversationCreated = opened.created;
    if (opened.created && v2.s2s.queueTagId) await applyTag(contact.id, v2.s2s.queueTagId);
  }

  const noteId = noteContent
    ? await createWebchatSiteNote({
        organizationId: channel.organizationId,
        conversationId: conversation.id,
        contactId: contact.id,
        content: noteContent,
      })
    : null;

  if (req.ref) {
    await recordWebchatConversationRef({
      conversationId: conversation.id,
      contactId: contact.id,
      ref: req.ref,
      source: "s2s",
      category: req.category,
      priority: req.priority,
      refDealCustomFieldId: v2.refDealCustomFieldId,
    });
  }

  const rules = matchWebchatRoutingRules(v2.s2s.rules, { category: req.category, priority: req.priority });
  for (const rule of rules) {
    if (rule.tagId) await applyTag(contact.id, rule.tagId);
    if (rule.departmentId) await setDepartment(channel.organizationId, conversation.id, rule.departmentId);
    if (rule.pinNote && noteId) await pinNote(channel.organizationId, conversation.id, noteId);
  }

  return {
    conversationId: conversation.id,
    conversationNumber: conversation.number,
    contactId: contact.id,
    contactCreated: contact.created,
    conversationCreated,
    noteId,
  };
}

/**
 * Link da conversa no CRM: `https://{slug}.{base}/inbox?c={number}` (sem
 * slug, a origem explícita do app; sem nenhuma, o path relativo).
 */
export async function webchatConversationUrl(organizationId: string, number: number): Promise<string> {
  const path = `/inbox?c=${number}`;
  try {
    // prismaBase: Organization não é tenant-scoped (lê só o slug da própria org).
    const org = await prismaBase.organization.findUnique({
      where: { id: organizationId },
      select: { slug: true },
    });
    if (org?.slug) return `${buildTenantUrl(org.slug)}${path}`;
  } catch (err) {
    log.debug({ err }, "slug da org indisponível para o link do S2S");
  }
  const origin = explicitAppOrigin();
  return origin ? `${origin}${path}` : path;
}
