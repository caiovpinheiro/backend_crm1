/**
 * Demandas — boards internos (Roadmap / Bugs / Suporte).
 *
 * Primeiro GET de uma org materializa os 3 boards padrão. Cards têm
 * número sequencial por org, votos, comentários e log de eventos.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { seedDemandMocksIfEmpty } from "@/services/demands-mock-seed";

const USER_LITE = { select: { id: true, name: true, avatarUrl: true } } as const;

export const ITEM_KINDS = [
  "FEATURE",
  "IMPROVEMENT",
  "BUG",
  "REQUEST",
  "TASK",
] as const;
export type DemandItemKind = (typeof ITEM_KINDS)[number];

export const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type DemandPriority = (typeof PRIORITIES)[number];

type StageSeed = {
  name: string;
  key: string;
  color: string;
  isTerminal?: boolean;
};

type BoardSeed = {
  name: string;
  slug: string;
  kind: string;
  color: string;
  description: string;
  stages: StageSeed[];
};

const DEFAULT_BOARDS: BoardSeed[] = [
  {
    name: "Roadmap",
    slug: "roadmap",
    kind: "ROADMAP",
    color: "#5b6ff5",
    description: "Demandas de produto, melhorias e solicitações do time.",
    stages: [
      { name: "Ideias", key: "ideas", color: "#64748b" },
      { name: "Triagem", key: "triage", color: "#f59e0b" },
      { name: "Análise", key: "analysis", color: "#8b5cf6" },
      { name: "Planejado", key: "planned", color: "#3b82f6" },
      { name: "Em desenvolvimento", key: "in_progress", color: "#6366f1" },
      { name: "Teste", key: "test", color: "#06b6d4" },
      { name: "Lançado", key: "done", color: "#22c55e", isTerminal: true },
    ],
  },
  {
    name: "Bugs",
    slug: "bugs",
    kind: "BUGS",
    color: "#ef4444",
    description: "Defeitos confirmados e correções em andamento.",
    stages: [
      { name: "Aberto", key: "open", color: "#64748b" },
      { name: "Confirmado", key: "confirmed", color: "#f59e0b" },
      { name: "Em correção", key: "fixing", color: "#6366f1" },
      { name: "QA", key: "qa", color: "#06b6d4" },
      { name: "Resolvido", key: "done", color: "#22c55e", isTerminal: true },
    ],
  },
  {
    name: "Suporte",
    slug: "support",
    kind: "SUPPORT",
    color: "#0ea5e9",
    description: "Solicitações internas do time de suporte.",
    stages: [
      { name: "Aberto", key: "open", color: "#64748b" },
      { name: "Em análise", key: "analysis", color: "#f59e0b" },
      { name: "Aguardando", key: "waiting", color: "#8b5cf6" },
      { name: "Resolvido", key: "done", color: "#22c55e", isTerminal: true },
    ],
  },
];

const ITEM_SELECT = {
  id: true,
  number: true,
  title: true,
  description: true,
  kind: true,
  priority: true,
  position: true,
  votesCount: true,
  tags: true,
  boardId: true,
  stageId: true,
  requesterId: true,
  assigneeId: true,
  dueAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  requester: USER_LITE,
  assignee: USER_LITE,
} as const;

function slugify(input: string): string {
  const base = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return base || `board-${Date.now().toString(36)}`;
}

async function demandBoardsTableExists(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'demand_boards'
    ) AS exists
  `;
  return Boolean(rows[0]?.exists);
}

/** Cria as tabelas se o migrate deploy do Dev ainda não as aplicou. */
async function ensureDemandTables() {
  if (await demandBoardsTableExists()) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS "demand_boards" (
      "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "name" TEXT NOT NULL,
      "slug" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
      "description" TEXT, "color" TEXT, "position" INTEGER NOT NULL DEFAULT 0,
      "isDefault" BOOLEAN NOT NULL DEFAULT false, "archivedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "demand_boards_pkey" PRIMARY KEY ("id"))`,
    `CREATE TABLE IF NOT EXISTS "demand_stages" (
      "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "boardId" TEXT NOT NULL,
      "name" TEXT NOT NULL, "key" TEXT NOT NULL, "color" TEXT,
      "position" INTEGER NOT NULL DEFAULT 0, "isTerminal" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "demand_stages_pkey" PRIMARY KEY ("id"))`,
    `CREATE TABLE IF NOT EXISTS "demand_items" (
      "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "boardId" TEXT NOT NULL,
      "stageId" TEXT NOT NULL, "number" INTEGER NOT NULL, "title" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '', "kind" TEXT NOT NULL DEFAULT 'REQUEST',
      "priority" TEXT NOT NULL DEFAULT 'NONE', "position" DOUBLE PRECISION NOT NULL DEFAULT 1000,
      "votesCount" INTEGER NOT NULL DEFAULT 0, "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "requesterId" TEXT NOT NULL, "assigneeId" TEXT, "dueAt" TIMESTAMP(3),
      "completedAt" TIMESTAMP(3), "archivedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "demand_items_pkey" PRIMARY KEY ("id"))`,
    `CREATE TABLE IF NOT EXISTS "demand_comments" (
      "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "itemId" TEXT NOT NULL,
      "authorId" TEXT NOT NULL, "content" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "demand_comments_pkey" PRIMARY KEY ("id"))`,
    `CREATE TABLE IF NOT EXISTS "demand_votes" (
      "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "itemId" TEXT NOT NULL,
      "userId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "demand_votes_pkey" PRIMARY KEY ("id"))`,
    `CREATE TABLE IF NOT EXISTS "demand_events" (
      "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "itemId" TEXT NOT NULL,
      "actorId" TEXT, "type" TEXT NOT NULL, "payload" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "demand_events_pkey" PRIMARY KEY ("id"))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "demand_boards_organizationId_slug_key" ON "demand_boards"("organizationId", "slug")`,
    `CREATE INDEX IF NOT EXISTS "demand_boards_organizationId_archivedAt_idx" ON "demand_boards"("organizationId", "archivedAt")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "demand_stages_boardId_key_key" ON "demand_stages"("boardId", "key")`,
    `CREATE INDEX IF NOT EXISTS "demand_stages_organizationId_boardId_idx" ON "demand_stages"("organizationId", "boardId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "demand_items_organizationId_number_key" ON "demand_items"("organizationId", "number")`,
    `CREATE INDEX IF NOT EXISTS "demand_items_organizationId_boardId_stageId_idx" ON "demand_items"("organizationId", "boardId", "stageId")`,
    `CREATE INDEX IF NOT EXISTS "demand_items_organizationId_assigneeId_idx" ON "demand_items"("organizationId", "assigneeId")`,
    `CREATE INDEX IF NOT EXISTS "demand_items_boardId_stageId_position_idx" ON "demand_items"("boardId", "stageId", "position")`,
    `CREATE INDEX IF NOT EXISTS "demand_comments_itemId_createdAt_idx" ON "demand_comments"("itemId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "demand_comments_organizationId_idx" ON "demand_comments"("organizationId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "demand_votes_itemId_userId_key" ON "demand_votes"("itemId", "userId")`,
    `CREATE INDEX IF NOT EXISTS "demand_votes_organizationId_idx" ON "demand_votes"("organizationId")`,
    `CREATE INDEX IF NOT EXISTS "demand_events_itemId_createdAt_idx" ON "demand_events"("itemId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "demand_events_organizationId_idx" ON "demand_events"("organizationId")`,
  ];
  for (const sql of stmts) {
    await prisma.$executeRawUnsafe(sql);
  }
}

