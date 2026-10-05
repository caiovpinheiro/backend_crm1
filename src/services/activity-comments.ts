/**
 * Comentários assinados em Activity (tarefa).
 *
 * - Autor sempre vem do contexto autenticado — nunca do body.
 * - Create/update/delete gravam revision na mesma transação.
 * - DELETE é soft-delete (deletedAt); content permanece no banco.
 * - ActivityEvent é gravado na mesma transação do comentário/revision.
 */
import type { ActivityCommentRevisionAction, Prisma } from "@prisma/client";

import { prisma, type ScopedTx } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getRequestContext } from "@/lib/request-context";

export const COMMENT_CONTENT_MAX = 10_000;

const authorSelect = {
  id: true,
  name: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

const commentInclude = {
  author: { select: authorSelect },
} satisfies Prisma.ActivityCommentInclude;

const revisionInclude = {
  actor: { select: authorSelect },
} satisfies Prisma.ActivityCommentRevisionInclude;

export type ActivityCommentDTO = {
  id: string;
  activityId: string;
  organizationId: string;
  authorId: string;
  author: { id: string; name: string; avatarUrl: string | null };
  /** Null quando soft-deleted (lista/GET normal). */
  content: string | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ActivityCommentRevisionDTO = {
  id: string;
  commentId: string;
  organizationId: string;
  actorId: string;
  actor: { id: string; name: string; avatarUrl: string | null };
  action: ActivityCommentRevisionAction;
  beforeContent: string | null;
  afterContent: string | null;
  createdAt: Date;
};

function requireOrgId(): string {
  const orgId = getRequestContext()?.organizationId;
  if (!orgId) throw new Error("MISSING_ORG_CONTEXT");
  return orgId;
}

function normalizeContent(raw: string): string {
  const content = raw.trim();
  if (!content) throw new Error("INVALID_CONTENT");
  if (content.length > COMMENT_CONTENT_MAX) throw new Error("CONTENT_TOO_LONG");
  return content;
}

function toCommentDTO(
  row: Prisma.ActivityCommentGetPayload<{ include: typeof commentInclude }>,
  opts?: { revealDeletedContent?: boolean },
): ActivityCommentDTO {
  const deleted = row.deletedAt != null;
  return {
    id: row.id,
    activityId: row.activityId,
    organizationId: row.organizationId,
    authorId: row.authorId,
    author: row.author,
    content: deleted && !opts?.revealDeletedContent ? null : row.content,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRevisionDTO(
  row: Prisma.ActivityCommentRevisionGetPayload<{ include: typeof revisionInclude }>,
): ActivityCommentRevisionDTO {
  return {
    id: row.id,
    commentId: row.commentId,
    organizationId: row.organizationId,
    actorId: row.actorId,
    actor: row.actor,
    action: row.action,
    beforeContent: row.beforeContent,
    afterContent: row.afterContent,
    createdAt: row.createdAt,
  };
}

async function createCommentEvent(tx: ScopedTx, args: {
  type: string;
  activityId: string;
  actorId: string;
  activityTitle?: string | null;
  dealId?: string | null;
  contactId?: string | null;
  commentId: string;
  beforeContent?: string | null;
  afterContent?: string | null;
  meta?: Record<string, unknown>;
}) {
  await tx.activityEvent.create({
    data: withOrgFromCtx({
      type: args.type,
      entityType: "ACTIVITY",
      entityId: args.activityId,
      entityLabel: args.activityTitle ?? null,
      dealId: args.dealId ?? null,
      contactId: args.contactId ?? null,
      conversationId: null,
      actorType: "HUMAN",
      actorUserId: args.actorId,
      actorLabel: null,
      actorSublabel: null,
      actorRef: null,
      field: "comments",
      oldValue: args.beforeContent ?? null,
      newValue: args.afterContent ?? null,
      meta: {
        commentId: args.commentId,
        ...(args.meta ?? {}),
      } as Prisma.InputJsonValue,
    }),
    // Só o id volta: ninguém usa a linha (era INSERT … RETURNING * de ~25 colunas).
    select: { id: true },
  });
}

export async function listActivityComments(activityId: string): Promise<ActivityCommentDTO[]> {
  const organizationId = requireOrgId();
  const rows = await prisma.activityComment.findMany({
    where: { activityId, organizationId },
    orderBy: { createdAt: "asc" },
    include: commentInclude,
  });
  return rows.map((r) => toCommentDTO(r));
}

export async function createActivityComment(input: {
  activityId: string;
  authorId: string;
  content: string;
  activityTitle?: string | null;
  dealId?: string | null;
  contactId?: string | null;
}): Promise<ActivityCommentDTO> {
  const content = normalizeContent(input.content);
  const organizationId = requireOrgId();

  const created = await prisma.$transaction(async (tx: ScopedTx) => {
    const comment = await tx.activityComment.create({
      data: withOrgFromCtx({
        activityId: input.activityId,
        authorId: input.authorId,
        content,
      }),
      include: commentInclude,
    });

    await tx.activityCommentRevision.create({
      data: withOrgFromCtx({
        commentId: comment.id,
        actorId: input.authorId,
        action: "CREATED" as ActivityCommentRevisionAction,
        beforeContent: null,
        afterContent: content,
      }),
    });

    await createCommentEvent(tx, {
      type: "ACTIVITY_COMMENT_ADDED",
      activityId: input.activityId,
      actorId: input.authorId,
      activityTitle: input.activityTitle,
      dealId: input.dealId,
      contactId: input.contactId,
      commentId: comment.id,
      afterContent: content,
      meta: { preview: content.slice(0, 200) },
    });

    return comment;
  });

  return toCommentDTO(created);
}

export async function updateActivityComment(input: {
  activityId: string;
  commentId: string;
  actorId: string;
  content: string;
  activityTitle?: string | null;
  dealId?: string | null;
  contactId?: string | null;
}): Promise<ActivityCommentDTO> {
  const content = normalizeContent(input.content);
  const organizationId = requireOrgId();

  const updated = await prisma.$transaction(async (tx: ScopedTx) => {
    const existing = await tx.activityComment.findFirst({
      where: {
        id: input.commentId,
        activityId: input.activityId,
        organizationId,
      },
    });
    if (!existing || existing.deletedAt) throw new Error("NOT_FOUND");
    if (existing.authorId !== input.actorId) throw new Error("FORBIDDEN_NOT_AUTHOR");

    const comment = await tx.activityComment.update({
      where: { id: existing.id },
      data: {
        content,
        editedAt: new Date(),
      },
      include: commentInclude,
    });

    await tx.activityCommentRevision.create({
      data: withOrgFromCtx({
        commentId: comment.id,
        actorId: input.actorId,
        action: "UPDATED" as ActivityCommentRevisionAction,
        beforeContent: existing.content,
        afterContent: content,
      }),
    });

    await createCommentEvent(tx, {
      type: "ACTIVITY_COMMENT_UPDATED",
      activityId: input.activityId,
      actorId: input.actorId,
      activityTitle: input.activityTitle,
      dealId: input.dealId,
      contactId: input.contactId,
      commentId: comment.id,
      beforeContent: existing.content,
      afterContent: content,
      meta: { preview: content.slice(0, 200) },
    });

    return comment;
  });

  return toCommentDTO(updated);
}

export async function softDeleteActivityComment(input: {
  activityId: string;
  commentId: string;
  actorId: string;
  activityTitle?: string | null;
  dealId?: string | null;
  contactId?: string | null;
}): Promise<ActivityCommentDTO> {
  const organizationId = requireOrgId();

  const deleted = await prisma.$transaction(async (tx: ScopedTx) => {
    const existing = await tx.activityComment.findFirst({
      where: {
        id: input.commentId,
        activityId: input.activityId,
        organizationId,
      },
    });
    if (!existing || existing.deletedAt) throw new Error("NOT_FOUND");
    if (existing.authorId !== input.actorId) throw new Error("FORBIDDEN_NOT_AUTHOR");

    const comment = await tx.activityComment.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
      include: commentInclude,
    });

    await tx.activityCommentRevision.create({
      data: withOrgFromCtx({
        commentId: comment.id,
        actorId: input.actorId,
        action: "DELETED" as ActivityCommentRevisionAction,
        beforeContent: existing.content,
        afterContent: null,
      }),
    });

    await createCommentEvent(tx, {
      type: "ACTIVITY_COMMENT_DELETED",
      activityId: input.activityId,
      actorId: input.actorId,
      activityTitle: input.activityTitle,
      dealId: input.dealId,
      contactId: input.contactId,
      commentId: comment.id,
      beforeContent: existing.content,
      afterContent: null,
    });

    return comment;
  });

  return toCommentDTO(deleted);
}

export async function listCommentRevisions(input: {
  activityId: string;
  commentId: string;
}): Promise<ActivityCommentRevisionDTO[]> {
  const organizationId = requireOrgId();

  const comment = await prisma.activityComment.findFirst({
    where: {
      id: input.commentId,
      activityId: input.activityId,
      organizationId,
    },
    select: { id: true },
  });
  if (!comment) throw new Error("NOT_FOUND");

  const rows = await prisma.activityCommentRevision.findMany({
    where: { commentId: comment.id, organizationId },
    orderBy: { createdAt: "asc" },
    include: revisionInclude,
  });
  return rows.map(toRevisionDTO);
}

/** Histórico de todos os comentários da Activity (auditoria). */
export async function listActivityCommentHistory(
  activityId: string,
): Promise<ActivityCommentRevisionDTO[]> {
  const organizationId = requireOrgId();

  const rows = await prisma.activityCommentRevision.findMany({
    where: {
      organizationId,
      comment: { activityId, organizationId },
    },
    orderBy: { createdAt: "asc" },
    include: revisionInclude,
  });
  return rows.map(toRevisionDTO);
}
