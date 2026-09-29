/**
 * Sandbox do replay com handoff real.
 *
 * O `--real-handoff` roda o agente com `source: "inbox"` para que
 * `executeOrchestratedHandoff` e o assign executem de verdade. Isso liga
 * junto TODO o resto do caminho de produção: envio pelo canal, rodízio
 * humano, SSE para o inbox dos operadores, automações e notificações.
 * Nada disso pode acontecer por causa de um replay.
 *
 * O contorno é este flag de processo (o replay é um processo dedicado,
 * de um run só) lido nos poucos pontos onde o efeito sai do sandbox:
 *
 *   - `sseBus.publish`            → não publica (operador não vê nada)
 *   - `executeDistribution`       → vira `simulateDistribution`: resolve
 *                                   quem SERIA escolhido, não atribui
 *   - `send_whatsapp_template`    → recusa antes de falar com a Meta
 *   - `notifyDealStageChanged`    → não enfileira automação
 *   - `triggerAgentOpeningForContact` → não dispara saudação
 *
 * Atribuição a agente IA continua acontecendo: é exatamente o que o
 * replay foi feito para exercitar, e o dono fica dentro das linhas do
 * sandbox, que são apagadas no fim.
 *
 * Tudo que é recusado fica registrado em `blockedEffects()` e vai para o
 * relatório do replay — o teste de segurança lê daí.
 */

export type SandboxBlockedEffect = {
  effect:
    | "sse_publish"
    | "distribution_assign"
    | "outbound_send"
    | "automation_trigger"
    | "human_assignment";
  detail: string;
  at: string;
};

let active = false;
let organizationId: string | null = null;
const blocked: SandboxBlockedEffect[] = [];

export function enableReplaySandbox(orgId: string): void {
  active = true;
  organizationId = orgId;
}

export function disableReplaySandbox(): void {
  active = false;
  organizationId = null;
}

/** Sandbox ligado para esta organização (ou para qualquer uma, sem orgId). */
export function isReplaySandboxActive(orgId?: string | null): boolean {
  if (!active) return false;
  if (!orgId || !organizationId) return active;
  return orgId === organizationId;
}

export function recordBlockedEffect(
  effect: SandboxBlockedEffect["effect"],
  detail: string,
): void {
  blocked.push({ effect, detail, at: new Date().toISOString() });
}

export function blockedEffects(): SandboxBlockedEffect[] {
  return [...blocked];
}

export function resetReplaySandboxForTest(): void {
  active = false;
  organizationId = null;
  blocked.length = 0;
}

/** Chave de org que autoriza o replay com handoff real. */
export const REPLAY_SANDBOX_SETTING_KEY = "replay.sandboxEnabled";
