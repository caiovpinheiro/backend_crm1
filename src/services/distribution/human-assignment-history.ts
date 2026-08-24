/**
 * Histórico de atribuição humana DENTRO de um ticket.
 *
 * O 1º atendimento da IA pode soltar um responsável humano "herdado" (que
 * veio do contato ou de um ticket antigo) para não bloquear o agente
 * acadêmico. Só que quem entrou NESTE ticket por distribuição/transferência
 * não é herança: soltá-lo devolve o aluno para a fila logo depois de o
 * consultor assumir (caso Ana Laura, 24/ago/26 — Larissa recebeu 16:08,
 * saudação automática 16:10, aluna respondeu 16:13 e o ticket ficou sem
 * responsável).
 *
 * `hasHumanReply` não serve de critério aqui: a saudação pós-distribuição
 * (`lead_distributed`) é enviada pela automação e, com `sendAs` no padrão
 * "bot", NÃO marca `hasHumanReply` — ver `resolveOutboundAuthor` em
 * `automation-executor.ts`. Por isso olhamos o ActivityEvent da conversa.
 */

import { prisma } from "@/lib/prisma";

/** Eventos que registram "fulano passou a ser responsável DESTA conversa". */
const ASSIGNMENT_EVENT_TYPES = ["LEAD_DISTRIBUTED", "ASSIGNEE_CHANGED"];

/** Um ticket não acumula dezenas de trocas de responsável. */
const MAX_EVENTS = 50;

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function readId(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * `true` quando `userId` foi atribuído a ESTA conversa — por distribuição
 * (`LEAD_DISTRIBUTED`, meta.selectedUserId, ver `emitDistributionEvent`)
 * ou por atribuição/transferência manual (`ASSIGNEE_CHANGED`, meta.toUserId,
 * ver `api/conversations/[id]/actions`).
 *
 * ActivityEvent tem PK composta `(id, occurredAt)` por causa do
 * particionamento — sempre `findMany`/`findFirst`, nunca `findUnique`.
 */
export async function humanWasAssignedInThisConversation(
  conversationId: string | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!conversationId || !userId) return false;
  try {
    const events = await prisma.activityEvent.findMany({
      where: {
        conversationId,
        type: { in: ASSIGNMENT_EVENT_TYPES },
      },
      orderBy: { occurredAt: "desc" },
      take: MAX_EVENTS,
      select: { meta: true },
    });
    return events.some((ev) => {
      const meta = asRecord(ev.meta);
      return (
        readId(meta, "selectedUserId") === userId ||
        readId(meta, "toUserId") === userId
      );
    });
  } catch (e) {
    // Feed indisponível: conservador — assume que houve atribuição e mantém
    // o consultor. Errar para "não soltar" só atrasa a IA; errar para o
    // outro lado tira o dono do atendimento em produção.
    console.error(
      "[distribution] humanWasAssignedInThisConversation failed",
      e,
    );
    return true;
  }
}
