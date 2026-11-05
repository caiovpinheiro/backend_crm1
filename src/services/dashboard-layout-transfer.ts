/**
 * Exportar / importar o dashboard home entre usuários da MESMA organização.
 *
 * O arquivo leva o JSON de `UserDashboardLayout.data` (widgets visíveis,
 * grid, e `meta`: filtros, ordem por aba, preferências de UI). Não leva
 * dados de negócio: os números continuam calculados com as permissões de
 * quem importa.
 *
 * Importar substitui o registro ativo ("Padrão") do usuário e guarda o
 * anterior num registro de backup (`isDefault=false`, nome reservado), que
 * o "Desfazer importação" restaura. Sem migration: usa a tabela existente.
 */

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  DASHBOARD_DEFAULT_LAYOUT_NAME,
  DASHBOARD_LAYOUT_PRESETS,
  dashboardLayoutPayloadSchema,
  MAX_DASHBOARD_LAYOUT_JSON_CHARS,
} from "@/lib/dashboard-layout-schema";
import { prismaBase } from "@/lib/prisma-base";

export const DASHBOARD_EXPORT_FORMAT = "bwipo.dashboard";
export const DASHBOARD_EXPORT_VERSION = 1;
/** Registro de backup da última importação (nunca é o layout ativo). */
export const DASHBOARD_IMPORT_BACKUP_NAME = "__backup_importacao__";

export interface DashboardLayoutData {
  visibleWidgets: string[];
  layout: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface DashboardExportFile {
  format: typeof DASHBOARD_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  organizationId: string;
  exportedBy: { id: string; name: string | null };
  preset: string;
  data: DashboardLayoutData;
}

export interface DashboardImportSource {
  exportedByName: string | null;
  exportedAt: string;
}

export interface DashboardImportBackupInfo {
  importedAt: string;
  source: DashboardImportSource;
}

/** Conteúdo do registro de backup (`data` do registro reservado). */
interface BackupRecordData {
  kind: "import-backup";
  importedAt: string;
  source: DashboardImportSource;
  /** `null` = usuário não tinha layout salvo (desfazer volta ao preset padrão). */
  previous: { preset: string; data: unknown } | null;
}

const fileSchema = z.object({
  format: z.literal(DASHBOARD_EXPORT_FORMAT),
  version: z.number().int().min(1),
  exportedAt: z.string().max(64),
  organizationId: z.string().min(1).max(64),
  exportedBy: z
    .object({ id: z.string().max(64).optional(), name: z.string().max(200).nullable().optional() })
    .optional(),
  preset: z.string().max(32).optional(),
  data: dashboardLayoutPayloadSchema.omit({ name: true, preset: true }),
});

export type ParseImportResult =
  | { ok: true; preset: string; data: DashboardLayoutData; source: DashboardImportSource }
  | { ok: false; status: 400; message: string };

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Normaliza o JSON salvo (formato livre no banco) para o shape do arquivo. */
export function normalizeLayoutData(raw: unknown): DashboardLayoutData {
  const base = isPlain(raw) ? raw : {};
  return {
    visibleWidgets: Array.isArray(base.visibleWidgets)
      ? base.visibleWidgets.filter((w): w is string => typeof w === "string")
      : [],
    layout: isPlain(base.layout) ? base.layout : {},
    meta: isPlain(base.meta) ? base.meta : {},
  };
}

export function buildDashboardExportFile(input: {
  organizationId: string;
  user: { id: string; name: string | null };
  record: { preset: string; data: unknown } | null;
  now?: Date;
}): DashboardExportFile {
  return {
    format: DASHBOARD_EXPORT_FORMAT,
    version: DASHBOARD_EXPORT_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    organizationId: input.organizationId,
    exportedBy: { id: input.user.id, name: input.user.name },
    preset: input.record?.preset ?? "default",
    data: normalizeLayoutData(input.record?.data),
  };
}

/** Valida o arquivo enviado. Só aceita arquivo da mesma organização. */
export function parseDashboardImportFile(raw: unknown, organizationId: string): ParseImportResult {
  if (JSON.stringify(raw ?? null).length > MAX_DASHBOARD_LAYOUT_JSON_CHARS + 4_000) {
    return { ok: false, status: 400, message: "Arquivo de dashboard grande demais." };
  }
  if (!isPlain(raw) || raw.format !== DASHBOARD_EXPORT_FORMAT) {
    return {
      ok: false,
      status: 400,
      message: "Este arquivo não é um dashboard exportado do Bwipo.",
    };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, message: "Arquivo de dashboard inválido ou corrompido." };
  }
  const file = parsed.data;
  if (file.version > DASHBOARD_EXPORT_VERSION) {
    return {
      ok: false,
      status: 400,
      message: "Este arquivo foi gerado por uma versão mais nova do CRM. Atualize a página e tente de novo.",
    };
  }
  if (file.organizationId !== organizationId) {
    return {
      ok: false,
      status: 400,
      message: "Este dashboard foi exportado de outra empresa e não pode ser importado aqui.",
    };
  }
  const preset = (DASHBOARD_LAYOUT_PRESETS as readonly string[]).includes(file.preset ?? "")
    ? (file.preset as string)
    : "custom";
  return {
    ok: true,
    preset,
    data: {
      visibleWidgets: file.data.visibleWidgets,
      layout: file.data.layout,
      meta: file.data.meta ?? {},
    },
    source: { exportedByName: file.exportedBy?.name ?? null, exportedAt: file.exportedAt },
  };
}

