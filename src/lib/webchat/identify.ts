/**
 * Identificação do visitante do webchat (docs/decisoes/webchat-widget.md §3.2).
 *
 * Cruza e-mail/telefone (normalizados, dentro da org) com contatos que já
 * existem:
 *  - achou → o contato existente sobrevive. Se o visitante já tinha contato
 *    anônimo, ele é fundido no existente (`mergeContacts`): sessões do
 *    widget repontadas antes (a FK em cascata as apagaria), ticket webchat
 *    aberto religado (`linkContactToConversation`) ou, se o existente já
 *    tinha ticket webchat aberto no canal, as mensagens do anônimo vão para
 *    ele e o ticket do anônimo é encerrado (um ticket ativo por contato e
 *    canal). `webchatVisitorId` passa para o sobrevivente se ele não tinha.
 *  - não achou → o contato do visitante recebe nome/e-mail/telefone (ou é
 *    criado agora, se o visitante ainda não tinha escrito).
 * O inbox recebe `contact_updated` + `conversation_updated`.
 *
 * Roda dentro de `withSystemContext(organizationId)`.
 */
import { defaultDealTitleForContact } from "@/lib/display-name";
import { getLogger } from "@/lib/logger";
import { parseContactPhoneInput, phoneMatchVariants } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { invalidateBoardData } from "@/lib/cache/keys";
import { noteMessageChange } from "@/lib/cache/message-versions";
import { publishContactUpdated, publishConversationUpdated } from "@/lib/realtime-events";
import {
  anonymousVisitorName,
  ensureVisitorContact,
  WEBCHAT_CONVERSATION_CHANNEL,
} from "@/lib/webchat/inbound";
import type { WebchatSessionRow } from "@/lib/webchat/session";
import { linkContactToConversation } from "@/services/conversations";
import { mergeContacts } from "@/services/merge-contacts";

const log = getLogger("webchat-identify");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 120;
const MAX_EMAIL = 254;

export class WebchatIdentifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebchatIdentifyError";
  }
}

export type WebchatIdentity = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

/** Valida o que o visitante digitou. Lança `WebchatIdentifyError` (400). */
export function parseWebchatIdentity(input: {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
}): WebchatIdentity {
  const str = (v: unknown, field: string): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new WebchatIdentifyError(`${field} deve ser texto.`);
    const t = v.trim();
    return t || null;
  };
  const name = str(input.name, "name");
  if (name && name.length > MAX_NAME) {
    throw new WebchatIdentifyError(`Nome passa de ${MAX_NAME} caracteres.`);
  }
  const emailRaw = str(input.email, "email");
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  if (email && (email.length > MAX_EMAIL || !EMAIL_RE.test(email))) {
    throw new WebchatIdentifyError("E-mail inválido.");
  }
  const phoneRaw = str(input.phone, "phone");
  let phone: string | null = null;
  if (phoneRaw) {
    const parsed = parseContactPhoneInput(phoneRaw);
    if (!parsed.ok) throw new WebchatIdentifyError(parsed.reason);
    phone = parsed.value;
  }
  return { name, email, phone };
}

export function hasIdentity(id: WebchatIdentity): boolean {
  return Boolean(id.name || id.email || id.phone);
}

export type IdentifyResult = {
  contactId: string;
  /** O visitante foi ligado a um contato que já existia na org. */
  merged: boolean;
  matchedBy: "email" | "phone" | null;
};

type ContactLite = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  webchatVisitorId: string | null;
};

const CONTACT_LITE = {
  id: true,
  name: true,
  email: true,
  phone: true,
  webchatVisitorId: true,
} as const;