export async function ensureDefaultBoards() {
  await ensureDemandTables();
  const existing = await prisma.demandBoard.count();
  if (existing > 0) return;

  for (let i = 0; i < DEFAULT_BOARDS.length; i++) {
    const seed = DEFAULT_BOARDS[i]!;
    await prisma.demandBoard.create({
      data: withOrgFromCtx({
        name: seed.name,
        slug: seed.slug,
        kind: seed.kind,
        color: seed.color,
        description: seed.description,
        position: (i + 1) * 1000,
        isDefault: true,
        stages: {
          create: seed.stages.map((s, idx) =>
            withOrgFromCtx({
              name: s.name,
              key: s.key,
              color: s.color,
              position: (idx + 1) * 1000,
              isTerminal: s.isTerminal ?? false,
            }),
          ),
        },
      }),
    });
  }
}

export async function listBoards() {
  await ensureDefaultBoards();
  try {
    await seedDemandMocksIfEmpty();
  } catch (err) {
    console.error("[demands] seed mock failed", err);
  }
  const boards = await prisma.demandBoard.findMany({
    where: { archivedAt: null },
    orderBy: { position: "asc" },
    include: {
      stages: { orderBy: { position: "asc" } },
      _count: { select: { items: { where: { archivedAt: null } } } },
    },
  });
  return boards.map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
    kind: b.kind,
    color: b.color,
    description: b.description,
    position: b.position,
    isDefault: b.isDefault,
    itemCount: b._count.items,
    stages: b.stages.map((s) => ({
      id: s.id,
      name: s.name,
      key: s.key,
      color: s.color,
      position: s.position,
      isTerminal: s.isTerminal,
    })),
  }));
}