function readBackup(raw: unknown): BackupRecordData | null {
  if (!isPlain(raw) || raw.kind !== "import-backup") return null;
  return raw as unknown as BackupRecordData;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Layout ativo do usuário, para exportar. */
export async function getActiveDashboardLayout(
  userId: string,
): Promise<{ preset: string; data: unknown } | null> {
  // Mesmo critério do GET /api/dashboard/layout (registro default mais recente).
  return prismaBase.userDashboardLayout.findFirst({
    where: { userId, isDefault: true, NOT: { name: DASHBOARD_IMPORT_BACKUP_NAME } },
    orderBy: { updatedAt: "desc" },
    select: { preset: true, data: true },
  });
}

/** Backup pendente da última importação (para o botão "Desfazer importação"). */
export async function getDashboardImportBackup(
  userId: string,
): Promise<DashboardImportBackupInfo | null> {
  const row = await prismaBase.userDashboardLayout.findFirst({
    where: { userId, name: DASHBOARD_IMPORT_BACKUP_NAME },
    select: { data: true },
  });
  const backup = readBackup(row?.data);
  return backup ? { importedAt: backup.importedAt, source: backup.source } : null;
}

/**
 * Substitui o layout ativo pelo importado e guarda o anterior como backup.
 * Unique `(userId, name)` é global (ver PATCH do layout): identidade vem da
 * sessão e a org do registro é sempre a atual.
 */
export async function importDashboardLayout(input: {
  userId: string;
  organizationId: string;
  preset: string;
  data: DashboardLayoutData;
  source: DashboardImportSource;
  now?: Date;
}): Promise<DashboardImportBackupInfo> {
  const importedAt = (input.now ?? new Date()).toISOString();
  return prismaBase.$transaction(async (tx) => {
    const current = await tx.userDashboardLayout.findFirst({
      where: { userId: input.userId, name: DASHBOARD_DEFAULT_LAYOUT_NAME },
      select: { id: true, preset: true, data: true },
    });
    const backupData: BackupRecordData = {
      kind: "import-backup",
      importedAt,
      source: input.source,
      previous: current ? { preset: current.preset, data: current.data } : null,
    };
    const existingBackup = await tx.userDashboardLayout.findFirst({
      where: { userId: input.userId, name: DASHBOARD_IMPORT_BACKUP_NAME },
      select: { id: true },
    });
    if (existingBackup) {
      await tx.userDashboardLayout.update({
        where: { id: existingBackup.id },
        data: { data: toJson(backupData), isDefault: false, organizationId: input.organizationId },
      });
    } else {
      await tx.userDashboardLayout.create({
        data: {
          userId: input.userId,
          organizationId: input.organizationId,
          name: DASHBOARD_IMPORT_BACKUP_NAME,
          isDefault: false,
          preset: "custom",
          data: toJson(backupData),
        },
      });
    }

    const layoutData = toJson({ ...input.data, meta: { v: 2, ...input.data.meta } });
    if (current) {
      await tx.userDashboardLayout.update({
        where: { id: current.id },
        data: {
          preset: input.preset,
          data: layoutData,
          isDefault: true,
          organizationId: input.organizationId,
        },
      });
    } else {
      await tx.userDashboardLayout.create({
        data: {
          userId: input.userId,
          organizationId: input.organizationId,
          name: DASHBOARD_DEFAULT_LAYOUT_NAME,
          isDefault: true,
          preset: input.preset,
          data: layoutData,
        },
      });
    }
    return { importedAt, source: input.source };
  });
}

/** Volta ao layout anterior à última importação. `false` = não há o que desfazer. */
export async function undoDashboardImport(input: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return prismaBase.$transaction(async (tx) => {
    const backupRow = await tx.userDashboardLayout.findFirst({
      where: { userId: input.userId, name: DASHBOARD_IMPORT_BACKUP_NAME },
      select: { id: true, data: true },
    });
    const backup = readBackup(backupRow?.data);
    if (!backupRow || !backup) return false;

    const current = await tx.userDashboardLayout.findFirst({
      where: { userId: input.userId, name: DASHBOARD_DEFAULT_LAYOUT_NAME },
      select: { id: true },
    });
    if (!backup.previous) {
      // Não tinha layout antes: volta ao preset padrão do client.
      if (current) await tx.userDashboardLayout.delete({ where: { id: current.id } });
    } else if (current) {
      await tx.userDashboardLayout.update({
        where: { id: current.id },
        data: {
          preset: backup.previous.preset,
          data: toJson(backup.previous.data),
          isDefault: true,
          organizationId: input.organizationId,
        },
      });
    } else {
      await tx.userDashboardLayout.create({
        data: {
          userId: input.userId,
          organizationId: input.organizationId,
          name: DASHBOARD_DEFAULT_LAYOUT_NAME,
          isDefault: true,
          preset: backup.previous.preset,
          data: toJson(backup.previous.data),
        },
      });
    }
    await tx.userDashboardLayout.delete({ where: { id: backupRow.id } });
    return true;
  });
}
