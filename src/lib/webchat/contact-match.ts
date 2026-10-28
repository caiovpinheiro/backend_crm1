/**
 * Webchat v2 — identidade do site no contato (docs/decisoes/webchat-widget.md
 * §9.4/§9.6). O `externalId` que o site manda (identify assinado ou
 * `external_id` do servidor a servidor) é procurado/gravado no campo que o
 * canal escolheu (`config.v2.identity.matchField`): `Contact.externalId`
 * (padrão) ou um campo personalizado de contato. Roda no contexto de org.
 */
import { Prisma } from "@prisma/client";

import { prisma, type ScopedTx } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import type { WebchatMatchField } from "@/lib/webchat/v2-config";

export const WEBCHAT_EXTERNAL_ID_MAX_CHARS = 128;

/** `externalId` aceito: texto de 1..128 chars sem caracteres de controle. */
export function normalizeWebchatExternalId(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const v = String(raw).trim();
  if (!v || v.length > WEBCHAT_EXTERNAL_ID_MAX_CHARS || /[\u0000-\u001F\u007F]/.test(v)) return null;
  return v;
}

/** Contato da org com esse `externalId` no campo de match (ou `null`). */
export async function findContactByWebchatIdentity(
  matchField: WebchatMatchField,
  externalId: string,
  db: ScopedTx = prisma,
): Promise<{ id: string } | null> {
  if (matchField.type === "externalId") {
    return db.contact.findFirst({ where: { externalId }, select: { id: true } });
  }
  const row = await db.contactCustomFieldValue.findFirst({
    where: { customFieldId: matchField.customFieldId, value: externalId },
    select: { contactId: true },
    orderBy: { id: "asc" },
  });
  return row ? { id: row.contactId } : null;
}

export type SetWebchatIdentityResult = "ok" | "taken" | "field_missing";

/**
 * Grava o `externalId` no contato, no campo de match. `taken` = outro
 * contato da org já tem esse `Contact.externalId` (unique); `field_missing`
 * = o campo personalizado configurado não existe (ou não é de contato).
 */
export async function setContactWebchatIdentity(
  contactId: string,
  matchField: WebchatMatchField,
  externalId: string,
  db: ScopedTx = prisma,
): Promise<SetWebchatIdentityResult> {
  if (matchField.type === "externalId") {
    try {
      await db.contact.update({ where: { id: contactId }, data: { externalId } });
      return "ok";
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "taken";
      throw err;
    }
  }
  const field = await db.customField.findFirst({
    where: { id: matchField.customFieldId, entity: "contact" },
    select: { id: true },
  });
  if (!field) return "field_missing";
  await db.contactCustomFieldValue.upsert({
    where: { contactId_customFieldId: { contactId, customFieldId: field.id } },
    create: withOrgFromCtx({ contactId, customFieldId: field.id, value: externalId }),
    update: { value: externalId },
  });
  return "ok";
}
