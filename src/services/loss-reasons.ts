import { bumpResponseFamilies, RESPONSE_FAMILIES, type ResponseFamily } from "@/lib/cache/response-families";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull, getOrgIdOrThrow } from "@/lib/request-context";

/**
 * Respostas em cache: `GET /api/settings/loss-reasons` (catálogo com os
 * funis vinculados) e `GET /api/pipelines` (`updatedAt` do funil).
 */
async function invalidateCached(...families: ResponseFamily[]): Promise<void> {
  await bumpResponseFamilies(getOrgIdOrNull(), ...families);
}

export type LossReasonDto = {
  id: string;
  label: string;
  position: number;
  isActive: boolean;
  pipelineIds: string[];
};

/** Lista motivos ativos do catálogo (com funis vinculados). */
export async function listLossReasons(): Promise<LossReasonDto[]> {
  const rows = await prisma.lossReason.findMany({
    where: { isActive: true },
    orderBy: { position: "asc" },
    include: {
      pipelineLinks: { select: { pipelineId: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    position: r.position,
    isActive: r.isActive,
    pipelineIds: r.pipelineLinks.map((l) => l.pipelineId),
  }));
}

/** Motivos do funil, na ordem do vínculo. Vazio = funil sem motivos. */
export async function listPipelineLossReasons(pipelineId: string) {
  const links = await prisma.pipelineLossReason.findMany({
    where: { pipelineId },
    orderBy: { position: "asc" },
    include: {
      lossReason: {
        select: { id: true, label: true, isActive: true },
      },
    },
  });
  return links
    .filter((l) => l.lossReason.isActive)
    .map((l) => ({
      id: l.lossReason.id,
      label: l.lossReason.label,
      position: l.position,
      linkId: l.id,
    }));
}

export async function getPipelineLossReasonMeta(pipelineId: string) {
  const pipeline = await prisma.pipeline.findUnique({
    where: { id: pipelineId },
    select: {
      id: true,
      name: true,
      lossReasonRequired: true,
      lossReasonAllowOther: true,
    },
  });
  if (!pipeline) return null;
  const reasons = await listPipelineLossReasons(pipelineId);
  return { ...pipeline, reasons };
}

export async function createLossReason(label: string) {
  const trimmed = label.trim();
  if (!trimmed) throw new Error("INVALID_LABEL");
  const maxPos = await prisma.lossReason.aggregate({ _max: { position: true } });
  const position = (maxPos._max.position ?? -1) + 1;
  const created = await prisma.lossReason.create({
    data: withOrgFromCtx({ label: trimmed, position }),
  });
  await invalidateCached(RESPONSE_FAMILIES.lossReasons);
  return created;
}

export async function updateLossReason(
  id: string,
  data: { label?: string; position?: number; isActive?: boolean },
) {
  const payload: { label?: string; position?: number; isActive?: boolean } = {};
  if (typeof data.label === "string" && data.label.trim()) {
    payload.label = data.label.trim();
  }
  if (typeof data.position === "number") payload.position = data.position;
  if (typeof data.isActive === "boolean") payload.isActive = data.isActive;
  if (Object.keys(payload).length === 0) throw new Error("EMPTY_UPDATE");
  const updated = await prisma.lossReason.update({ where: { id }, data: payload });
  await invalidateCached(RESPONSE_FAMILIES.lossReasons);
  return updated;
}

export async function softDeleteLossReason(id: string) {
  await prisma.pipelineLossReason.deleteMany({ where: { lossReasonId: id } });
  const updated = await prisma.lossReason.update({
    where: { id },
    data: { isActive: false },
  });
  await invalidateCached(RESPONSE_FAMILIES.lossReasons);
  return updated;
}

/** Reordena o catálogo global (position). */
export async function reorderLossReasons(ids: string[]) {
  if (!ids.length) return;
  await prisma.$transaction(
    ids.map((id, position) =>
      prisma.lossReason.update({ where: { id }, data: { position } }),
    ),
  );
  await invalidateCached(RESPONSE_FAMILIES.lossReasons);
}

/**
 * Substitui os vínculos do funil e a ordem.
 * `reasonIds` = ordem desejada; lista vazia remove todos.
 */
export async function setPipelineLossReasons(
  pipelineId: string,
  reasonIds: string[],
) {
  const organizationId = getOrgIdOrThrow();
  const pipeline = await prisma.pipeline.findUnique({
    where: { id: pipelineId },
    select: { id: true },
  });
  if (!pipeline) throw new Error("PIPELINE_NOT_FOUND");

  const uniqueIds = [...new Set(reasonIds)];
  if (uniqueIds.length) {
    const found = await prisma.lossReason.count({
      where: { id: { in: uniqueIds }, isActive: true },
    });
    if (found !== uniqueIds.length) throw new Error("INVALID_REASON");
  }

  await prisma.$transaction(async (tx) => {
    await tx.pipelineLossReason.deleteMany({ where: { pipelineId } });
    if (!uniqueIds.length) return;
    await tx.pipelineLossReason.createMany({
      data: uniqueIds.map((lossReasonId, position) => ({
        organizationId,
        pipelineId,
        lossReasonId,
        position,
      })),
    });
  });
  await invalidateCached(RESPONSE_FAMILIES.lossReasons);

  return listPipelineLossReasons(pipelineId);
}

export async function setPipelineLossReasonRequired(
  pipelineId: string,
  required: boolean,
) {
  const updated = await prisma.pipeline.update({
    where: { id: pipelineId },
    data: { lossReasonRequired: required },
    select: { id: true, lossReasonRequired: true },
  });
  await invalidateCached(RESPONSE_FAMILIES.pipelines);
  return updated;
}

export async function setPipelineLossReasonAllowOther(
  pipelineId: string,
  allowOther: boolean,
) {
  const updated = await prisma.pipeline.update({
    where: { id: pipelineId },
    data: { lossReasonAllowOther: allowOther },
    select: { id: true, lossReasonAllowOther: true },
  });
  await invalidateCached(RESPONSE_FAMILIES.pipelines);
  return updated;
}

/** Default true se funil inexistente / sem coluna (migração pendente). */
export async function isPipelineLossReasonAllowOther(
  pipelineId: string | null | undefined,
): Promise<boolean> {
  if (!pipelineId) return true;
  try {
    const p = await prisma.pipeline.findUnique({
      where: { id: pipelineId },
      select: { lossReasonAllowOther: true },
    });
    return p?.lossReasonAllowOther !== false;
  } catch {
    return true;
  }
}

/**
 * Valida motivo no contexto do funil:
 * - se o funil tem vínculos, o label precisa estar na lista (salvo allow_other)
 * - se o funil não tem vínculos e allow_other=false, rejeita qualquer texto
 *   cadastrado fora… na prática sem vínculos + !allowOther = só vazio ok
 */
export async function assertLostReasonAllowedForPipeline(
  pipelineId: string | null | undefined,
  reason: string | null | undefined,
  allowOther: boolean,
): Promise<void> {
  const trimmed = reason?.trim();
  if (!trimmed) return;
  if (allowOther) return;

  if (!pipelineId) {
    const match = await prisma.lossReason.findFirst({
      where: { label: trimmed, isActive: true },
      select: { id: true },
    });
    if (!match) throw new Error("INVALID_LOST_REASON");
    return;
  }

  const links = await prisma.pipelineLossReason.findMany({
    where: { pipelineId },
    include: { lossReason: { select: { label: true, isActive: true } } },
  });
  const labels = links
    .filter((l) => l.lossReason.isActive)
    .map((l) => l.lossReason.label);
  if (labels.length === 0) {
    // Funil sem motivos cadastrados: sem allow_other, rejeita texto livre.
    throw new Error("INVALID_LOST_REASON");
  }
  if (!labels.includes(trimmed)) throw new Error("INVALID_LOST_REASON");
}

export async function isPipelineLossReasonRequired(
  pipelineId: string | null | undefined,
): Promise<boolean> {
  if (!pipelineId) return false;
  const p = await prisma.pipeline.findUnique({
    where: { id: pipelineId },
    select: { lossReasonRequired: true },
  });
  return Boolean(p?.lossReasonRequired);
}
