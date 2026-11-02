/**
 * Webchat — identidade por campo personalizado de NEGÓCIO
 * (docs/decisoes/webchat-widget.md §9.12).
 *
 * O contato é a pessoa com telefone e o identificador do site fica num campo
 * do negócio. Com identify assinado ou S2S, o visitante cai no contato e no
 * negócio que têm esse valor, sem duplicar. Sem assinatura válida, nada aqui
 * é chamado.
 *
 * `webchat_identity_links` guarda o valor verificado de cada contato por
 * canal. O widget filtra mensagens por contato e canal, então um contato não
 * pode responder por dois valores: se o telefone é compartilhado, o segundo
 * valor ganha contato próprio.
 *
 * Logs sem dado pessoal: nunca o valor. Roda no contexto de org.
 */
import { Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma, type ScopedTx } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { createWebchatSiteNote } from "@/lib/webchat/conversation-notes";
import { WEBCHAT_NOTICE_SENDER } from "@/lib/webchat/duplicate-notice";
import type { WebchatMatchField } from "@/lib/webchat/v2-config";

const log = getLogger("webchat-deal-identity");

export type DealMatchField = Extract<WebchatMatchField, { type: "dealCustomField" }>;

/** Teto de negócios lidos para um valor (ambiguidade é exceção, não regra). */
const MAX_DEALS_PER_VALUE = 50;

/** Valor comparável. `digits` sem nenhum dígito não identifica ninguém. */
export function normalizeDealIdentityValue(value: string, field: DealMatchField): string | null {
  const v = field.normalize === "digits" ? value.replace(/\D/g, "") : value.trim();
  return v.length > 0 ? v : null;
}

export type DealIdentityCandidate = {
  id: string;
  contactId: string | null;
  status: string;
  updatedAt: Date;
};

/**
 * Qual negócio responde pelo valor: o aberto mais recente; sem aberto, o mais
 * recente. Negócio com contato vem antes do sem contato; com `preferContactId`,
 * os desse contato vêm antes (contato com vários negócios). Pura.
 */
export function pickIdentityDeal(
  candidates: readonly DealIdentityCandidate[],
  preferContactId?: string | null,
): DealIdentityCandidate | null {
  let pool: readonly DealIdentityCandidate[] = candidates;
  const narrow = (test: (d: DealIdentityCandidate) => boolean) => {
    const hits = pool.filter(test);
    if (hits.length > 0) pool = hits;
  };
  if (preferContactId) narrow((d) => d.contactId === preferContactId);
  narrow((d) => d.contactId !== null);
  narrow((d) => d.status === "OPEN");
  return [...pool].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
}

/**
 * Negócios da org com o valor no campo. SQL cru pelo índice parcial
 * `deal_custom_field_values_field_value_idx`, que o `where` do Prisma não
 * alcança; por isso a org é explícita. `digits` percorre os valores do campo
 * no índice, para achar também o valor gravado com pontuação.
 */
export async function findDealsByIdentityValue(
  field: DealMatchField,
  value: string,
): Promise<DealIdentityCandidate[]> {
  const orgId = getOrgIdOrThrow();
  const match =
    field.normalize === "digits"
      ? Prisma.sql`regexp_replace(v."value", '\\D', '', 'g') = ${value}`
      : Prisma.sql`v."value" = ${value}`;
  const rows = await prisma.$queryRaw<
    { id: string; contactId: string | null; status: string; updatedAt: Date }[]
  >(Prisma.sql`
    SELECT d.id, d."contactId", d.status::text AS status, d."updatedAt"
    FROM deal_custom_field_values v
    JOIN deals d ON d.id = v."dealId" AND d."organizationId" = ${orgId}
    WHERE v."organizationId" = ${orgId}
      AND v."customFieldId" = ${field.customFieldId}
      AND length(v."value") <= 128
      AND ${match}
    ORDER BY d."updatedAt" DESC
    LIMIT ${MAX_DEALS_PER_VALUE}
  `);
  return rows;
}

