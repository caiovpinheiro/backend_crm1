/**
 * Solta a conversa da IA no handoff — sem regravar o que já está gravado.
 *
 * O handoff (genérico e acadêmico) fazia `conversation.update` com
 * `updatedAt = now` em TODA chamada. A varredura de segurança
 * (`stuck-inbound`) chama o handoff de minuto em minuto: conversa que já
 * estava sem responsável e no mesmo departamento era regravada a cada
 * rodada. `updatedAt` ordena Inbox e Kanban e está em vários índices —
 * cada gravação à toa vira linha morta e fila embaralhada.
 *
 * Aqui só grava quando o responsável ou o departamento mudam de fato.
 */

import { prisma } from "@/lib/prisma";

export async function releaseConversationForHandoff(args: {
  conversationId: string;
  /** `null` = handoff sem departamento resolvido: mantém o que a conversa tem. */
  departmentId: string | null;
}): Promise<{ changed: boolean }> {
  const current = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: { assignedToId: true, departmentId: true },
  });

  const departmentChanges =
    args.departmentId !== null && current?.departmentId !== args.departmentId;
  // `current` nulo (conversa apagada): segue para o update, que falha como
  // sempre falhou — o chamador trata.
  if (current && current.assignedToId === null && !departmentChanges) {
    return { changed: false };
  }

  await prisma.conversation.update({
    where: { id: args.conversationId },
    data: {
      ...(args.departmentId !== null ? { departmentId: args.departmentId } : {}),
      // Solta a IA. `aiGreetedAt` fica: zerar reenvia a saudação se o
      // agente reassumir a conversa depois.
      assignedToId: null,
      updatedAt: new Date(),
    },
    select: { id: true },
  });
  return { changed: true };
}
