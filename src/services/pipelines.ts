import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { slugify } from "@/lib/utils";

const DEFAULT_STAGES: Omit<
  Prisma.StageCreateWithoutPipelineInput,
  "pipeline" | "organization" | "number"
>[] = [
  { name: "Novo", position: 0, color: "#6366f1", winProbability: 10, rottingDays: 30, slug: "novo" },
  { name: "Qualificado", position: 1, color: "#8b5cf6", winProbability: 25, rottingDays: 30, slug: "qualificado" },
  { name: "Proposta", position: 2, color: "#ec4899", winProbability: 50, rottingDays: 14, slug: "proposta" },
  { name: "Negociação", position: 3, color: "#f97316", winProbability: 75, rottingDays: 7, slug: "negociacao" },
  { name: "Fechamento", position: 4, color: "#22c55e", winProbability: 90, rottingDays: 7, slug: "fechamento" },
];

/**
 * Estágios terminais fixos (estilo Kommo): TODO pipeline termina em
 * "Ganho" e "Perdido", nessa ordem. Mover um deal para eles fecha o
 * negócio (`Deal.status` sincronizado em `moveDeal`). Protegidos contra
 * delete e reorder; estágios novos sempre entram ANTES deles.
 * `rottingDays` alto evita marcar deals fechados como "apodrecendo".
 */
export const TERMINAL_STAGES: Omit<
  Prisma.StageCreateWithoutPipelineInput,
  "pipeline" | "organization" | "position" | "number"
>[] = [
  { name: "Ganho", color: "#16a34a", winProbability: 100, rottingDays: 3650, isWon: true, slug: "ganho" },
  { name: "Perdido", color: "#ef4444", winProbability: 0, rottingDays: 3650, isLost: true, slug: "perdido" },
];

/** Stages default + terminais com position e number sequenciais, prontos pro create. */
function buildDefaultStageCreates(organizationId: string) {
  const base = DEFAULT_STAGES.map((s, i) => ({ ...s, organizationId, number: i + 1 }));
  const terminals = TERMINAL_STAGES.map((s, i) => ({
    ...s,
    position: DEFAULT_STAGES.length + i,
    organizationId,
    number: DEFAULT_STAGES.length + i + 1,
  }));
  return [...base, ...terminals];
}

/** Gera slug único no escopo (org ou pipeline). */
async function allocateUniqueSlug(args: {
  base: string;
  exists: (candidate: string) => Promise<boolean>;
}): Promise<string> {
  const root = slugify(args.base) || "item";
  let candidate = root;
  let n = 1;
  while (await args.exists(candidate)) {
    n += 1;
    candidate = `${root}-${n}`;
  }
  return candidate;
}

async function allocatePipelineSlug(
  organizationId: string,
  name: string,
  excludeId?: string,
): Promise<string> {
  return allocateUniqueSlug({
    base: name,
    exists: async (candidate) => {
      const hit = await prisma.pipeline.findFirst({
        where: {
          organizationId,
          slug: candidate,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true },
      });
      return !!hit;
    },
  });
}

const PIPELINE_NUMBER_MAX_RETRIES = 5;

/**
 * Próximo `Pipeline.number` da org. Schema: `@@unique([organizationId, number])`
 * sem default — Postgres sequences não particionam por coluna. Em corrida o
 * caller faz retry em P2002 (ver `createPipeline` / `ensureDefaultPipeline`).
 */
export async function nextPipelineNumber(
  organizationId: string,
  db?: Prisma.TransactionClient,
): Promise<number> {
  const client = db ?? prisma;
  const r = await client.pipeline.aggregate({
    where: { organizationId },
    _max: { number: true },
  });
  return (r._max.number ?? 0) + 1;
}

function isPipelineNumberUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    message?: string;
    meta?: { target?: string[] | string };
  };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const hasNumber = (s: string) => s === "number" || s.includes("number");
  if (Array.isArray(target)) return target.some((t) => hasNumber(String(t)));
  if (typeof target === "string") return hasNumber(target);
  const msg = typeof e.message === "string" ? e.message : "";
  return /organizationId/i.test(msg) && /[`"']number[`"']/i.test(msg);
}

