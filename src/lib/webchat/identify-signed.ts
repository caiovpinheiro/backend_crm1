/**
 * Webchat v2 — identify ASSINADO pelo site (docs/decisoes/webchat-widget.md §9.4).
 *
 * O site logado chama `BwipoWebchat.identify({ externalId, userHash, ... })`
 * com `userHash = hex(HMAC-SHA256(segredo de identidade do canal, externalId))`
 * calculado no servidor dele. Só com a assinatura válida a sessão passa a
 * apontar para o contato da org com esse `externalId` (campo de match do
 * canal) — é a prova de posse que o identify v1 (dados digitados) não tem.
 *
 *  - válida: contato pelo campo de match (ou o do próprio visitante recebe a
 *    identidade, criado se preciso); o contato anônimo do visitante é
 *    fundido no identificado; a sessão grava `identityVerifiedAt`; o
 *    contexto/eventos anônimos passam para o contato; `name/email/phone`
 *    só preenchem campos vazios; `attributes` → campos personalizados pelo
 *    `attributeMap` do canal (sem mapeamento = ignorado).
 *  - inválida/ausente/canal sem segredo: nada disso — quem chama segue a
 *    regra v1 (identify.ts), que nunca liga nem funde.
 *
 * Logs sem dado pessoal (nada de externalId, e-mail, telefone ou segredo).
 * Roda dentro de `withSystemContext(organizationId)`.
 */
import { Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma, type ScopedTx } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { publishContactUpdated, publishConversationUpdated } from "@/lib/realtime-events";
import {
  findContactByWebchatIdentity,
  normalizeWebchatExternalId,
  setContactWebchatIdentity,
} from "@/lib/webchat/contact-match";
import {
  findPossibleDuplicates,
  recordPossibleDuplicateNotice,
} from "@/lib/webchat/duplicate-notice";
import { cleanContextString } from "@/lib/webchat/live-context";
import { verifyWebchatUserHash } from "@/lib/webchat/signatures";
import { adoptAnonymousVisitorData } from "@/lib/webchat/visitor-data";
import { contactTrackingFromSession, type WebchatSessionRow } from "@/lib/webchat/session";
import type { WebchatMatchField, WebchatV2Config } from "@/lib/webchat/v2-config";
import { WEBCHAT_ATTRIBUTE_RE } from "@/lib/webchat/v2-config";
import {
  anonymousVisitorName,
  isAnonymousVisitorName,
  WEBCHAT_CONVERSATION_CHANNEL,
} from "@/lib/webchat/inbound";
import { renameAnonymousVisitorDeals, type WebchatIdentity } from "@/lib/webchat/identify";
import { fireTrigger } from "@/services/automation-triggers";
import { insertContactWithNextNumber, isPrismaUniqueViolation } from "@/services/contacts";
import { mergeContacts } from "@/services/merge-contacts";

const log = getLogger("webchat-identify-signed");

export type WebchatUnverifiedReason =
  | "SIGNATURE_INVALID"
  | "SIGNATURE_MISSING"
  | "IDENTITY_NOT_CONFIGURED";

export type WebchatSignatureCheck =
  | { verified: true; externalId: string }
  | { verified: false; reason: WebchatUnverifiedReason };

/** O corpo traz campos do identify assinado (v2)? Sem eles é um identify v1. */
export function hasSignedIdentifyFields(body: Record<string, unknown>): boolean {
  return body.externalId !== undefined || body.userHash !== undefined;
}

/**
 * Confere a assinatura. Ordem dos motivos: canal sem segredo →
 * `IDENTITY_NOT_CONFIGURED`; sem `userHash` → `SIGNATURE_MISSING`;
 * `externalId` inválido ou HMAC que não confere → `SIGNATURE_INVALID`.
 */
export function checkWebchatSignature(input: {
  identitySecret: string | null;
  externalId: unknown;
  userHash: unknown;
}): WebchatSignatureCheck {
  if (!input.identitySecret) return { verified: false, reason: "IDENTITY_NOT_CONFIGURED" };
  if (typeof input.userHash !== "string" || !input.userHash.trim()) {
    return { verified: false, reason: "SIGNATURE_MISSING" };
  }
  const externalId = normalizeWebchatExternalId(input.externalId);
  if (!externalId) return { verified: false, reason: "SIGNATURE_INVALID" };
  return verifyWebchatUserHash(input.identitySecret, externalId, input.userHash)
    ? { verified: true, externalId }
    : { verified: false, reason: "SIGNATURE_INVALID" };
}

/** Teto de atributos lidos de um identify (o resto é ignorado). */
const MAX_ATTRIBUTES = 100;