export async function createBoard(input: {
  name: string;
  kind?: string;
  description?: string;
  color?: string;
}) {
  const name = input.name.trim();
  let slug = slugify(name);
  const clash = await prisma.demandBoard.findFirst({
    where: { slug },
    select: { id: true },
  });
  if (clash) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

  const last = await prisma.demandBoard.aggregate({ _max: { position: true } });
  const stages = DEFAULT_BOARDS[0]!.stages;

  return prisma.demandBoard.create({
    data: withOrgFromCtx({
      name,
      slug,
      kind: input.kind?.trim() || "CUSTOM",
      description: input.description?.trim() || null,
      color: input.color?.trim() || "#5b6ff5",
      position: (last._max.position ?? 0) + 1000,
      isDefault: false,
      stages: {
        create: stages.map((s, idx) =>
          withOrgFromCtx({
            name: s.name,
            key: s.key,
            color: s.color,
            position: (idx + 1) * 1000,
            isTerminal: s.isTerminal ?? false,
          }),
        ),
      },
    }),
    include: { stages: { orderBy: { position: "asc" } } },
  });
}

export async function getBoard(boardId: string) {
  await ensureDefaultBoards();
  try {
    await seedDemandMocksIfEmpty();
  } catch (err) {
    console.error("[demands] seed mock failed", err);
  }
  const board = await prisma.demandBoard.findFirst({
    where: { id: boardId, archivedAt: null },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!board) return null;

  const items = await prisma.demandItem.findMany({
    where: { boardId, archivedAt: null },
    orderBy: { position: "asc" },
    select: ITEM_SELECT,
  });

  return {
    id: board.id,
    name: board.name,
    slug: board.slug,
    kind: board.kind,
    color: board.color,
    description: board.description,
    isDefault: board.isDefault,
    stages: board.stages.map((s) => ({
      id: s.id,
      name: s.name,
      key: s.key,
      color: s.color,
      position: s.position,
      isTerminal: s.isTerminal,
      items: items.filter((it) => it.stageId === s.id),
    })),
  };
}

export async function addStage(
  boardId: string,
  input: { name: string; color?: string },
) {
  const board = await prisma.demandBoard.findFirst({
    where: { id: boardId, archivedAt: null },
    select: { id: true },
  });
  if (!board) return null;
  const last = await prisma.demandStage.aggregate({
    where: { boardId },
    _max: { position: true },
  });
  const name = input.name.trim();
  let key = slugify(name);
  const clash = await prisma.demandStage.findFirst({
    where: { boardId, key },
    select: { id: true },
  });
  if (clash) key = `${key}-${Date.now().toString(36).slice(-3)}`;
  return prisma.demandStage.create({
    data: withOrgFromCtx({
      boardId,
      name,
      key,
      color: input.color?.trim() || "#64748b",
      position: (last._max.position ?? 0) + 1000,
    }),
  });
}

/** Apaga items → stages → board. stageId é onDelete: Restrict. */
export async function deleteBoard(boardId: string): Promise<boolean> {
  const board = await prisma.demandBoard.findFirst({
    where: { id: boardId },
    select: { id: true },
  });
  if (!board) return false;

  await prisma.$transaction(async (tx) => {
    await tx.demandItem.deleteMany({ where: { boardId } });
    await tx.demandStage.deleteMany({ where: { boardId } });
    await tx.demandBoard.delete({ where: { id: boardId } });
  });
  return true;
}

async function nextItemNumber(): Promise<number> {
  const last = await prisma.demandItem.aggregate({ _max: { number: true } });
  return (last._max.number ?? 0) + 1;
}

async function nextItemPosition(stageId: string): Promise<number> {
  const last = await prisma.demandItem.aggregate({
    where: { stageId, archivedAt: null },
    _max: { position: true },
  });
  return (last._max.position ?? 0) + 1000;
}

async function writeEvent(input: {
  itemId: string;
  actorId: string | null;
  type: string;
  payload?: Record<string, unknown>;
}) {
  await prisma.demandEvent.create({
    data: withOrgFromCtx({
      itemId: input.itemId,
      actorId: input.actorId,
      type: input.type,
      payload: input.payload ?? undefined,
    }),
  });
}

export async function createItem(
  actorId: string,
  input: {
    boardId: string;
    title: string;
    description?: string;
    kind?: string;
    priority?: string;
    stageId?: string;
    assigneeId?: string | null;
    tags?: string[];
  },
) {
  const board = await prisma.demandBoard.findFirst({
    where: { id: input.boardId, archivedAt: null },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!board) return { error: "Board não encontrado." as const, status: 404 };

  const stage =
    (input.stageId
      ? board.stages.find((s) => s.id === input.stageId)
      : board.stages[0]) ?? null;
  if (!stage) return { error: "Fase inválida." as const, status: 400 };

  const kind = ITEM_KINDS.includes(input.kind as DemandItemKind)
    ? (input.kind as DemandItemKind)
    : board.kind === "BUGS"
      ? "BUG"
      : "REQUEST";
  const priority = PRIORITIES.includes(input.priority as DemandPriority)
    ? (input.priority as DemandPriority)
    : "NONE";

  const item = await prisma.demandItem.create({
    data: withOrgFromCtx({
      boardId: board.id,
      stageId: stage.id,
      number: await nextItemNumber(),
      title: input.title.trim(),
      description: (input.description ?? "").trim(),
      kind,
      priority,
      position: await nextItemPosition(stage.id),
      requesterId: actorId,
      assigneeId: input.assigneeId || null,
      tags: input.tags?.filter(Boolean) ?? [],
    }),
    select: ITEM_SELECT,
  });
  await writeEvent({
    itemId: item.id,
    actorId,
    type: "CREATED",
    payload: { stageId: stage.id, stageName: stage.name },
  });
  return { item };
}

export async function getItem(itemId: string, viewerId: string) {
  const item = await prisma.demandItem.findFirst({
    where: { id: itemId, archivedAt: null },
    select: {
      ...ITEM_SELECT,
      comments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          content: true,
          createdAt: true,
          author: USER_LITE,
        },
      },
      events: {
        orderBy: { createdAt: "desc" },
        take: 40,
        select: {
          id: true,
          type: true,
          payload: true,
          createdAt: true,
          actor: USER_LITE,
        },
      },
      votes: {
        where: { userId: viewerId },
        select: { id: true },
      },
    },
  });
  if (!item) return null;
  const { votes, ...rest } = item;
  return { ...rest, votedByMe: votes.length > 0 };
}

