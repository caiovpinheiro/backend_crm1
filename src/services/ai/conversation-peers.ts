/**
 * Quem já atendeu esta conversa no atendimento em curso.
 *
 * O roteamento decide o destino só pela frase do turno
 * (`suggestCoordinatorAiAgent`): o cliente repete "quero cancelar", o escopo
 * casa com o mesmo especialista de novo e a conversa volta para quem já não
 * resolveu. Nada no caminho lembrava que aquele agente já tinha tentado — o
 * único freio era `MAX_AI_HANDOFFS_PER_CONVERSATION`, que corta depois de
 * duas voltas inteiras.
 *
 * O recorte é o mesmo que a busca usa para decidir que o assunto acabou
 * (`RETRIEVAL_SESSION_GAP_MS`): meia hora de silêncio abre um atendimento
 * novo e todo mundo volta a ser destino válido. Sem isso, um contato de meses
 * ficaria sem nenhum especialista elegível para sempre.
 */

import { prisma } from "@/lib/prisma";
import { RETRIEVAL_SESSION_GAP_MS } from "@/services/ai/retrieval-query";

/** Teto de runs lidos: o recorte por silêncio quase sempre corta antes. */
const MAX_RUNS_SCANNED = 40;

export type ConversationPeerHistory = {
  /** `AIAgentConfig.id` de quem já rodou no atendimento em curso. */
  agentIds: Set<string>;
  /** Nome do agente, para o gate que só conhece o destino por nome. */
  agentNames: string[];
};

export const EMPTY_PEER_HISTORY: ConversationPeerHistory = {
  agentIds: new Set(),
  agentNames: [],
};

/**
 * Mesma normalização de `namesFoldEqual` (`agent-handoff.ts`), reescrita aqui
 * porque importar de lá fecharia um ciclo: o handoff é que depende deste
 * módulo.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

export async function loadConversationPeerHistory(
  conversationId?: string | null,
): Promise<ConversationPeerHistory> {
  if (!conversationId) return EMPTY_PEER_HISTORY;

  const runs = await prisma.aIAgentRun.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: MAX_RUNS_SCANNED,
    select: {
      agentId: true,
      createdAt: true,
      agent: { select: { user: { select: { name: true } } } },
    },
  });

  const agentIds = new Set<string>();
  const agentNames: string[] = [];
  let previous: Date | null = null;
  for (const run of runs) {
    // Lista vem do mais novo para o mais antigo: o salto grande é o silêncio
    // que encerrou o atendimento anterior.
    if (previous && previous.getTime() - run.createdAt.getTime() > RETRIEVAL_SESSION_GAP_MS) {
      break;
    }
    previous = run.createdAt;
    agentIds.add(run.agentId);
    const name = run.agent?.user?.name?.trim();
    if (name && !agentNames.some((n) => fold(n) === fold(name))) {
      agentNames.push(name);
    }
  }

  return { agentIds, agentNames };
}

export function peerAlreadyAttended(
  history: ConversationPeerHistory,
  peer: { id?: string | null; name?: string | null },
): boolean {
  if (peer.id && history.agentIds.has(peer.id)) return true;
  const name = peer.name?.trim();
  if (!name) return false;
  return history.agentNames.some((n) => fold(n) === fold(name));
}

export const PEER_ALREADY_ATTENDED_ERROR =
  "Esse agente já atendeu esta conversa e não resolveu. Não devolva para ele: " +
  "resolva com o que você tem ou chame transfer_to_human.";