/** Contato existente por e-mail ou telefone (com/sem o 9), o mais antigo. */
async function findMatchingContact(
  identity: WebchatIdentity,
  excludeId: string | null,
): Promise<{ contact: ContactLite; by: "email" | "phone" } | null> {
  const notSelf = excludeId ? { id: { not: excludeId } } : {};
  if (identity.email) {
    const byEmail = await prisma.contact.findFirst({
      where: { ...notSelf, email: { equals: identity.email, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
      select: CONTACT_LITE,
    });
    if (byEmail) return { contact: byEmail, by: "email" };
  }
  const variants = phoneMatchVariants(identity.phone);
  if (variants.length > 0) {
    const byPhone = await prisma.contact.findFirst({
      where: { ...notSelf, phone: { in: variants } },
      orderBy: { createdAt: "asc" },
      select: CONTACT_LITE,
    });
    if (byPhone) return { contact: byPhone, by: "phone" };
  }
  return null;
}

/** Só preenche o que está vazio no contato que já existia. */
function fillEmpty(contact: ContactLite, identity: WebchatIdentity): Record<string, string> {
  const data: Record<string, string> = {};
  if (identity.email && !contact.email) data.email = identity.email;
  if (identity.phone && !contact.phone) data.phone = identity.phone;
  return data;
}

/**
 * O auto-deal do visitante anônimo nasce "Negócio Visitante a1b2c3"
 * (`defaultDealTitleForContact`, o mesmo do `ensureOpenDealForContact`).
 * Depois de identificado, os deals abertos do contato que AINDA têm
 * exatamente esse título passam para o título padrão com o nome real.
 * Título editado pelo operador (qualquer outro texto) não é tocado.
 * Devolve quantos foram renomeados.
 */
export async function renameAnonymousVisitorDeals(
  organizationId: string,
  contactId: string,
  visitorId: string,
  realName: string | null | undefined,
): Promise<number> {
  const placeholder = defaultDealTitleForContact(anonymousVisitorName(visitorId));
  const next = defaultDealTitleForContact(realName);
  if (!placeholder || !next || next === placeholder) return 0;
  const deals = await prisma.deal.findMany({
    where: { contactId, status: "OPEN", title: placeholder },
    select: { id: true, stage: { select: { pipelineId: true } } },
  });
  if (deals.length === 0) return 0;
  const res = await prisma.deal.updateMany({
    where: { id: { in: deals.map((d) => d.id) }, title: placeholder },
    data: { title: next },
  });
  // Mesmo efeito de `invalidateBoardsForPipelines` (services/deals): o card
  // do board mostra o título.
  const pipelineIds = new Set(deals.map((d) => d.stage?.pipelineId).filter(Boolean) as string[]);
  await Promise.all(
    [...pipelineIds].map((id) => invalidateBoardData(organizationId, id).catch(() => {})),
  );
  return res.count;
}

async function activeWebchatConversation(contactId: string, channelId: string) {
  return prisma.conversation.findFirst({
    where: {
      contactId,
      channel: WEBCHAT_CONVERSATION_CHANNEL,
      channelId,
      status: { not: "RESOLVED" },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, unreadCount: true },
  });
}

export async function identifyWebchatVisitor(args: {
  organizationId: string;
  session: WebchatSessionRow;
  identity: WebchatIdentity;
}): Promise<IdentifyResult> {
  const { organizationId, session, identity } = args;
  if (!hasIdentity(identity)) {
    throw new WebchatIdentifyError("Informe nome, e-mail ou telefone.");
  }

  const anonId = session.contactId;
  const match =
    identity.email || identity.phone ? await findMatchingContact(identity, anonId) : null;

  // ── Sem contato correspondente: o do visitante recebe os dados ──────
  if (!match) {
    if (!anonId) {
      const created = await ensureVisitorContact(session, identity);
      publishContactUpdated({ organizationId, contactId: created.id, reason: "webchat_identified" });
      return { contactId: created.id, merged: false, matchedBy: null };
    }
    const data: Record<string, string> = {};
    if (identity.name) data.name = identity.name;
    if (identity.email) data.email = identity.email;
    if (identity.phone) data.phone = identity.phone;
    await prisma.contact.update({ where: { id: anonId }, data });
    if (identity.name) await renameAnonymousVisitorDeals(organizationId, anonId, session.id, identity.name);
    publishContactUpdated({ organizationId, contactId: anonId, reason: "webchat_identified" });
    const conv = await activeWebchatConversation(anonId, session.channelId);
    if (conv) {
      publishConversationUpdated({ organizationId, conversationId: conv.id, contactId: anonId });
    }
    return { contactId: anonId, merged: false, matchedBy: null };
  }

  const keep = match.contact;

  // ── Visitante ainda sem contato: liga direto no existente ───────────
  if (!anonId) {
    await prisma.$transaction(async (tx) => {
      await tx.webchatSession.update({ where: { id: session.id }, data: { contactId: keep.id } });
      await tx.contact.update({
        where: { id: keep.id },
        data: {
          ...fillEmpty(keep, identity),
          ...(keep.webchatVisitorId ? {} : { webchatVisitorId: session.id }),
        },
      });
    });
    session.contactId = keep.id;
    publishContactUpdated({ organizationId, contactId: keep.id, reason: "webchat_identified" });
    return { contactId: keep.id, merged: true, matchedBy: match.by };
  }

  // ── Visitante anônimo com contato próprio: funde no existente ───────
  const anonConv = await activeWebchatConversation(anonId, session.channelId);
  const keepConv = await activeWebchatConversation(keep.id, session.channelId);
  let survivingConvId: string | null = keepConv?.id ?? anonConv?.id ?? null;

  if (anonConv && keepConv) {
    // Um ticket ativo por contato+canal: as mensagens do anônimo entram no
    // ticket que já existia e o do anônimo é encerrado vazio.
    await prisma.$transaction(async (tx) => {
      await tx.message.updateMany({
        where: { conversationId: anonConv.id },
        data: { conversationId: keepConv.id },
      });
      await tx.conversation.update({
        where: { id: keepConv.id },
        data: {
          unreadCount: { increment: anonConv.unreadCount },
          lastMessageDirection: "in",
          hasAgentReply: false,
          updatedAt: new Date(),
        },
      });
      await tx.conversation.update({
        where: { id: anonConv.id },
        data: { status: "RESOLVED", closedAt: new Date(), unreadCount: 0 },
      });
    });
    void noteMessageChange(organizationId, anonConv.id, "del");
    void noteMessageChange(organizationId, keepConv.id, "new");
    publishConversationUpdated({
      organizationId,
      conversationId: anonConv.id,
      contactId: keep.id,
      status: "RESOLVED",
      closedAt: new Date().toISOString(),
      unreadCount: 0,
    });
    survivingConvId = keepConv.id;
  } else if (anonConv) {
    await linkContactToConversation(anonConv.id, keep.id);
  }

  // Sessões do widget do anônimo → existente (senão a cascata do delete
  // derrubaria o visitante), e libera o `webchatVisitorId` do unique.
  await prisma.$transaction(async (tx) => {
    await tx.webchatSession.updateMany({ where: { contactId: anonId }, data: { contactId: keep.id } });
    await tx.contact.update({ where: { id: anonId }, data: { webchatVisitorId: null } });
  });

  const merged = await mergeContacts(keep.id, anonId);
  if (!merged.ok) {
    log.warn({ error: merged.error, keepId: keep.id, anonId }, "merge do visitante falhou");
    throw new Error("Não foi possível unir o contato do visitante.");
  }

  await prisma.contact.update({
    where: { id: keep.id },
    data: {
      ...fillEmpty(keep, identity),
      ...(keep.webchatVisitorId ? {} : { webchatVisitorId: session.id }),
    },
  });
  session.contactId = keep.id;
  // O deal do anônimo veio junto no merge: ganha o nome do contato que ficou.
  await renameAnonymousVisitorDeals(organizationId, keep.id, session.id, keep.name);

  publishContactUpdated({ organizationId, contactId: keep.id, reason: "webchat_identified" });
  if (survivingConvId) {
    publishConversationUpdated({ organizationId, conversationId: survivingConvId, contactId: keep.id });
  }
  return { contactId: keep.id, merged: true, matchedBy: match.by };
}
