/**
 * Roteamento do coordenador → outro agente IA da org.
 * Destino sai do `routingScope` configurado em cada AIAgentConfig
 * (inboxPolicy.routingScope). Renomear o agente não muda o roteamento.
 * Padrões de assunto de produto (se houver) vivem no pack, não aqui.
 */

import { isIdleOrchestrationMessage } from "@/services/ai/transfer-gate";
import { getVerticalPack } from "@/verticals";

export type PeerAiAgent = {
  id: string;
  name: string;
  archetype: string | null;
  routingScope?: string | null;
};

export type CoordinatorTopic = string;

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function usablePeers(peers: PeerAiAgent[]): PeerAiAgent[] {
  return peers.filter(
    (p) =>
      p.archetype !== "COORDENADOR" &&
      p.archetype !== "TABULACAO" &&
      p.archetype !== "ENCERRAMENTO",
  );
}

/** Casa inbound com tokens do routingScope de cada peer (configuração). */
export function pickPeerByRoutingScope(
  userMessage: string | null | undefined,
  peers: PeerAiAgent[],
): PeerAiAgent | null {
  if (isIdleOrchestrationMessage(userMessage)) return null;
  const n = fold(userMessage ?? "");
  if (!n) return null;
  const usable = usablePeers(peers);
  let best: PeerAiAgent | null = null;
  let bestScore = 0;
  for (const p of usable) {
    const scope = fold(p.routingScope ?? "");
    if (!scope) continue;
    const tokens = scope.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    const score = tokens.filter((t) => n.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore > 0 ? best : null;
}

/// Acima disso a mensagem traz assunto próprio, não é só a resposta.
const SHORT_REPLY_MAX_WORDS = 6;

/**
 * A mensagem do contato é a resposta à pergunta que o agente acabou de
 * fazer? O roteamento por escopo lê cada inbound como assunto novo, então
 * "Financeiro" respondendo a "qual o motivo?" era roteado como se o
 * contato tivesse aberto um chamado financeiro — e a conversa ficava indo
 * e voltando entre dois agentes sem ninguém concluir nada.
 *
 * Só forma do diálogo: pergunta anterior + resposta curta. Sem vocabulário
 * de assunto, que é configuração de cada organização.
 */
export function isReplyToAgentQuestion(
  userMessage: string | null | undefined,
  lastAgentMessage: string | null | undefined,
): boolean {
  const asked = (lastAgentMessage ?? "").trim();
  if (!asked.endsWith("?")) return false;
  const words = fold(userMessage ?? "")
    .split(" ")
    .filter(Boolean);
  return words.length > 0 && words.length <= SHORT_REPLY_MAX_WORDS;
}

export function suggestCoordinatorAiAgent(
  userMessage: string | null | undefined,
  peers: PeerAiAgent[],
  verticalPack?: string | null,
): PeerAiAgent | null {
  const byScope = pickPeerByRoutingScope(userMessage, peers);
  if (byScope) return byScope;
  const pack = getVerticalPack(verticalPack);
  return pack?.ops.pickCoordinatorPeer?.(userMessage ?? "", peers) ?? null;
}

export function formatCoordinatorRoutingBlock(args: {
  peers: PeerAiAgent[];
  suggested: PeerAiAgent | null;
}): string | null {
  const usable = usablePeers(args.peers);
  if (usable.length === 0) return null;
  const lines = [
    "AGENTES IA DESTA ORGANIZAÇÃO (use o nome exatamente):",
    ...usable.map((p) => {
      const scope = p.routingScope?.trim();
      return scope ? `- ${p.name}: ${scope}` : `- ${p.name}`;
    }),
    "Passe o assunto para o agente cujo escopo combina. Não explique o assunto ao contato.",
  ];
  if (args.suggested) {
    lines.push(
      `DESTINO DESTE TURNO: ${args.suggested.name}. Chame transfer_to_ai_agent ou transfer_conversation (target=ai_agent) agora. Não explique o assunto.`,
    );
  }
  return lines.join("\n");
}

export function formatSpecialistPeerBlock(
  selfId: string,
  peers: PeerAiAgent[],
): string | null {
  const usable = peers.filter(
    (p) =>
      p.id !== selfId &&
      p.archetype !== "COORDENADOR" &&
      p.archetype !== "TABULACAO" &&
      p.archetype !== "ENCERRAMENTO",
  );
  if (usable.length === 0) return null;
  return [
    "OUTROS AGENTES IA (passe o assunto para eles, não para fila humana):",
    ...usable.map((p) => {
      const scope = p.routingScope?.trim();
      return scope ? `- ${p.name}: ${scope}` : `- ${p.name}`;
    }),
  ].join("\n");
}