export async function updateItem(
  actorId: string,
  itemId: string,
  patch: {
    title?: string;
    description?: string;
    kind?: string;
    priority?: string;
    assigneeId?: string | null;
    tags?: string[];
    dueAt?: string | null;
  },
) {
  const current = await prisma.demandItem.findFirst({
    where: { id: itemId, archivedAt: null },
    select: { id: true, assigneeId: true },
  });
  if (!current) return null;

  const data: Record<string, unknown> = {};
  if (typeof patch.title === "string") data.title = patch.title.trim();
  if (typeof patch.description === "string") data.description = patch.description;
  if (patch.kind && ITEM_KINDS.includes(patch.kind as DemandItemKind)) {
    data.kind = patch.kind;
  }
  if (patch.priority && PRIORITIES.includes(patch.priority as DemandPriority)) {
    data.priority = patch.priority;
  }
  if (patch.assigneeId !== undefined) {
    data.assigneeId = patch.assigneeId || null;
  }
  if (patch.tags) data.tags = patch.tags.filter(Boolean);
  if (patch.dueAt !== undefined) {
    data.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
  }

  const item = await prisma.demandItem.update({
    where: { id: itemId },
    data,
    select: ITEM_SELECT,
  });

  if (patch.assigneeId !== undefined && patch.assigneeId !== current.assigneeId) {
    await writeEvent({
      itemId,
      actorId,
      type: "ASSIGNED",
      payload: { assigneeId: patch.assigneeId },
    });
  } else {
    await writeEvent({ itemId, actorId, type: "UPDATED", payload: patch });
  }
  return item;
}

