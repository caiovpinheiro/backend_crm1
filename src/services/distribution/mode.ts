/**
 * Modo ativo da org para o bloco Executar distribuição.
 * Default smart — Por Leads só entra com escolha explícita no painel.
 * Um bloco com `mode` no config ainda prevalece sobre este valor.
 */

import { prisma } from "@/lib/prisma";
import { getOrgSettingOrDefault } from "@/lib/org-settings";
import { getOrgIdOrThrow } from "@/lib/request-context";

export const DISTRIBUTION_MODE_KEY = "distribution.mode";

/**
 * Origem gravada em `assignedVia` pelo bloco "Atribuir responsável".
 * Não é o motor (nem inteligente, nem por leads): o inbound não reavalia
 * fila, status nem expediente e não tira esse responsável.
 */
export const ASSIGN_OWNER_VIA = "assign_owner";

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

/** Leitura direta, sem o cache de 60s — o inbound não pode agir com modo velho. */
export async function getOrgDistributionModeFresh(): Promise<OrgDistributionMode> {
  try {
    const orgId = getOrgIdOrThrow();
    const row = await prisma.organizationSetting.findFirst({
      where: { key: DISTRIBUTION_MODE_KEY, organizationId: orgId },
      select: { value: true },
    });
    return parseDistributionMode(row?.value ?? null);
  } catch {
    return "smart";
  }
}