export type DealIdentityResolution =
  /** Contato definido: pelo valor já ligado ou pelo negócio encontrado. */
  | { kind: "contact"; contactId: string; dealId: string | null; linked: boolean; orphanDealId: string | null }
  /** Negócio sem contato: quem chama define o contato e o negócio é ligado a ele. */
  | { kind: "orphan_deal"; dealId: string }
  /** O contato do negócio já responde por outro valor (telefone compartilhado). */
  | { kind: "conflict"; dealId: string }
  | { kind: "not_found" };

/** Resolve sem gravar nada. */
export async function resolveDealIdentity(
  channelId: string,
  field: DealMatchField,
  value: string,
): Promise<DealIdentityResolution> {
  const link = await prisma.webchatIdentityLink.findFirst({
    where: { channelId, value },
    select: { contactId: true, dealId: true },
  });
  const candidates = await findDealsByIdentityValue(field, value);
  if (candidates.length > 1) {
    log.warn(
      { channelId, customFieldId: field.customFieldId, deals: candidates.length },
      "mesmo valor em mais de um negócio: usando o aberto mais recente",
    );
  }
  const deal = pickIdentityDeal(candidates, link?.contactId);

  if (link) {
    const orphan = deal && deal.contactId === null;
    if (orphan) log.warn({ channelId, dealId: deal.id }, "negócio do valor sem contato");
    return {
      kind: "contact",
      contactId: link.contactId,
      dealId: deal?.id ?? link.dealId,
      linked: true,
      orphanDealId: orphan ? deal.id : null,
    };
  }
  if (!deal) return { kind: "not_found" };
  if (!deal.contactId) {
    log.warn({ channelId, dealId: deal.id }, "negócio do valor sem contato");
    return { kind: "orphan_deal", dealId: deal.id };
  }
  const taken = await prisma.webchatIdentityLink.findFirst({
    where: { channelId, contactId: deal.contactId },
    select: { id: true },
  });
  if (taken) return { kind: "conflict", dealId: deal.id };
  return { kind: "contact", contactId: deal.contactId, dealId: deal.id, linked: false, orphanDealId: null };
}

