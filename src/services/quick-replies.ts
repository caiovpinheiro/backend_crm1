import { bumpResponseFamilies, RESPONSE_FAMILIES } from "@/lib/cache/response-families";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";

/** Lista/grupos de respostas rápidas em cache: sobe a versão da org do contexto. */
async function invalidateQuickRepliesCache(): Promise<void> {
  await bumpResponseFamilies(getOrgIdOrNull(), RESPONSE_FAMILIES.quickReplies);
}

export async function getQuickReplies() {
  return prisma.quickReply.findMany({ orderBy: { position: "asc" } });
}

export async function getQuickReplyById(id: string) {
  return prisma.quickReply.findUnique({ where: { id } });
}

export async function createQuickReply(data: {
  title: string;
  content: string;
  category?: string;
}) {
  const maxPos = await prisma.quickReply.aggregate({ _max: { position: true } });
  const created = await prisma.quickReply.create({
    data: withOrgFromCtx({
      title: data.title,
      content: data.content,
      category: data.category ?? null,
      position: (maxPos._max.position ?? -1) + 1,
    }),
  });
  await invalidateQuickRepliesCache();
  return created;
}

export async function updateQuickReply(
  id: string,
  data: { title?: string; content?: string; category?: string; position?: number }
) {
  const updated = await prisma.quickReply.update({ where: { id }, data });
  await invalidateQuickRepliesCache();
  return updated;
}

export async function deleteQuickReply(id: string) {
  const deleted = await prisma.quickReply.delete({ where: { id } });
  await invalidateQuickRepliesCache();
  return deleted;
}

export async function reorderQuickReplies(orderedIds: string[]) {
  const ops = orderedIds.map((id, idx) =>
    prisma.quickReply.update({ where: { id }, data: { position: idx } })
  );
  const result = await prisma.$transaction(ops);
  await invalidateQuickRepliesCache();
  return result;
}
