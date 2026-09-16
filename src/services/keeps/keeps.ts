import { prisma } from "@/lib/prisma";
import { buildPublicUrl, generateFileName, saveFile } from "@/lib/storage/local";
import { asJson, EMPTY_DOC, normalizeDoc, plainTextFromDoc, type KeepDoc } from "./doc";
import { type KeepNoteColorId } from "./colors";

export type KeepFolder = "notes" | "archive" | "trash";

export class KeepError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function folderWhere(folder: KeepFolder) {
  if (folder === "archive") return { trashed: false, archived: true };
  if (folder === "trash") return { trashed: true };
  return { trashed: false, archived: false };
}

function serializeNote<
  T extends {
    id: string;
    title: string;
    content: unknown;
    plainText: string;
    pinned: boolean;
    archived: boolean;
    trashed: boolean;
    trashedAt: Date | null;
    color: string | null;
    source: string;
    categoryId: string | null;
    importBatchId: string | null;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    attachments?: Array<{
      id: string;
      fileName: string;
      mimeType: string;
      fileSize: number;
      storageKey: string;
      createdAt: Date;
    }>;
  },
>(note: T, orgId: string) {
  return {
    id: note.id,
    title: note.title,
    content: normalizeDoc(note.content),
    plainText: note.plainText,
    pinned: note.pinned,
    archived: note.archived,
    trashed: note.trashed,
    trashedAt: note.trashedAt?.toISOString() ?? null,
    source: note.source,
    color: note.color ?? null,
    categoryId: note.categoryId ?? null,
    importBatchId: note.importBatchId,
    position: note.position,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    attachments: (note.attachments ?? []).map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      fileSize: a.fileSize,
      url: buildPublicUrl(orgId, "keeps", a.storageKey),
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

const includeAtt = { attachments: { orderBy: { createdAt: "asc" as const } } };

export async function listKeepNotes(opts: {
  userId: string;
  folder: KeepFolder;
  q?: string;
  colors?: Array<KeepNoteColorId | "none">;
}) {
  const q = opts.q?.trim();
  const colorClause =
    opts.colors && opts.colors.length > 0
      ? { OR: opts.colors.map((c) => (c === "none" ? { color: null } : { color: c })) }
      : null;
  const searchClause = q
    ? {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { plainText: { contains: q, mode: "insensitive" } },
        ],
      }
    : null;
  const folder = folderWhere(opts.folder);
  const and = [colorClause, searchClause].filter(Boolean) as object[];
  const rows = await prisma.keepNote.findMany({
    where: {
      userId: opts.userId,
      ...folder,
      ...(and.length ? { AND: and } : {}),
    },
    include: includeAtt,
    orderBy: [{ pinned: "desc" }, { position: "asc" }, { updatedAt: "desc" }],
    take: 500,
  });
  const usedRows = await prisma.keepNote.findMany({
    where: { userId: opts.userId, ...folder },
    select: { color: true },
    distinct: ["color"],
  });
  const usedColors = usedRows
    .map((r) => r.color)
    .filter((c): c is string => Boolean(c));
  const hasUncolored = usedRows.some((r) => r.color == null);
  return { rows, usedColors, hasUncolored };
}

export async function getKeepNote(opts: { userId: string; id: string }) {
  const note = await prisma.keepNote.findFirst({
    where: { id: opts.id, userId: opts.userId },
    include: includeAtt,
  });
  if (!note) throw new KeepError("Nota não encontrada.", 404);
  return note;
}

async function assertOwnedCategory(opts: {
  userId: string;
  categoryId: string | null | undefined;
}) {
  if (opts.categoryId == null) return null;
  const cat = await prisma.keepCategory.findFirst({
    where: { id: opts.categoryId, userId: opts.userId },
    select: { id: true },
  });
  if (!cat) throw new KeepError("Categoria não encontrada.", 404);
  return cat.id;
}

export async function createKeepNote(opts: {
  orgId: string;
  userId: string;
  title?: string;
  content?: unknown;
  source?: string;
  importBatchId?: string | null;
  categoryId?: string | null;
}) {
  const content = normalizeDoc(opts.content);
  const categoryId = await assertOwnedCategory({
    userId: opts.userId,
    categoryId: opts.categoryId,
  });
  const minPos = await prisma.keepNote.aggregate({
    where: {
      userId: opts.userId,
      trashed: false,
      archived: false,
      ...(categoryId !== undefined ? { categoryId } : {}),
    },
    _min: { position: true },
  });
  const position = (minPos._min.position ?? 1000) - 1000;
  return prisma.keepNote.create({
    data: {
      organizationId: opts.orgId,
      userId: opts.userId,
      title: (opts.title ?? "").slice(0, 240),
      content: asJson(content),
      plainText: plainTextFromDoc(content),
      source: opts.source ?? "manual",
      importBatchId: opts.importBatchId ?? null,
      categoryId,
      position,
    },
    include: includeAtt,
  });
}

export async function updateKeepNote(opts: {
  orgId: string;
  userId: string;
  id: string;
  title?: string;
  content?: unknown;
  pinned?: boolean;
  archived?: boolean;
  trashed?: boolean;
  color?: KeepNoteColorId | null;
  categoryId?: string | null;
}) {
  const existing = await prisma.keepNote.findFirst({
    where: { id: opts.id, userId: opts.userId },
  });
  if (!existing) throw new KeepError("Nota não encontrada.", 404);

  let content: KeepDoc | undefined;
  let plainText: string | undefined;
  if (opts.content !== undefined) {
    content = normalizeDoc(opts.content);
    plainText = plainTextFromDoc(content);
  }

  let categoryId: string | null | undefined;
  if (opts.categoryId !== undefined) {
    categoryId = await assertOwnedCategory({
      userId: opts.userId,
      categoryId: opts.categoryId,
    });
  }

  const trashed = opts.trashed;
  return prisma.keepNote.update({
    where: { id: existing.id },
    data: {
      ...(opts.title !== undefined ? { title: opts.title.slice(0, 240) } : {}),
      ...(content ? { content: asJson(content), plainText } : {}),
      ...(opts.pinned !== undefined ? { pinned: opts.pinned } : {}),
      ...(opts.archived !== undefined ? { archived: opts.archived, trashed: false, trashedAt: null } : {}),
      ...(trashed === true ? { trashed: true, archived: false, pinned: false, trashedAt: new Date() } : {}),
      ...(trashed === false ? { trashed: false, trashedAt: null } : {}),
      ...(opts.color !== undefined ? { color: opts.color } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
    },
    include: includeAtt,
  });
}

export async function deleteKeepNote(opts: { userId: string; id: string; forever: boolean }) {
  const existing = await prisma.keepNote.findFirst({
    where: { id: opts.id, userId: opts.userId },
  });
  if (!existing) throw new KeepError("Nota não encontrada.", 404);
  if (!opts.forever && !existing.trashed) {
    return prisma.keepNote.update({
      where: { id: existing.id },
      data: { trashed: true, archived: false, pinned: false, trashedAt: new Date() },
      include: includeAtt,
    });
  }
  await prisma.keepNote.delete({ where: { id: existing.id } });
  return null;
}

export async function reorderKeepNotes(opts: {
  userId: string;
  items: Array<{
    id: string;
    position: number;
    pinned?: boolean;
    categoryId?: string | null;
  }>;
}) {
  if (opts.items.length === 0) return;
  if (opts.items.length > 500) throw new KeepError("Lista grande demais.", 400);
  const ids = opts.items.map((i) => i.id);
  const found = await prisma.keepNote.findMany({
    where: { userId: opts.userId, id: { in: ids } },
    select: { id: true },
  });
  if (found.length !== ids.length) throw new KeepError("Nota não encontrada.", 404);

  const categoryIds = [
    ...new Set(
      opts.items
        .map((i) => i.categoryId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (categoryIds.length > 0) {
    const owned = await prisma.keepCategory.findMany({
      where: { userId: opts.userId, id: { in: categoryIds } },
      select: { id: true },
    });
    if (owned.length !== categoryIds.length) {
      throw new KeepError("Categoria não encontrada.", 404);
    }
  }

  await prisma.$transaction(
    opts.items.map((i) =>
      prisma.keepNote.update({
        where: { id: i.id },
        data: {
          position: i.position,
          ...(i.pinned !== undefined ? { pinned: i.pinned } : {}),
          ...(i.categoryId !== undefined ? { categoryId: i.categoryId } : {}),
        },
      }),
    ),
  );
}

export function serializeKeepCategory(cat: {
  id: string;
  name: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: cat.id,
    name: cat.name,
    position: cat.position,
    createdAt: cat.createdAt.toISOString(),
    updatedAt: cat.updatedAt.toISOString(),
  };
}

export async function listKeepCategories(opts: { userId: string }) {
  return prisma.keepCategory.findMany({
    where: { userId: opts.userId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}

export async function createKeepCategory(opts: {
  orgId: string;
  userId: string;
  name: string;
}) {
  const name = opts.name.trim().slice(0, 80);
  if (!name) throw new KeepError("Nome da categoria obrigatório.", 400);
  const maxPos = await prisma.keepCategory.aggregate({
    where: { userId: opts.userId },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? 0) + 1000;
  return prisma.keepCategory.create({
    data: {
      organizationId: opts.orgId,
      userId: opts.userId,
      name,
      position,
    },
  });
}

export async function updateKeepCategory(opts: {
  userId: string;
  id: string;
  name?: string;
  position?: number;
}) {
  const existing = await prisma.keepCategory.findFirst({
    where: { id: opts.id, userId: opts.userId },
  });
  if (!existing) throw new KeepError("Categoria não encontrada.", 404);
  const name =
    opts.name !== undefined ? opts.name.trim().slice(0, 80) : undefined;
  if (name !== undefined && !name) throw new KeepError("Nome da categoria obrigatório.", 400);
  return prisma.keepCategory.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(opts.position !== undefined ? { position: opts.position } : {}),
    },
  });
}

export async function deleteKeepCategory(opts: { userId: string; id: string }) {
  const existing = await prisma.keepCategory.findFirst({
    where: { id: opts.id, userId: opts.userId },
  });
  if (!existing) throw new KeepError("Categoria não encontrada.", 404);
  await prisma.$transaction([
    prisma.keepNote.updateMany({
      where: { userId: opts.userId, categoryId: existing.id },
      data: { categoryId: null },
    }),
    prisma.keepCategory.delete({ where: { id: existing.id } }),
  ]);
}

const MAX_FILE_SIZE = 16 * 1024 * 1024;
const ALLOWED_PREFIXES = [
  "image/",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "text/plain",
  "text/csv",
  "audio/",
  "video/",
];

export function assertKeepUpload(mime: string, size: number) {
  if (size > MAX_FILE_SIZE) throw new KeepError("Arquivo acima de 16 MB.", 413);
  const ok = ALLOWED_PREFIXES.some((p) => mime === p || mime.startsWith(p));
  if (!ok) throw new KeepError("Tipo de arquivo não permitido.", 415);
}

export async function addKeepAttachment(opts: {
  orgId: string;
  userId: string;
  noteId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}) {
  assertKeepUpload(opts.mimeType, opts.buffer.length);
  const note = await prisma.keepNote.findFirst({
    where: { id: opts.noteId, userId: opts.userId },
    select: { id: true },
  });
  if (!note) throw new KeepError("Nota não encontrada.", 404);
  const ext = (opts.fileName.split(".").pop() ?? "bin").toLowerCase();
  const storageKey = generateFileName({ prefix: "keep", ext });
  await saveFile({
    orgId: opts.orgId,
    bucket: "keeps",
    fileName: storageKey,
    buffer: opts.buffer,
  });
  return prisma.keepAttachment.create({
    data: {
      organizationId: opts.orgId,
      userId: opts.userId,
      noteId: note.id,
      fileName: opts.fileName.slice(0, 180),
      mimeType: opts.mimeType,
      fileSize: opts.buffer.length,
      storageKey,
    },
  });
}

export function serializeKeepNote<T extends Parameters<typeof serializeNote>[0]>(note: T, orgId: string) {
  return serializeNote(note, orgId);
}

export { EMPTY_DOC };
