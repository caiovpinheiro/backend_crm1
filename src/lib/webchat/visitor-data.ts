/**
 * Webchat v2 — dados do visitante (contexto vivo + timeline) mudando de dono
 * (docs/decisoes/webchat-widget.md §9.8):
 *
 *  - `adoptAnonymousVisitorData`: no identify, o que o visitante anônimo
 *    mandou (linha por `sessionId`) passa para o contato;
 *  - `mergeContactVisitorData`: no merge de contatos, o do removido passa
 *    para o que fica (chamado dentro da transação de `mergeContacts`).
 *
 * Em chave repetida do contexto vence o estado mais recente. Sempre dentro
 * de uma transação do chamador (`tx`).
 */
import { Prisma } from "@prisma/client";

import type { ScopedTx } from "@/lib/prisma";
import { mergeContextStates, readContextState } from "@/lib/webchat/live-context";

type Row = { id: string; state: Prisma.JsonValue; updatedAt: Date };

async function mergeInto(tx: ScopedTx, target: Row, source: Row): Promise<void> {
  const merged = mergeContextStates(
    { state: readContextState(target.state), updatedAt: target.updatedAt },
    { state: readContextState(source.state), updatedAt: source.updatedAt },
  );
  await tx.webchatLiveContext.delete({ where: { id: source.id } });
  await tx.webchatLiveContext.update({
    where: { id: target.id },
    data: { state: merged.state as Prisma.InputJsonValue, updatedAt: merged.updatedAt },
  });
}

const ROW_SELECT = { id: true, channelId: true, state: true, updatedAt: true } as const;

/** Visitante anônimo (`sessionId`) identificado como `contactId`. */
export async function adoptAnonymousVisitorData(
  tx: ScopedTx,
  input: { sessionId: string; contactId: string },
): Promise<void> {
  await tx.webchatEvent.updateMany({
    where: { sessionId: input.sessionId, contactId: null },
    data: { contactId: input.contactId, sessionId: null },
  });
  const anon = await tx.webchatLiveContext.findFirst({
    where: { sessionId: input.sessionId },
    select: ROW_SELECT,
  });
  if (!anon) return;
  const target = await tx.webchatLiveContext.findFirst({
    where: { channelId: anon.channelId, contactId: input.contactId },
    select: ROW_SELECT,
  });
  if (!target) {
    await tx.webchatLiveContext.update({
      where: { id: anon.id },
      data: { contactId: input.contactId, sessionId: null },
    });
    return;
  }
  await mergeInto(tx, target, anon);
}

/** Merge de contatos: o que era de `removeId` passa para `keepId`. */
export async function mergeContactVisitorData(
  tx: ScopedTx,
  keepId: string,
  removeId: string,
): Promise<void> {
  await tx.webchatEvent.updateMany({ where: { contactId: removeId }, data: { contactId: keepId } });
  const rows = await tx.webchatLiveContext.findMany({
    where: { contactId: removeId },
    select: ROW_SELECT,
  });
  for (const row of rows) {
    const target = await tx.webchatLiveContext.findFirst({
      where: { channelId: row.channelId, contactId: keepId },
      select: ROW_SELECT,
    });
    if (!target) {
      await tx.webchatLiveContext.update({ where: { id: row.id }, data: { contactId: keepId } });
    } else {
      await mergeInto(tx, target, row);
    }
  }
}
