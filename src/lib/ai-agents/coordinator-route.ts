/**
 * Roteamento do coordenador por assunto → agente IA da org.
 * Casa pelo NOME do especialista (acolhimento / retenção / atendimento),
 * sem hardcode de tenant.
 */

import { isIdleOrchestrationMessage } from "@/services/ai/transfer-gate";

export type PeerAiAgent = {
  id: string;
  name: string;
  archetype: string | null;
};

export type CoordinatorTopic = "onboarding" | "retention" | "general";

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyCoordinatorTopic(
  userMessage?: string | null,
): CoordinatorTopic | null {
  if (isIdleOrchestrationMessage(userMessage)) return null;
  const n = fold(userMessage ?? "");
  if (!n) return null;

  if (
    /cancel|tranc|desist/.test(n) ||
    /quero (sair|parar) (do |da )?(curso|facul|matricula)/.test(n)
  ) {
    return "retention";
  }

  if (
    /acesso a plataforma|primeiro acesso|primeiro.?acesso/.test(n) ||
    /(portal do aluno|\bava\b|ambiente virtual|login|senha|app duda)/.test(n) ||
    /fiz matricula|matricula h[oj]|matriculei/.test(n)
  ) {
    return "onboarding";
  }

  if (
    /horario|aula|contrato|parcela|financeiro|mensalidade|nota|prova|\btce\b|falar com equipe|falar com a equipe/.test(
      n,
    )
  ) {
    return "general";
  }

  return null;
}

export function pickPeerForTopic(
  topic: CoordinatorTopic,
  peers: PeerAiAgent[],
): PeerAiAgent | null {
  const usable = peers.filter(
    (p) =>
      p.archetype !== "COORDENADOR" &&
      p.archetype !== "TABULACAO" &&
      p.archetype !== "ENCERRAMENTO",
  );
  if (usable.length === 0) return null;

  const by = (re: RegExp) => usable.find((p) => re.test(fold(p.name))) ?? null;
  const onboarding = by(/acolh|primeiro.?acesso|onboard|boas.?vind/);
  const retention = by(/reten|churn/);
  const general = by(/atendiment|\bsac\b|suporte/);

  if (topic === "retention") return retention ?? general ?? usable[0];
  if (topic === "onboarding") return onboarding ?? general ?? usable[0];
  return general ?? usable[0];
}

export function suggestCoordinatorAiAgent(
  userMessage: string | null | undefined,
  peers: PeerAiAgent[],
): PeerAiAgent | null {
  const topic = classifyCoordinatorTopic(userMessage);
  if (!topic) return null;
  return pickPeerForTopic(topic, peers);
}

export function formatCoordinatorRoutingBlock(args: {
  peers: PeerAiAgent[];
  suggested: PeerAiAgent | null;
}): string | null {
  const usable = args.peers.filter(
    (p) =>
      p.archetype !== "COORDENADOR" &&
      p.archetype !== "TABULACAO" &&
      p.archetype !== "ENCERRAMENTO",
  );
  if (usable.length === 0) return null;
  const lines = [
    "AGENTES IA DESTA ORGANIZAÇÃO (use o nome exatamente):",
    ...usable.map((p) => `- ${p.name}`),
    "- Acesso / plataforma / portal / senha / primeiro acesso / matrícula nova → o agente de acolhimento, se existir.",
    "- Cancelar / trancar / desistir → o agente de retenção, se existir.",
    '- Horário, contrato, nota, financeiro, "falar com equipe" → o agente de atendimento/suporte.',
    "- \"Falar com equipe\" NÃO é fila humana: é o especialista de atendimento.",
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
    ...usable.map((p) => `- ${p.name}`),
  ].join("\n");
}