export async function deleteItem(itemId: string): Promise<boolean> {
  const item = await prisma.demandItem.findFirst({
    where: { id: itemId },
    select: { id: true },
  });
  if (!item) return false;
  await prisma.demandItem.delete({ where: { id: itemId } });
  return true;
}

export async function moveItem(
  actorId: string,
  itemId: string,
  input: { stageId: string; beforeId?: string | null; afterId?: string | null },
) {
  const item = await prisma.demandItem.findFirst({
    where: { id: itemId, archivedAt: null },
    select: { id: true, boardId: true, stageId: true },
  });
  if (!item) return { error: "Demanda não encontrada." as const, status: 404 };

  const stage = await prisma.demandStage.findFirst({
    where: { id: input.stageId, boardId: item.boardId },
  });
  if (!stage) return { error: "Fase inválida." as const, status: 400 };

  let position = 1000;
  if (input.afterId || input.beforeId) {
    const [after, before] = await Promise.all([
      input.afterId
        ? prisma.demandItem.findFirst({
            where: { id: input.afterId, boardId: item.boardId },
            select: { position: true },
          })
        : null,
      input.beforeId
        ? prisma.demandItem.findFirst({
            where: { id: input.beforeId, boardId: item.boardId },
            select: { position: true },
          })
        : null,
    ]);
    const a = after?.position;
    const b = before?.position;
    if (a != null && b != null) position = (a + b) / 2;
    else if (a != null) position = a + 1000;
    else if (b != null) position = b / 2;
  } else {
    position = await nextItemPosition(stage.id);
  }

  const updated = await prisma.demandItem.update({
    where: { id: itemId },
    data: {
      stageId: stage.id,
      position,
      completedAt: stage.isTerminal ? new Date() : null,
    },
    select: ITEM_SELECT,
  });

  if (item.stageId !== stage.id) {
    await writeEvent({
      itemId,
      actorId,
      type: stage.isTerminal ? "COMPLETED" : "MOVED",
      payload: { fromStageId: item.stageId, toStageId: stage.id, toStageName: stage.name },
    });
  }
  return { item: updated };
}

export async function addComment(actorId: string, itemId: string, content: string) {
  const item = await prisma.demandItem.findFirst({
    where: { id: itemId, archivedAt: null },
    select: { id: true },
  });
  if (!item) return null;
  const comment = await prisma.demandComment.create({
    data: withOrgFromCtx({
      itemId,
      authorId: actorId,
      content: content.trim(),
    }),
    select: {
      id: true,
      content: true,
      createdAt: true,
      author: USER_LITE,
    },
  });
  await writeEvent({
    itemId,
    actorId,
    type: "COMMENTED",
    payload: { commentId: comment.id },
  });
  return comment;
}

export async function toggleVote(userId: string, itemId: string) {
  const item = await prisma.demandItem.findFirst({
    where: { id: itemId, archivedAt: null },
    select: { id: true, votesCount: true },
  });
  if (!item) return null;

  const existing = await prisma.demandVote.findFirst({
    where: { itemId, userId },
    select: { id: true },
  });

  if (existing) {
    await prisma.demandVote.delete({ where: { id: existing.id } });
    const updated = await prisma.demandItem.update({
      where: { id: itemId },
      data: { votesCount: { decrement: 1 } },
      select: ITEM_SELECT,
    });
    return { item: updated, votedByMe: false };
  }

  await prisma.demandVote.create({
    data: withOrgFromCtx({ itemId, userId }),
  });
  const updated = await prisma.demandItem.update({
    where: { id: itemId },
    data: { votesCount: { increment: 1 } },
    select: ITEM_SELECT,
  });
  await writeEvent({ itemId, actorId: userId, type: "VOTED" });
  return { item: updated, votedByMe: true };
}
