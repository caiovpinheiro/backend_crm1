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

  const byScope = (re: RegExp) =>
    usable.find((p) => re.test(fold(p.routingScope ?? ""))) ?? null;
  const byName = (re: RegExp) =>
    usable.find((p) => re.test(fold(p.name))) ?? null;

  const onboarding =
    byScope(/onboard|primeiro.?acesso|boas.?vind|portal|senha/) ??
    byName(/acolh|primeiro.?acesso|onboard|boas.?vind/);
  const retention =
    byScope(/churn|cancel|tranc/) ?? byName(/reten|churn/);
  const general =
    byScope(/suporte|horario|contrato|financeiro/) ??
    byName(/atendiment|\bsac\b|suporte/);

  if (topic === "retention") return retention ?? general ?? usable[0];
  if (topic === "onboarding") return onboarding ?? general ?? usable[0];
  return general ?? usable[0];
}
