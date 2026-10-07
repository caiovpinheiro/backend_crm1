import { prisma } from "@/lib/prisma";

export type IntentionalStageDeal = {
  id: string;
  intentionalDuplicate: boolean;
  duplicatedFromDealId: string | null;
  createdAt: Date;
};

/** Cópias de propósito e a origem, na etapa, do mais antigo para o mais novo. */
export function intentionalStageClusterIds(rows: IntentionalStageDeal[]): string[] {
  const originIds = new Set(
    rows
      .filter((row) => row.intentionalDuplicate && row.duplicatedFromDealId)
      .map((row) => row.duplicatedFromDealId as string),
  );
  return rows
    .filter((row) => row.intentionalDuplicate || originIds.has(row.id))
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    )
    .map((row) => row.id);
}

/**
 * Já existe fluxo desta automação para o contato e há mais de um card
 * de propósito na etapa. Quem chega depois não recomeça do passo 0.
 */
export function shouldSkipIntentionalStageRetrigger(args: {
  dealId: string;
  clusterIdsOldestFirst: string[];
  hasPriorContext: boolean;
}): boolean {
  if (!args.hasPriorContext) return false;
  if (args.clusterIdsOldestFirst.length < 2) return false;
  return args.clusterIdsOldestFirst.includes(args.dealId);
}

export async function loadIntentionalStageClusterIds(
  contactId: string,
  stageId: string,
): Promise<string[]> {
  const rows = await prisma.deal.findMany({
    where: { contactId, status: "OPEN", stageId },
    select: {
      id: true,
      intentionalDuplicate: true,
      duplicatedFromDealId: true,
      createdAt: true,
    },
  });
  return intentionalStageClusterIds(rows);
}