async function withPipelineNumberRetry<T>(
  organizationId: string,
  fn: (number: number) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < PIPELINE_NUMBER_MAX_RETRIES; attempt++) {
    try {
      const number = await nextPipelineNumber(organizationId);
      return await fn(number);
    } catch (err) {
      lastErr = err;
      if (!isPipelineNumberUniqueViolation(err)) throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Falha ao alocar number de pipeline.");
}

const STAGE_NUMBER_MAX_RETRIES = 5;

/**
 * Próximo `Stage.number` do funil. Schema: `@@unique([pipelineId, number])`
 * sem default. Em corrida o caller faz retry em P2002.
 */
export async function nextStageNumber(
  pipelineId: string,
  db?: Prisma.TransactionClient,
): Promise<number> {
  const client = db ?? prisma;
  const r = await client.stage.aggregate({
    where: { pipelineId },
    _max: { number: true },
  });
  return (r._max.number ?? 0) + 1;
}

export function isStageNumberUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    message?: string;
    meta?: { target?: string[] | string };
  };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const hasNumber = (s: string) => s === "number" || s.includes("number");
  if (Array.isArray(target)) return target.some((t) => hasNumber(String(t)));
  if (typeof target === "string") return hasNumber(target);
  const msg = typeof e.message === "string" ? e.message : "";
  return /pipelineId/i.test(msg) && /[`"']number[`"']/i.test(msg);
}

async function withStageCreateRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < STAGE_NUMBER_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isStageNumberUniqueViolation(err)) throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Falha ao alocar number de estágio.");
}

const CUID_RE = /^c[a-z0-9]{20,}$/i;

/**
 * Resolve ref público de pipeline na org corrente:
 * dígitos → `number`; CUID → `id`; senão slug, depois nome (compat bookmarks).
 */
export async function resolvePipelineByPublicRef(raw: string) {
  const key = raw.trim();
  if (!key) return null;
  const select = { id: true, number: true, slug: true, name: true } as const;
  if (/^\d+$/.test(key)) {
    return prisma.pipeline.findFirst({
      where: { number: Number(key), archivedAt: null },
      select,
    });
  }
  if (CUID_RE.test(key)) {
    return prisma.pipeline.findFirst({
      where: { id: key, archivedAt: null },
      select,
    });
  }
  return (
    (await prisma.pipeline.findFirst({
      where: { slug: key, archivedAt: null },
      select,
    })) ??
    prisma.pipeline.findFirst({
      where: { name: { equals: key, mode: "insensitive" }, archivedAt: null },
      select,
    })
  );
}

