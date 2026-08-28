/**
 * Relógio comercial e SLA do Painel — compartilhado por Agora e Atendimentos.
 */

import { Prisma } from "@prisma/client";

import { analyticsClient } from "@/lib/analytics";
import { getOrgSetting } from "@/lib/org-settings";
import {
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_SLA_MINUTES,
  parseBusinessHours,
  type BusinessHours,
} from "@/services/painel-period";

const prisma = analyticsClient();

export async function loadPainelHours(): Promise<BusinessHours> {
  try {
    const hoursRow = await prisma.department.findFirst({
      where: { operatingHours: { not: Prisma.DbNull } },
      select: { operatingHours: true },
      orderBy: { createdAt: "asc" },
    });
    return hoursRow
      ? parseBusinessHours(hoursRow.operatingHours)
      : DEFAULT_BUSINESS_HOURS;
  } catch {
    return DEFAULT_BUSINESS_HOURS;
  }
}

export async function loadPainelSlaMinutes(): Promise<number> {
  const slaRaw = await getOrgSetting("painel.slaMinutes");
  const n = Number(slaRaw);
  return Number.isFinite(n) && n > 0 && n <= 24 * 60 ? n : DEFAULT_SLA_MINUTES;
}
