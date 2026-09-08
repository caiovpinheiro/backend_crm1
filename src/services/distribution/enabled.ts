/**
 * Kill switch do motor de distribuição (org-scoped).
 *
 * Mora FORA de `engine.ts` de propósito: `pending.ts` precisa consultar o
 * switch e vários testes mockam `./engine` só com `executeDistribution` —
 * importar daqui evita quebrar esses mocks.
 *
 * Default LIGADO: se a leitura falhar (fora de RequestContext, banco fora),
 * o motor continua distribuindo. Desligar é decisão explícita da org.
 */

import { getOrgSettingBool } from "@/lib/org-settings";

/** Chave gravada pelo toggle da UI (`PUT /api/distribution/settings`). */
export const DISTRIBUTION_ENABLED_KEY = "distribution.enabled";

export async function isDistributionEnabled(): Promise<boolean> {
  try {
    return (await getOrgSettingBool(DISTRIBUTION_ENABLED_KEY, true)) !== false;
  } catch {
    return true;
  }
}
