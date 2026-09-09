/** Arquétipo de classificador: lê o histórico e aplica tabulação. Sem WhatsApp. */
export const TABULATION_CLASSIFIER_ARCHETYPE = "TABULACAO" as const;

export const TABULATION_CLASSIFIER_TOOLS = [
  "list_tabulations",
  "tabulate_conversation",
] as const;

export function isTabulationClassifier(agent: {
  archetype?: string | null;
  enabledTools?: string[] | null;
  name?: string | null;
}): boolean {
  if (agent.archetype === TABULATION_CLASSIFIER_ARCHETYPE) return true;
  if ((agent.enabledTools ?? []).includes("tabulate_conversation")) return true;
  // Agente criado com outro arquétipo e só renomeado (ex.: "Tabulador").
  return /tabul/i.test(agent.name ?? "");
}
