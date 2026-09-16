/**
 * Modo ativo da org para o bloco Executar distribuição.
 * Default smart — Por Leads só entra com escolha explícita no painel.
 * Um bloco com `mode` no config ainda prevalece sobre este valor.
 */

import { getOrgSettingOrDefault } from "@/lib/org-settings";

export const DISTRIBUTION_MODE_KEY = "distribution.mode";

export type OrgDistributionMode = "smart" | "leads";

export function parseDistributionMode(value: unknown): OrgDistributionMode {
  return value === "leads" ? "leads" : "smart";
}

export async function getOrgDistributionMode(): Promise<OrgDistributionMode> {
  try {
    const raw = await getOrgSettingOrDefault(DISTRIBUTION_MODE_KEY, "smart");
    return parseDistributionMode(raw);
  } catch {
    return "smart";
  }
}
