/** Arquétipo de despedida: reconhece encerramento do contato e fecha o ticket. */
export const FAREWELL_CLOSER_ARCHETYPE = "ENCERRAMENTO" as const;

export const FAREWELL_CLOSE_MESSAGE =
  "Obrigado. Se precisar estamos aqui para ajudar";

export function isFarewellCloser(agent: {
  archetype?: string | null;
  name?: string | null;
}): boolean {
  if (agent.archetype === FAREWELL_CLOSER_ARCHETYPE) return true;
  return /encerr|despedid/i.test(agent.name ?? "");
}
