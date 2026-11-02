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
import {
  effectiveWebchatMatchField,
  findContactByWebchatIdentity,
  setContactWebchatIdentity,
} from "@/lib/webchat/contact-match";
import {
  adoptOrphanDeal,
  claimDealIdentity,
  dealNoteLabel,
  normalizeDealIdentityValue,
  noteSeparatedIdentity,
  resolveDealIdentity,
  setDealIdentityLinkDeal,
  type DealMatchField,
} from "@/lib/webchat/deal-identity";
import { applyWebchatRouting } from "@/lib/webchat/routing";
import { recordWebchatConversationRef } from "@/lib/webchat/conversation-ref";
import { createWebchatSiteNote, findActiveWebchatConversation } from "@/lib/webchat/conversation-notes";
import { findOrCreateWebchatConversation } from "@/lib/webchat/inbound";
import { sanitizeContextPatch, writeLiveContext } from "@/lib/webchat/live-context";
import { publishWebchatContextChange } from "@/lib/webchat/tracking/realtime";
import type { WebchatChannel } from "@/lib/webchat/session";
import {
  hasWebchatRoutingEffect,
  matchWebchatRoutingRules,
  resolveS2SRouting,
  type WebchatMatchField,
} from "@/lib/webchat/v2-config";
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
  /** Negócio desta entrada: o encontrado pelo valor; sem ele, o aberto mais recente. */
  dealId: string | null;
};

const DEAL_IDENTITY_ATTEMPTS = 3;

async function createS2SContact(
  externalId: string,
  data: Partial<Prisma.ContactUncheckedCreateInput> = {},
): Promise<{ id: string }> {
  const created = (await insertContactWithNextNumber(
    {
      name: externalId,
      lifecycleStage: "LEAD",
      source: SOURCE_NAME,
      ...data,
    } as Omit<Prisma.ContactUncheckedCreateInput, "number" | "organizationId">,
    { id: true },
  )) as { id: string };
  fireTrigger("contact_created", {
    contactId: created.id,
    data: { source: SOURCE_NAME, channel: SOURCE_NAME },
  }).catch((err) => log.warn({ err }, "Falha no gatilho contact_created"));
  return created;
}

/** Mesma resolução do identify assinado: contato pelo negócio com o valor (§9.12). */
async function findOrCreateS2SDealContact(
  channelId: string,
  field: DealMatchField,
  externalId: string,
): Promise<{ id: string; created: boolean; dealId: string | null }> {
  const value = normalizeDealIdentityValue(externalId, field) ?? externalId;
  let createdId: string | null = null;
  for (let attempt = 0; attempt < DEAL_IDENTITY_ATTEMPTS; attempt++) {
    const res = await resolveDealIdentity(channelId, field, value);
    if (res.kind === "contact") {
      if (!res.linked) {
        const won = await claimDealIdentity({
          channelId,
          contactId: res.contactId,
          value,
          dealId: res.dealId,
        });
        if (!won) continue;
      } else if (res.dealId) {
        await setDealIdentityLinkDeal(channelId, value, res.dealId);
      }
      if (res.orphanDealId) await adoptOrphanDeal(res.orphanDealId, res.contactId);
      return { id: res.contactId, created: false, dealId: res.dealId };
    }
    createdId ??= (await createS2SContact(externalId)).id;
    const dealId = res.kind === "not_found" ? null : res.dealId;
    if (!(await claimDealIdentity({ channelId, contactId: createdId, value, dealId }))) continue;
    if (res.kind === "orphan_deal") await adoptOrphanDeal(res.dealId, createdId);
    return { id: createdId, created: true, dealId };
  }
  throw new Error("webchat s2s: vínculo por campo de negócio não concluído");
}

/**
 * Contato do `external_id`; desconhecido → cria (nome = external_id,
 * `source: "Webchat"`, identidade gravada no campo de match). Corrida com
 * outra entrada do mesmo `external_id` cai no unique de `externalId`.
 */
export async function findOrCreateS2SContact(
  matchField: Exclude<WebchatMatchField, { type: "dealCustomField" }>,
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
  const matchField = await effectiveWebchatMatchField(v2.identity.matchField);
  const contact =
    matchField.type === "dealCustomField"
      ? await findOrCreateS2SDealContact(channel.id, matchField, req.externalId)
      : { ...(await findOrCreateS2SContact(matchField, req.externalId)), dealId: null };

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

  // Atendimento: o do canal, com as regras desta entrada por cima (§9.12).
  const rules = matchWebchatRoutingRules(v2.s2s.rules, { category: req.category, priority: req.priority });
  const { routing, force, departmentId } = resolveS2SRouting(v2.routing, rules);
  const routingInput = hasWebchatRoutingEffect(routing) ? { routing, force, departmentId } : null;

  const noteBody = buildWebchatS2SNote(req.text, req.links);
  const dealLabel = noteBody && contact.dealId ? await dealNoteLabel(contact.dealId) : null;
  const noteContent = noteBody && dealLabel ? `${noteBody}\n\n${dealLabel}` : noteBody;
  let conversation = await findActiveWebchatConversation(contact.id, channel.id);
  let conversationCreated = false;
  if (!conversation) {
    const opened = await findOrCreateWebchatConversation(
      contact.id,
      channel.id,
      { content: noteContent, messageType: "note" },
      routingInput,
    );
    const row = await prisma.conversation.findFirst({
      where: { id: opened.id },
      select: { id: true, number: true },
    });
    if (!row) throw new Error("webchat s2s: conversa sumiu logo após abrir");
    conversation = row;
    conversationCreated = opened.created;
    if (opened.created && v2.s2s.queueTagId) await applyTag(contact.id, v2.s2s.queueTagId);
  } else if (routingInput) {
    await applyWebchatRouting({ conversationId: conversation.id, contactId: contact.id, ...routingInput });
  }

  if (matchField.type === "dealCustomField") {
    await noteSeparatedIdentity({
      organizationId: channel.organizationId,
      channelId: channel.id,
      conversationId: conversation.id,
      contactId: contact.id,
    });
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
      dealId: contact.dealId,
    });
  }

  for (const rule of rules) {
    if (rule.tagId) await applyTag(contact.id, rule.tagId);
    // Departamento como destino ganha da ação "departamento" de outra regra.
    if (rule.departmentId && !(routingInput && routing.destination.type === "department")) {
      await setDepartment(channel.organizationId, conversation.id, rule.departmentId);
    }
    if (rule.pinNote && noteId) await pinNote(channel.organizationId, conversation.id, noteId);
  }

  const dealId =
    contact.dealId ??
    (
      await prisma.deal.findFirst({
        where: { contactId: contact.id, status: "OPEN" },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      })
    )?.id ??
    null;

  return {
    conversationId: conversation.id,
    conversationNumber: conversation.number,
    contactId: contact.id,
    contactCreated: contact.created,
    conversationCreated,
    noteId,
    dealId,
  };
}

/**
 * Link da conversa no CRM: `https://{slug}.{base}/inbox?c={number}` (sem
 * slug, a origem explícita do app; sem nenhuma, o path relativo).
 */
export async function webchatConversationUrl(organizationId: string, number: number): Promise<string> {
  return webchatCrmUrl(organizationId, `/inbox?c=${number}`);
}

/** Link do negócio no CRM (`/pipeline?deal={id}`), do mesmo jeito. */
export async function webchatDealUrl(organizationId: string, dealId: string): Promise<string> {
  return webchatCrmUrl(organizationId, `/pipeline?deal=${encodeURIComponent(dealId)}`);
}

async function webchatCrmUrl(organizationId: string, path: string): Promise<string> {
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