/**
 * `attributes` do site → `{ customFieldId, value }` pelo `attributeMap`.
 * Atributo sem mapeamento, nome inválido ou valor não simples → ignorado;
 * `null` também (o identify não apaga campo). Texto limpo e cortado em
 * `maxValueChars`. Função pura.
 */
export function mapWebchatAttributes(
  attributes: unknown,
  config: Pick<WebchatV2Config, "identity" | "context">,
): { customFieldId: string; value: string }[] {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return [];
  const byAttribute = new Map(config.identity.attributeMap.map((m) => [m.attribute, m.customFieldId]));
  const out = new Map<string, string>();
  let seen = 0;
  for (const [name, raw] of Object.entries(attributes as Record<string, unknown>)) {
    if (++seen > MAX_ATTRIBUTES) break;
    if (!WEBCHAT_ATTRIBUTE_RE.test(name)) continue;
    const customFieldId = byAttribute.get(name);
    if (!customFieldId) continue;
    let value: string | null = null;
    if (typeof raw === "string") value = cleanContextString(raw, config.context.maxValueChars);
    else if (typeof raw === "number" && Number.isFinite(raw)) value = String(raw);
    else if (typeof raw === "boolean") value = raw ? "true" : "false";
    if (value) out.set(customFieldId, value);
  }
  return [...out].map(([customFieldId, value]) => ({ customFieldId, value }));
}

/** O contato já guarda alguma identidade do site no campo de match? */
async function hasWebchatIdentity(contactId: string, matchField: WebchatMatchField): Promise<boolean> {
  if (matchField.type === "externalId") {
    const row = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { externalId: true },
    });
    return Boolean(row?.externalId);
  }
  const row = await prisma.contactCustomFieldValue.findFirst({
    where: { contactId, customFieldId: matchField.customFieldId, value: { not: "" } },
    select: { contactId: true },
  });
  return Boolean(row);
}

/**
 * Contato novo para a identidade. `asVisitor`: vira o contato do próprio
 * visitante (`webchatVisitorId`); senão fica sem dono de visitante (o do
 * visitante já é de outra identidade). Corrida no unique de visitante →
 * cria sem dono.
 */
async function createIdentifiedContact(
  session: WebchatSessionRow,
  identity: WebchatIdentity,
  asVisitor: boolean,
): Promise<string> {
  const data = {
    name: identity.name || anonymousVisitorName(session.id),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.phone ? { phone: identity.phone } : {}),
    lifecycleStage: "LEAD",
    source: "Webchat",
    ...contactTrackingFromSession(session),
  };
  type Input = Omit<Prisma.ContactUncheckedCreateInput, "number" | "organizationId">;
  let created: { id: string };
  try {
    created = (await insertContactWithNextNumber(
      (asVisitor ? { ...data, webchatVisitorId: session.id } : data) as Input,
      { id: true },
    )) as { id: string };
  } catch (err) {
    if (!asVisitor || !isPrismaUniqueViolation(err)) throw err;
    created = (await insertContactWithNextNumber(data as Input, { id: true })) as { id: string };
  }
  fireTrigger("contact_created", {
    contactId: created.id,
    data: { source: "Webchat", channel: "Webchat" },
  }).catch((err) => log.warn({ err }, "Falha no gatilho contact_created"));
  return created.id;
}

/**
 * Resolve o contato da identidade: o da org com esse `externalId`; senão o
 * do próprio visitante (anônimo) recebe a identidade; senão um novo.
 * Devolve também o contato anônimo a fundir (se houver).
 */
async function resolveIdentifiedContact(
  session: WebchatSessionRow,
  matchField: WebchatMatchField,
  externalId: string,
  identity: WebchatIdentity,
): Promise<{ contactId: string; mergeFrom: string | null }> {
  const own = await prisma.contact.findFirst({
    where: { webchatVisitorId: session.id },
    select: { id: true },
  });
  const ownIsAnonymous = own ? !(await hasWebchatIdentity(own.id, matchField)) : false;

  const found = await findContactByWebchatIdentity(matchField, externalId);
  if (found) {
    // O contato anônimo do visitante vira o identificado. Um contato próprio
    // que já é de OUTRA identidade (outro login no mesmo navegador) fica.
    const mergeFrom = own && own.id !== found.id && ownIsAnonymous ? own.id : null;
    return { contactId: found.id, mergeFrom };
  }

  // `targetIsOwn`: o alvo é o contato anônimo do próprio visitante.
  let targetId: string;
  let targetIsOwn = true;
  if (own && ownIsAnonymous) targetId = own.id;
  else if (!own) targetId = await createIdentifiedContact(session, identity, true);
  else {
    targetId = await createIdentifiedContact(session, identity, false);
    targetIsOwn = false;
  }

  const res = await setContactWebchatIdentity(targetId, matchField, externalId);
  if (res === "taken") {
    // Corrida: outro request gravou a mesma identidade agora — fica o dele.
    const won = await findContactByWebchatIdentity(matchField, externalId);
    if (won && won.id !== targetId) {
      return { contactId: won.id, mergeFrom: targetIsOwn ? targetId : null };
    }
  } else if (res === "field_missing") {
    log.warn({ channelId: session.channelId }, "campo de match do webchat não existe na org");
  }
  return { contactId: targetId, mergeFrom: null };
}

