/**
 * Merge parcial do JSON de UserDashboardLayout.
 * Chaves de `meta` enviadas substituem só aquela chave; as demais ficam.
 * `organizationId` / `userId` nunca entram pelo payload — identidade é a sessão.
 */

export type DashboardLayoutPatch = {
  visibleWidgets?: string[];
  layout?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type DashboardLayoutData = {
  visibleWidgets: unknown;
  layout: unknown;
  meta: Record<string, unknown>;
};

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function mergeDashboardLayoutData(
  existing: unknown,
  patch: DashboardLayoutPatch,
): DashboardLayoutData {
  const base = isPlain(existing) ? existing : {};
  const prevMeta = isPlain(base.meta) ? base.meta : {};
  const meta: Record<string, unknown> = { ...prevMeta };

  if (patch.meta) {
    for (const [key, value] of Object.entries(patch.meta)) {
      if (key === "organizationId" || key === "userId") continue;
      if (value === undefined) continue;
      meta[key] = value;
    }
  }

  if (meta.v == null) meta.v = 2;

  return {
    visibleWidgets:
      patch.visibleWidgets !== undefined
        ? patch.visibleWidgets
        : (base.visibleWidgets ?? []),
    layout: patch.layout !== undefined ? patch.layout : (base.layout ?? {}),
    meta,
  };
}
