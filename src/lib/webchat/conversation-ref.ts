/**
 * Webchat v2 — `ref` da conversa (docs/decisoes/webchat-widget.md §9.2/§9.6):
 * identificador do lado do site que chega pelo `open({ ref })` do widget ou
 * pelo servidor a servidor. Fica como metadado da conversa
 * (`webchat_conversation_refs`) e, se o canal mandar
 * (`config.v2.refDealCustomFieldId`), é copiado para o campo personalizado
 * do negócio aberto mais recente do contato. Roda no contexto de org.
 */
import { prisma, type ScopedTx } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

export const WEBCHAT_REF_MAX_CHARS = 128;
export const WEBCHAT_REF_SOURCES = ["widget", "s2s"] as const;
export type WebchatRefSource = (typeof WEBCHAT_REF_SOURCES)[number];

/** `ref` aceito: texto de 1..128 chars sem caracteres de controle. */
export function normalizeWebchatRef(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const v = String(raw).trim();
  if (!v || v.length > WEBCHAT_REF_MAX_CHARS || /[\u0000-\u001F\u007F]/.test(v)) return null;
  return v;
}

/**
 * Registra (ou atualiza) o `ref` na conversa. `category`/`priority` só
 * sobrescrevem quando vierem. Devolve se a linha é nova.
 */
export async function recordWebchatConversationRef(
  input: {
    conversationId: string;
    contactId: string;
    ref: string;
    source: WebchatRefSource;
    category?: string | null;
    priority?: string | null;
    /** `config.v2.refDealCustomFieldId` do canal. */
    refDealCustomFieldId: string | null;
  },
  db: ScopedTx = prisma,
): Promise<{ id: string; created: boolean }> {
  const where = { conversationId_ref: { conversationId: input.conversationId, ref: input.ref } };
  const existing = await db.webchatConversationRef.findUnique({ where, select: { id: true } });
  const extra = {
    ...(input.category ? { category: input.category } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
  };
  const row = await db.webchatConversationRef.upsert({
    where,
    create: withOrgFromCtx({
      conversationId: input.conversationId,
      ref: input.ref,
      source: input.source,
      ...extra,
    }),
    update: extra,
    select: { id: true },
  });
  if (input.refDealCustomFieldId) {
    await copyRefToDeal(db, input.contactId, input.refDealCustomFieldId, input.ref);
  }
  return { id: row.id, created: !existing };
}

async function copyRefToDeal(
  db: ScopedTx,
  contactId: string,
  customFieldId: string,
  ref: string,
): Promise<void> {
  const field = await db.customField.findFirst({
    where: { id: customFieldId, entity: "deal" },
    select: { id: true },
  });
  if (!field) return;
  const deal = await db.deal.findFirst({
    where: { contactId, status: "OPEN" },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!deal) return;
  await db.dealCustomFieldValue.upsert({
    where: { dealId_customFieldId: { dealId: deal.id, customFieldId: field.id } },
    create: withOrgFromCtx({ dealId: deal.id, customFieldId: field.id, value: ref }),
    update: { value: ref },
  });
}