/** Grava o vínculo. `false`: perdeu a disputa num dos uniques; resolva de novo. */
export async function claimDealIdentity(args: {
  channelId: string;
  contactId: string;
  value: string;
  dealId: string | null;
}): Promise<boolean> {
  try {
    await prisma.webchatIdentityLink.create({
      data: withOrgFromCtx({
        channelId: args.channelId,
        contactId: args.contactId,
        value: args.value,
        dealId: args.dealId,
      }),
      select: { id: true },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

/** Atualiza o negócio de um vínculo que já existe. */
export async function setDealIdentityLinkDeal(
  channelId: string,
  value: string,
  dealId: string,
): Promise<void> {
  await prisma.webchatIdentityLink.updateMany({
    where: { channelId, value, NOT: { dealId } },
    data: { dealId },
  });
}

/** Liga o negócio sem contato ao contato do visitante. Nunca tira de outro. */
export async function adoptOrphanDeal(dealId: string, contactId: string): Promise<void> {
  const res = await prisma.deal.updateMany({
    where: { id: dealId, contactId: null },
    data: { contactId },
  });
  if (res.count > 0) log.warn({ dealId, contactId }, "negócio sem contato ligado ao contato do visitante");
}

/** Vínculo do contato no canal (ou `null`). */
export async function findDealIdentityLink(
  channelId: string,
  contactId: string,
): Promise<{ value: string; dealId: string | null } | null> {
  return prisma.webchatIdentityLink.findFirst({
    where: { channelId, contactId },
    select: { value: true, dealId: true },
  });
}

/**
 * Grava o valor no campo do negócio, para reconhecê-lo depois. Só preenche
 * vazio: valor que já existe no negócio não é trocado.
 */
export async function writeIdentityValueToDeal(
  field: DealMatchField,
  dealId: string,
  value: string,
  db: ScopedTx = prisma,
): Promise<boolean> {
  const where = { dealId_customFieldId: { dealId, customFieldId: field.customFieldId } };
  const current = await db.dealCustomFieldValue.findUnique({ where, select: { value: true } });
  if (current?.value.trim()) return false;
  await db.dealCustomFieldValue.upsert({
    where,
    create: withOrgFromCtx({ dealId, customFieldId: field.customFieldId, value }),
    update: { value },
  });
  return true;
}

/**
 * Negócio do contato sem valor reconhecido (o automático, ou o que já estava
 * aberto): recebe o valor, e o vínculo passa a apontar para ele.
 */
export async function attachIdentityValueToContactDeal(args: {
  channelId: string;
  contactId: string;
  field: DealMatchField;
  value: string;
  dealId: string;
}): Promise<void> {
  const deal = await prisma.deal.findFirst({
    where: { id: args.dealId, contactId: args.contactId },
    select: { id: true },
  });
  if (!deal) return;
  if (await writeIdentityValueToDeal(args.field, deal.id, args.value)) {
    await setDealIdentityLinkDeal(args.channelId, args.value, deal.id);
  }
}

/** O aberto mais recente do contato, para receber o valor ainda não reconhecido. */
export async function findOpenDealOfContact(contactId: string): Promise<{ id: string } | null> {
  return prisma.deal.findFirst({
    where: { contactId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
}

/** Referência legível do negócio para a nota interna. */
export async function dealNoteLabel(dealId: string): Promise<string | null> {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId },
    select: { number: true, title: true },
  });
  if (!deal) return null;
  const ref = deal.number > 0 ? `#${deal.number}` : `id ${dealId}`;
  return deal.title?.trim() ? `Negócio ${ref} (${deal.title.trim()})` : `Negócio ${ref}`;
}

/** Texto da nota de possível vínculo. Pura. */
export function separatedIdentityNoteText(args: {
  dealLabel: string;
  ownerName: string;
  ownerNumber: number | null;
}): string {
  const ref = args.ownerNumber != null ? ` (#${args.ownerNumber})` : "";
  return (
    `O site confirmou a identidade deste visitante, que corresponde ao ${args.dealLabel}, ` +
    `do contato ${args.ownerName}${ref} — possível vínculo. Esse contato já responde por outro ` +
    "identificador neste canal, então este visitante ficou em um contato próprio, para que um " +
    "não veja as mensagens do outro. Nada foi unido automaticamente."
  );
}

/**
 * Nota interna quando o visitante ficou separado do contato do negócio. Uma
 * vez por ticket. Nunca lança.
 */
export async function noteSeparatedIdentity(args: {
  organizationId: string;
  channelId: string;
  conversationId: string;
  contactId: string;
}): Promise<void> {
  try {
    const link = await findDealIdentityLink(args.channelId, args.contactId);
    if (!link?.dealId) return;
    const deal = await prisma.deal.findFirst({
      where: { id: link.dealId },
      select: { contactId: true, contact: { select: { name: true, number: true } } },
    });
    if (!deal?.contact || deal.contactId === args.contactId) return;
    const dealLabel = await dealNoteLabel(link.dealId);
    if (!dealLabel) return;
    const content = separatedIdentityNoteText({
      dealLabel,
      ownerName: deal.contact.name,
      ownerNumber: deal.contact.number > 0 ? deal.contact.number : null,
    });
    const already = await prisma.message.findFirst({
      where: {
        conversationId: args.conversationId,
        messageType: "note",
        isPrivate: true,
        senderName: WEBCHAT_NOTICE_SENDER,
        content,
      },
      select: { id: true },
    });
    if (already) return;
    await createWebchatSiteNote({
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      content,
      senderName: WEBCHAT_NOTICE_SENDER,
    });
  } catch (err) {
    log.warn({ err, conversationId: args.conversationId }, "nota de possível vínculo falhou");
  }
}
