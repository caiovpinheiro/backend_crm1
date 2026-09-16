/**
 * Kill switch do modo "leads" (Distribuição por Leads), org-scoped.
 *
 * Independente do kill switch do smart (`distribution.enabled`): os dois
 * motores coexistem e cada um tem o seu. Default DESLIGADO — ligar é decisão
 * explícita da org (toggle na página "Distribuição por Leads").
 *
 * Em produção o motor Inteligente permanece ativo até a org habilitar Por Leads
 * explicitamente. Qualquer erro de leitura da setting também mantém desligado.
 */

import { getOrgSettingBool } from "@/lib/org-settings";

export const LEADS_DISTRIBUTION_ENABLED_KEY = "distribution.leads.enabled";

export async function isLeadsDistributionEnabled(): Promise<boolean> {
  try {
    return (await getOrgSettingBool(LEADS_DISTRIBUTION_ENABLED_KEY, false)) === true;
  } catch {
    return false;
  }
}
