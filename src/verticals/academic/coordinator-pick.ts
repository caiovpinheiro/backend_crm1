/**
 * Padrões de assunto do pack acadêmico (dado, não núcleo).
 * Usado só quando o peer ainda não tem routingScope preenchido.
 */
import type { PeerAiAgent } from "@/lib/ai-agents/coordinator-route";

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function pickAcademicCoordinatorPeer(
  userMessage: string,
  peers: PeerAiAgent[],
): PeerAiAgent | null {
  const n = fold(userMessage);
  if (!n) return null;
  const usable = peers.filter(
    (p) =>
      p.archetype !== "COORDENADOR" &&
      p.archetype !== "TABULACAO" &&
      p.archetype !== "ENCERRAMENTO",
  );
  if (usable.length === 0) return null;

  let topic: "onboarding" | "retention" | "general" | null = null;
  if (
    /cancel|tranc|desist/.test(n) ||
    /quero (sair|parar) (do |da )?(curso|facul|matricula)/.test(n)
  ) {
    topic = "retention";
  } else if (
    /acesso a plataforma|primeiro acesso|primeiro.?acesso/.test(n) ||
    /(portal do aluno|\bava\b|ambiente virtual|login|senha|app duda)/.test(n) ||
    /fiz matricula|matricula h[oj]|matriculei/.test(n)
  ) {
    topic = "onboarding";
  } else if (
    /horario|aula|contrato|parcela|financeiro|mensalidade|nota|prova|\btce\b|falar com equipe|falar com a equipe/.test(
      n,
    )
  ) {
    topic = "general";
  }
  if (!topic) return null;

  // Só `routingScope`. O casamento por NOME do agente saiu daqui: "Agente
  // Acolhimento" virar "Time Boas-vindas" mudava o roteamento em silêncio,
  // e o nome também não diz nada sobre o assunto em org que não usa essa
  // nomenclatura. Sem escopo configurado não há sugestão — o coordenador
  // decide pelo LLM, com a descrição de cada agente no prompt.
  const byScope = (re: RegExp) =>
    usable.find((p) => re.test(fold(p.routingScope ?? ""))) ?? null;

  if (!usable.some((p) => p.routingScope?.trim())) {
    console.warn(
      "[ai]",
      JSON.stringify({
        event: "routing_scope_missing",
        pack: "academic",
        topic,
        peers: usable.map((p) => p.id),
      }),
    );
    return null;
  }

  const onboarding = byScope(/onboard|primeiro.?acesso|boas.?vind|portal|senha/);
  const retention = byScope(/churn|cancel|tranc/);
  const general = byScope(/suporte|horario|contrato|financeiro/);

  if (topic === "retention") return retention ?? general;
  if (topic === "onboarding") return onboarding ?? general;
  return general;
}
