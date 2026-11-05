/**
 * Validação do JSON de `UserDashboardLayout.data` (dashboard home).
 * Compartilhado pelo salvamento normal (`/api/dashboard/layout`) e pela
 * importação de arquivo (`/api/dashboard/layout/import`): o mesmo shape
 * que o editor grava é o único aceito na importação.
 */

import { z } from "zod";

export const DASHBOARD_LAYOUT_PRESETS = [
  "default",
  "comercial",
  "atendimento",
  "equipe",
  "monitor",
  "custom",
] as const;

export const dashboardGridItemSchema = z.object({
  i: z.string().min(1).max(64),
  x: z.number().int().min(0).max(50),
  y: z.number().int().min(0).max(500),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(50),
  minW: z.number().int().min(1).max(12).optional(),
  minH: z.number().int().min(1).max(50).optional(),
  maxW: z.number().int().min(1).max(12).optional(),
  maxH: z.number().int().min(1).max(50).optional(),
});

/**
 * Validação solta pra permitir evoluir o catálogo de widgets sem migration —
 * widgets desconhecidos no backend são aceitos (o client faz o filtro final).
 */
export const dashboardLayoutPayloadSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  preset: z.enum(DASHBOARD_LAYOUT_PRESETS).optional(),
  visibleWidgets: z.array(z.string().min(1).max(64)).max(50),
  layout: z.record(z.string().min(1).max(64), dashboardGridItemSchema),
  /** Flags extras do layout (tema, densidade, filtros, ordem por aba…). */
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type DashboardLayoutPayload = z.infer<typeof dashboardLayoutPayloadSchema>;

/** Nome do registro ativo do usuário (o único que a UI lê e grava). */
export const DASHBOARD_DEFAULT_LAYOUT_NAME = "Padrão";

/** Tamanho máximo do JSON serializado aceito do client. */
export const MAX_DASHBOARD_LAYOUT_JSON_CHARS = 128_000;
