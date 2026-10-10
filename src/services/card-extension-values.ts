import { getOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { withoutBlankOverwrites } from "@/services/custom-fields";

const KEY = "customFields.cardExtension";

export function parseExtensionFieldIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

export async function loadExtensionFieldIds(): Promise<string[]> {
  return parseExtensionFieldIds(await getOrgSetting(KEY));
}

export async function listDealCardExtensionValues(dealId: string) {
  const ids = await loadExtensionFieldIds();
  if (ids.length === 0) return [];
  const rows = await prisma.dealCardExtensionValue.findMany({
    where: { dealId, customFieldId: { in: ids } },
    select: { customFieldId: true, value: true },
  });
  return rows.map((row) => ({ fieldId: row.customFieldId, value: row.value }));
}

export async function upsertDealCardExtensionValues(
  dealId: string,
  values: { fieldId: string; value: string }[],
) {
  if (values.length === 0) return [];
  const existing = await prisma.dealCardExtensionValue.findMany({
    where: { dealId, customFieldId: { in: values.map((item) => item.fieldId) } },
    select: { customFieldId: true, value: true },
  });
  const writable = withoutBlankOverwrites(
    values,
    existing.map((row) => ({ fieldId: row.customFieldId, value: row.value })),
  );
  if (writable.length === 0) return [];
  const ops = writable.map((item) =>
    prisma.dealCardExtensionValue.upsert({
      where: {
        dealId_customFieldId: { dealId, customFieldId: item.fieldId },
      },
      update: { value: item.value },
      create: withOrgFromCtx({
        dealId,
        customFieldId: item.fieldId,
        value: item.value,
      }),
    }),
  );
  return prisma.$transaction(ops);
}
