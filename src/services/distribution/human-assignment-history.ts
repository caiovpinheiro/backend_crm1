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
import { getLogger } from "@/lib/logger";

const log = getLogger("distribution.human-assignment-history");

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

function ownerIdFromDealEvent(raw: unknown): string | null {
  const meta = asRecord(raw);
  const direct = readId(meta, "toUserId") ?? readId(meta, "ownerId");
  if (direct) return direct;
  const to = meta.to;
  if (typeof to === "string" && to.trim() !== "") return to;
  if (to && typeof to === "object") return readId(asRecord(to), "id");
  return null;
}

/**
 * `true` quando `userId` foi atribuído a ESTA conversa — por distribuição
 * (`LEAD_DISTRIBUTED`, meta.selectedUserId, ver `emitDistributionEvent`),
 * por atribuição/transferência manual (`ASSIGNEE_CHANGED`, meta.toUserId,
 * ver `api/conversations/[id]/actions`) ou pelo `assign_owner` da
 * automação (`OWNER_CHANGED` no deal do contato, depois que o ticket abriu).
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
    const matchedConversationEvent = events.some((ev) => {
      const meta = asRecord(ev.meta);
      return (
        readId(meta, "selectedUserId") === userId ||
        readId(meta, "toUserId") === userId
      );
    });
    if (matchedConversationEvent) return true;

    // `assign_owner` da automação grava OWNER_CHANGED no deal e propaga
    // o assignee no chat, mas não grava ASSIGNEE_CHANGED na conversa.
    // Sem isso o próximo inbound trata o consultor como herança e solta
    // o dono (DNAWORK #66305: Ketly atribuída, imagem seguinte zerou).
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { contactId: true, createdAt: true },
    });
    if (!conv?.contactId) return false;
    const ownerChanges = await prisma.dealEvent.findMany({
      where: {
        type: "OWNER_CHANGED",
        createdAt: { gte: conv.createdAt },
        deal: { contactId: conv.contactId },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_EVENTS,
      select: { meta: true },
    });
    return ownerChanges.some((ev) => ownerIdFromDealEvent(ev.meta) === userId);
  } catch (e) {
    // Feed indisponível: conservador — assume que houve atribuição e mantém
    // o consultor. Errar para "não soltar" só atrasa a IA; errar para o
    // outro lado tira o dono do atendimento em produção.
    log.error({ err: e }, "[distribution] humanWasAssignedInThisConversation failed");
    return true;
  }
}
