/**
 * merge-contacts — Funde dois contatos preservando todo o histórico do
 * "primary" e migrando o que dá do "duplicate" antes de removê-lo.
 *
 * Caso de uso real: a Meta às vezes entrega o evento `user_changed_number`
 * tarde demais (depois de já ter caído um inbound do número novo), e o
 * webhook acaba criando dois leads pra mesma pessoa. O operador identifica
 * a duplicata na inbox e dispara o merge — esta função se encarrega de
 * NÃO perder mensagens, deals, notas, atividades, tags e custom fields.
 *
 * Regras:
 *   - O `keepId` é a fonte de verdade. Conflitos de constraint resolvem-se
 *     mantendo o valor do keep e descartando o do remove (ex.: se ambos
 *     têm o mesmo customField preenchido, o do keep prevalece).
 *   - O contato `removeId` é deletado ao final. As relações migradas via
 *     `update` são preservadas; as deletadas pelo `onDelete: Cascade` da
 *     FK do contato (ex.: campaignRecipients sobrepostos) somem junto.
 *   - Tudo roda em uma única transaction — se algo falhar, não fica
 *     contato meio-mesclado.
 */

import { carryContactLastMessage } from "@/lib/conversation-last-message";
import { prisma, type ScopedTx } from "@/lib/prisma";

export type MergeContactsResult = {
  keptId: string;
  removedId: string;
  moved: {
    conversations: number;
    deals: number;
    activities: number;
    notes: number;
    tags: number;
    customFields: number;
    automationContexts: number;
    whatsappCallEvents: number;
    scheduledWhatsappCalls: number;
    campaignRecipients: number;
    phoneChanges: number;
  };
};

export type MergeContactsError =
  | { kind: "same_id" }
  | { kind: "keep_not_found" }
  | { kind: "remove_not_found" };

export async function mergeContacts(
  keepId: string,
  removeId: string,
): Promise<{ ok: true; result: MergeContactsResult } | { ok: false; error: MergeContactsError }> {
  if (keepId === removeId) {
    return { ok: false, error: { kind: "same_id" } };
  }

  const [keep, remove] = await Promise.all([
    prisma.contact.findUnique({ where: { id: keepId }, select: { id: true } }),
    prisma.contact.findUnique({ where: { id: removeId }, select: { id: true } }),
  ]);

  if (!keep) return { ok: false, error: { kind: "keep_not_found" } };
  if (!remove) return { ok: false, error: { kind: "remove_not_found" } };

  const result = await prisma.$transaction(
    async (tx: ScopedTx) => {
      // ── Tags: chave composta (contactId, tagId). Se o keep já tem a
      // mesma tag, descartamos a do remove; senão, repointamos.
      const removeTags = await tx.tagOnContact.findMany({
        where: { contactId: removeId },
        select: { tagId: true },
      });
      let tagsMoved = 0;
      for (const { tagId } of removeTags) {
        const exists = await tx.tagOnContact.findUnique({
          where: { contactId_tagId: { contactId: keepId, tagId } },
          select: { contactId: true },
        });
        if (exists) {
          await tx.tagOnContact.delete({
            where: { contactId_tagId: { contactId: removeId, tagId } },
          });
        } else {
          await tx.tagOnContact.update({
            where: { contactId_tagId: { contactId: removeId, tagId } },
            data: { contactId: keepId },
          });
          tagsMoved++;
        }
      }

      // ── Custom fields: @@unique(contactId, customFieldId). Se o keep
      // já tem valor pra mesma definição, mantém o do keep. Senão, move.
      const removeCustom = await tx.contactCustomFieldValue.findMany({
        where: { contactId: removeId },
        select: { id: true, customFieldId: true },
      });
      let customMoved = 0;
      for (const cf of removeCustom) {
        const exists = await tx.contactCustomFieldValue.findUnique({
          where: {
            contactId_customFieldId: {
              contactId: keepId,
              customFieldId: cf.customFieldId,
            },
          },
          select: { id: true },
        });
        if (exists) {
          await tx.contactCustomFieldValue.delete({ where: { id: cf.id } });
        } else {
          await tx.contactCustomFieldValue.update({
            where: { id: cf.id },
            data: { contactId: keepId },
          });
          customMoved++;
        }
      }

      // ── Campaign recipients: @@unique(campaignId, contactId). Se o
      // keep já está na mesma campanha, mantém o status dele.
      const removeRecipients = await tx.campaignRecipient.findMany({
        where: { contactId: removeId },
        select: { id: true, campaignId: true },
      });
      let recipientsMoved = 0;
      for (const r of removeRecipients) {
        const exists = await tx.campaignRecipient.findUnique({
          where: {
            campaignId_contactId: {
              campaignId: r.campaignId,
              contactId: keepId,
            },
          },
          select: { id: true },
        });
        if (exists) {
          await tx.campaignRecipient.delete({ where: { id: r.id } });
        } else {
          await tx.campaignRecipient.update({
            where: { id: r.id },
            data: { contactId: keepId },
          });
          recipientsMoved++;
        }
      }

      // ── Resto: relações 1:N sem unique composto envolvendo contactId.
      // Para essas basta repointar — Prisma `updateMany` é atômico.
      // Mensagens herdam a migração via Conversation (FK em cascata).
      const conversationsRes = await tx.conversation.updateMany({
        where: { contactId: removeId },
        data: { contactId: keepId },
      });
      // A última mensagem (Kanban) acompanha as conversas.
      await carryContactLastMessage({ fromContactId: removeId, toContactId: keepId, tx });

      const dealsRes = await tx.deal.updateMany({
        where: { contactId: removeId },
        data: { contactId: keepId },
      });

      const activitiesRes = await tx.activity.updateMany({
        where: { contactId: removeId },
        data: { contactId: keepId },
      });

      const notesRes = await tx.note.updateMany({
        where: { contactId: removeId },
        data: { contactId: keepId },
      });

      const automationCtxRes = await tx.automationContext.updateMany({
        where: { contactId: removeId },
        data: { contactId: keepId },
      });

      const callEventsRes = await tx.whatsappCallEvent.updateMany({
        where: { contactId: removeId },
        data: { contactId: keepId },
      });

      const scheduledCallsRes = await tx.scheduledWhatsappCall.updateMany({
        where: { contactId: removeId },
        data: { contactId: keepId },
      });

      const phoneChangesRes = await tx.contactPhoneChange.updateMany({
        where: { contactId: removeId },
        data: { contactId: keepId },
      });

      // Finalmente, descarta o duplicado. Cascades já não vão derrubar
      // mais nada útil porque já reapontamos tudo.
      await tx.contact.delete({ where: { id: removeId } });

      return {
        keptId: keepId,
        removedId: removeId,
        moved: {
          conversations: conversationsRes.count,
          deals: dealsRes.count,
          activities: activitiesRes.count,
          notes: notesRes.count,
          tags: tagsMoved,
          customFields: customMoved,
          automationContexts: automationCtxRes.count,
          whatsappCallEvents: callEventsRes.count,
          scheduledWhatsappCalls: scheduledCallsRes.count,
          campaignRecipients: recipientsMoved,
          phoneChanges: phoneChangesRes.count,
        },
      } satisfies MergeContactsResult;
    },
    {
      // Merge pode envolver muitas linhas (campanhas grandes, históricos
      // longos). 30s dá folga para repointar tudo num só shot sem
      // bloquear chamadas concorrentes do webhook por muito tempo.
      timeout: 30_000,
    },
  );

  return { ok: true, result };
}