/** Funil padrão da org: `isDefault`, senão o mais antigo ainda ativo. */
export async function getDefaultPipelineId(): Promise<string | null> {
  const def =
    (await prisma.pipeline.findFirst({
      where: { isDefault: true, archivedAt: null },
      select: { id: true },
    })) ??
    (await prisma.pipeline.findFirst({
      where: { archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    }));
  return def?.id ?? null;
}

export async function allocateStageSlug(
  pipelineId: string,
  name: string,
  excludeId?: string,
  tx?: Prisma.TransactionClient,
): Promise<string> {
  const db = tx ?? prisma;
  return allocateUniqueSlug({
    base: name,
    exists: async (candidate) => {
      const hit = await db.stage.findFirst({
        where: {
          pipelineId,
          slug: candidate,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true },
      });
      return !!hit;
    },
  });
}

const stageWithCountSelect = {
  id: true,
  name: true,
  slug: true,
  number: true,
  position: true,
  color: true,
  winProbability: true,
  rottingDays: true,
  isIncoming: true,
  isWon: true,
  isLost: true,
  pipelineId: true,
  _count: { select: { deals: true } },
} satisfies Prisma.StageSelect;

export async function ensureDefaultPipeline() {
  const count = await prisma.pipeline.count({ where: { archivedAt: null } });
  if (count > 0) return;
  const organizationId = getOrgIdOrThrow();
  const slug = await allocatePipelineSlug(organizationId, "Pipeline Principal");
  await withPipelineNumberRetry(organizationId, (number) =>
    prisma.pipeline.create({
      data: {
        name: "Pipeline Principal",
        slug,
        number,
        isDefault: true,
        organizationId,
        stages: {
          create: buildDefaultStageCreates(organizationId),
        },
      },
    }),
  );
}

export async function getPipelines(options?: { allowedPipelineIds?: string[] | null }) {
  await ensureDefaultPipeline();

  // `allowedPipelineIds === null/undefined` → sem restrição (todos). Array
  // (mesmo vazio) → restringe ao escopo do usuário.
  const allowed = options?.allowedPipelineIds;
  const where: Prisma.PipelineWhereInput = allowed
    ? { id: { in: allowed }, archivedAt: null }
    : { archivedAt: null };

  // Select explícito — NÃO usar include sem select no Pipeline.
  // Colunas novas no schema (ex.: lossReasonAllowOther) sem migrate deploy
  // derrubavam o GET /api/pipelines inteiro e o front ficava sem funis.
  const pipelines = await prisma.pipeline.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      number: true,
      isDefault: true,
      createdAt: true,
      updatedAt: true,
      organizationId: true,
      stages: {
        orderBy: { position: "asc" },
        select: stageWithCountSelect,
      },
    },
  });

  return pipelines.map((p) => ({
    ...p,
    stages: p.stages.map((s) => {
      const { _count, ...rest } = s;
      return { ...rest, dealCount: _count.deals };
    }),
  }));
}

const dealListInclude = {
  contact: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true } },
  owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
} satisfies Prisma.DealInclude;

export async function getPipelineMeta(id: string) {
  return prisma.pipeline.findFirst({
    where: { id, archivedAt: null },
    select: { id: true, name: true, slug: true, number: true, isDefault: true },
  });
}

export async function getPipelineById(id: string) {
  const pipeline = await prisma.pipeline.findFirst({
    where: { id, archivedAt: null },
    include: {
      stages: {
        orderBy: { position: "asc" },
        include: {
          deals: {
            orderBy: { position: "asc" },
            include: dealListInclude,
          },
        },
      },
    },
  });
  return pipeline;
}