/** Grava os atributos mapeados (campo inexistente/de outra entidade: ignorado). */
async function writeMappedAttributes(
  contactId: string,
  values: { customFieldId: string; value: string }[],
): Promise<number> {
  if (values.length === 0) return 0;
  const fields = await prisma.customField.findMany({
    where: { id: { in: values.map((v) => v.customFieldId) }, entity: "contact" },
    select: { id: true },
  });
  const valid = new Set(fields.map((f) => f.id));
  let written = 0;
  for (const v of values) {
    if (!valid.has(v.customFieldId)) continue;
    await prisma.contactCustomFieldValue.upsert({
      where: { contactId_customFieldId: { contactId, customFieldId: v.customFieldId } },
      create: withOrgFromCtx({ contactId, customFieldId: v.customFieldId, value: v.value }),
      update: { value: v.value },
    });
    written++;
  }
  return written;
}

/** `name/email/phone` só preenchem vazio (nome também quando é o placeholder). */
async function fillEmptyContactFields(
  organizationId: string,
  contactId: string,
  session: WebchatSessionRow,
  identity: WebchatIdentity,
): Promise<{ email: string | null; phone: string | null }> {
  const row = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { name: true, email: true, phone: true },
  });
  if (!row) return { email: null, phone: null };
  const data: Record<string, string> = {};
  if (identity.name && (!row.name?.trim() || isAnonymousVisitorName(row.name))) data.name = identity.name;
  if (identity.email && !row.email) data.email = identity.email;
  if (identity.phone && !row.phone) data.phone = identity.phone;
  if (Object.keys(data).length > 0) {
    await prisma.contact.update({ where: { id: contactId }, data });
  }
  if (data.name) {
    await renameAnonymousVisitorDeals(organizationId, contactId, session.id, data.name);
  }
  return { email: data.email ?? null, phone: data.phone ?? null };
}

export type SignedIdentifyResult = {
  contactId: string;
  /** Contato anônimo do visitante fundido no identificado. */
  merged: boolean;
  attributesWritten: number;
};

export async function identifySignedWebchatVisitor(args: {
  organizationId: string;
  session: WebchatSessionRow;
  config: WebchatV2Config;
  externalId: string;
  identity: WebchatIdentity;
  attributes: unknown;
  now?: Date;
}): Promise<SignedIdentifyResult> {
  const { organizationId, session, config, externalId, identity } = args;
  const matchField = config.identity.matchField;

  const { contactId, mergeFrom } = await resolveIdentifiedContact(
    session,
    matchField,
    externalId,
    identity,
  );

  let merged = false;
  if (mergeFrom && mergeFrom !== contactId) {
    try {
      const res = await mergeContacts(contactId, mergeFrom);
      merged = res.ok;
    } catch (err) {
      // Ex.: os dois com ticket webchat ativo no mesmo canal (unique). O
      // anônimo fica como está; a sessão segue para o identificado.
      log.warn({ err, channelId: session.channelId }, "merge do visitante no identificado falhou");
    }
  }

  await prisma.$transaction(async (tx: ScopedTx) => {
    await tx.webchatSession.update({
      where: { id: session.id },
      data: { contactId, identityVerifiedAt: args.now ?? new Date() },
    });
    await adoptAnonymousVisitorData(tx, { sessionId: session.id, contactId });
  });
  session.contactId = contactId;

  const written = await fillEmptyContactFields(organizationId, contactId, session, identity);
  const attributesWritten = await writeMappedAttributes(
    contactId,
    mapWebchatAttributes(args.attributes, config),
  );
  publishContactUpdated({ organizationId, contactId, reason: "webchat_identified" });

  const conv = await prisma.conversation.findFirst({
    where: {
      contactId,
      channel: WEBCHAT_CONVERSATION_CHANNEL,
      channelId: session.channelId,
      status: { not: "RESOLVED" },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (conv) {
    if (written.email || written.phone) {
      try {
        const matches = await findPossibleDuplicates(contactId, written);
        if (matches.length > 0) {
          await recordPossibleDuplicateNotice({ organizationId, conversationId: conv.id, contactId, matches });
        }
      } catch (err) {
        log.warn({ err, conversationId: conv.id }, "nota de possível duplicado falhou");
      }
    }
    publishConversationUpdated({ organizationId, conversationId: conv.id, contactId });
  }
  return { contactId, merged, attributesWritten };
}