export async function createPipeline(data: { name: string }) {
  const name = data.name.trim();
  if (!name) {
    throw new Error("INVALID_NAME");
  }

  const organizationId = getOrgIdOrThrow();
  const slug = await allocatePipelineSlug(organizationId, name);
  return withPipelineNumberRetry(organizationId, (number) =>
    prisma.pipeline.create({
      data: {
        name,
        slug,
        number,
        organizationId,
        stages: {
          create: buildDefaultStageCreates(organizationId),
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        number: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
        organizationId: true,
        stages: {
          orderBy: { position: "asc" },
          select: stageWithCountSelect,
        },
      },
    }),
  );
}

export type UpdatePipelineInput = {
  name?: string;
  isDefault?: boolean;
};

export async function updatePipeline(id: string, data: UpdatePipelineInput) {
  const payload: Prisma.PipelineUpdateInput = {};

  if (data.name !== undefined) {
    const name = data.name.trim();
    if (!name) throw new Error("INVALID_NAME");
    const organizationId = getOrgIdOrThrow();
    payload.name = name;
    payload.slug = await allocatePipelineSlug(organizationId, name, id);
  }
  if (data.isDefault !== undefined) {
    payload.isDefault = data.isDefault;
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("EMPTY_UPDATE");
  }

  if (data.isDefault === true) {
    return prisma.$transaction(async (tx) => {
      await tx.pipeline.updateMany({
        where: { id: { not: id } },
        data: { isDefault: false },
      });
      return tx.pipeline.update({
        where: { id },
        data: payload,
        include: { stages: { orderBy: { position: "asc" } } },
      });
    });
  }

  return prisma.pipeline.update({
    where: { id },
    data: payload,
    include: { stages: { orderBy: { position: "asc" } } },
  });
}

export async function deletePipeline(id: string) {
  await prisma.pipeline.delete({ where: { id } });
}

/**
 * Soft-archive: "apagar pipeline" no CRM seta `archivedAt` em vez de
 * DELETE — stages/deals permanecem no banco, só o pipeline some das
 * listagens (`getPipelines`/`getPipelineById` já filtram `archivedAt: null`).
 *
 * Throws: NOT_FOUND | ALREADY_ARCHIVED | LAST_PIPELINE
 */
export async function archivePipeline(id: string): Promise<void> {
  const pipeline = await prisma.pipeline.findUnique({
    where: { id },
    select: { id: true, organizationId: true, isDefault: true, archivedAt: true },
  });
  if (!pipeline) throw new Error("NOT_FOUND");
  if (pipeline.archivedAt) throw new Error("ALREADY_ARCHIVED");

  const activeCount = await prisma.pipeline.count({
    where: { organizationId: pipeline.organizationId, archivedAt: null },
  });
  if (activeCount <= 1) throw new Error("LAST_PIPELINE");

  await prisma.$transaction(async (tx) => {
    if (pipeline.isDefault) {
      const nextDefault = await tx.pipeline.findFirst({
        where: {
          organizationId: pipeline.organizationId,
          archivedAt: null,
          id: { not: id },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (nextDefault) {
        await tx.pipeline.update({
          where: { id: nextDefault.id },
          data: { isDefault: true },
        });
      }
    }

    await tx.pipeline.update({
      where: { id },
      data: { archivedAt: new Date(), isDefault: false },
    });
  });
}

export type CreateStageInput = {
  name: string;
  color?: string;
  winProbability?: number;
  rottingDays?: number;
  position?: number;
};

export async function createStage(pipelineId: string, data: CreateStageInput) {
  const name = data.name.trim();
  if (!name) throw new Error("INVALID_NAME");

  return withStageCreateRetry(() =>
    prisma.$transaction(async (tx) => {
      const max = await tx.stage.aggregate({
        where: { pipelineId },
        _max: { position: true },
      });
      const maxPos = max._max.position ?? -1;
      // Estágios novos NUNCA entram depois dos terminais fixos (Ganho/
      // Perdido) — o default é "antes do primeiro terminal" e posições
      // explícitas são clampadas pra esse limite.
      const firstTerminal = await tx.stage.findFirst({
        where: { pipelineId, OR: [{ isWon: true }, { isLost: true }] },
        orderBy: { position: "asc" },
        select: { position: true },
      });
      const next = firstTerminal ? firstTerminal.position : maxPos + 1;
      const position =
        data.position !== undefined ? Math.min(data.position, next) : next;

      if (position <= maxPos) {
        // Shift em 2 passos (offset alto) pra não violar a unique
        // (pipelineId, position) durante o updateMany — mesmo truque
        // do reorderStages.
        await tx.stage.updateMany({
          where: { pipelineId, position: { gte: position } },
          data: { position: { increment: 10_000 } },
        });
        await tx.stage.updateMany({
          where: { pipelineId, position: { gte: 10_000 } },
          data: { position: { decrement: 9_999 } },
        });
      }

      const slug = await allocateStageSlug(pipelineId, name, undefined, tx);
      const number = await nextStageNumber(pipelineId, tx);

      return tx.stage.create({
        data: {
          name,
          slug,
          number,
          position,
          pipelineId,
          organizationId: getOrgIdOrThrow(),
          color: data.color ?? "#6366f1",
          winProbability: data.winProbability ?? 0,
          rottingDays: data.rottingDays ?? 30,
        },
      });
    }),
  );
}

export type UpdateStageInput = {
  name?: string;
  color?: string;
  winProbability?: number;
  rottingDays?: number;
  position?: number;
};

export async function updateStage(id: string, data: UpdateStageInput) {
  const hasField =
    data.name !== undefined ||
    data.color !== undefined ||
    data.winProbability !== undefined ||
    data.rottingDays !== undefined ||
    data.position !== undefined;
  if (!hasField) throw new Error("EMPTY_UPDATE");

  const stage = await prisma.stage.findUnique({ where: { id } });
  if (!stage) throw new Error("NOT_FOUND");

  // Terminais fixos (Ganho/Perdido) não saem do fim do pipeline.
  if ((stage.isWon || stage.isLost) && data.position !== undefined && data.position !== stage.position) {
    throw new Error("CANNOT_MOVE_TERMINAL_STAGE");
  }

  if (data.position !== undefined && data.position !== stage.position) {
    const stages = await prisma.stage.findMany({
      where: { pipelineId: stage.pipelineId },
      orderBy: { position: "asc" },
      select: { id: true },
    });
    const ids = stages.map((s) => s.id);
    const from = ids.indexOf(id);
    if (from === -1) throw new Error("NOT_FOUND");
    ids.splice(from, 1);
    const clamped = Math.min(Math.max(0, data.position), ids.length);
    ids.splice(clamped, 0, id);
    await reorderStages(stage.pipelineId, ids);
  }

  const payload: Prisma.StageUpdateInput = {};

  if (data.name !== undefined) {
    const name = data.name.trim();
    if (!name) throw new Error("INVALID_NAME");
    payload.name = name;
    payload.slug = await allocateStageSlug(stage.pipelineId, name, id);
  }
  if (data.color !== undefined) payload.color = data.color;
  if (data.winProbability !== undefined) payload.winProbability = data.winProbability;
  if (data.rottingDays !== undefined) payload.rottingDays = data.rottingDays;

  if (Object.keys(payload).length === 0) {
    return prisma.stage.findUniqueOrThrow({ where: { id } });
  }

  return prisma.stage.update({
    where: { id },
    data: payload,
  });
}

export async function getStageInPipeline(pipelineId: string, stageId: string) {
  return prisma.stage.findFirst({
    where: { id: stageId, pipelineId },
  });
}

export async function deleteStage(id: string) {
  const stage = await prisma.stage.findUnique({
    where: { id },
    select: { isIncoming: true, isWon: true, isLost: true },
  });
  if (stage?.isIncoming) {
    throw new Error("CANNOT_DELETE_INCOMING_STAGE");
  }
  if (stage?.isWon || stage?.isLost) {
    throw new Error("CANNOT_DELETE_TERMINAL_STAGE");
  }
  const count = await prisma.deal.count({ where: { stageId: id } });
  if (count > 0) {
    throw new Error("STAGE_HAS_DEALS");
  }
  await prisma.stage.delete({ where: { id } });
}

export async function reorderStages(pipelineId: string, stageIds: string[]) {
  const stages = await prisma.stage.findMany({
    where: { pipelineId },
    select: { id: true, isWon: true, isLost: true },
    orderBy: { position: "asc" },
  });

  const existingIds = new Set(stages.map((s) => s.id));
  if (stageIds.length !== existingIds.size || stageIds.some((id) => !existingIds.has(id))) {
    throw new Error("INVALID_STAGE_ORDER");
  }

  // Terminais fixos sempre fecham o pipeline na ordem Ganho → Perdido,
  // independente da ordem pedida. Normaliza em vez de rejeitar pra
  // manter compat com clientes que enviam a lista completa.
  const wonIds = stages.filter((s) => s.isWon).map((s) => s.id);
  const lostIds = stages.filter((s) => s.isLost).map((s) => s.id);
  const terminalSet = new Set([...wonIds, ...lostIds]);
  const ordered = [
    ...stageIds.filter((id) => !terminalSet.has(id)),
    ...wonIds,
    ...lostIds,
  ];

  const offset = 10_000;

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < ordered.length; i++) {
      await tx.stage.update({
        where: { id: ordered[i] },
        data: { position: offset + i },
      });
    }
    for (let i = 0; i < ordered.length; i++) {
      await tx.stage.update({
        where: { id: ordered[i] },
        data: { position: i },
      });
    }
  });
}
