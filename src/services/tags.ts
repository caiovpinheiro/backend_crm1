import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { notifyTagAdded } from "@/services/automation-triggers";

export type CreateTagInput = {
  name: string;
  color?: string;
};

export async function getTags() {
  return prisma.tag.findMany({
    orderBy: { name: "asc" },
  });
}

export async function getTagById(id: string) {
  return prisma.tag.findUnique({ where: { id } });
}

export async function createTag(data: CreateTagInput) {
  return prisma.tag.create({
    data: withOrgFromCtx({
      name: data.name.trim(),
      color: data.color?.trim() || undefined,
    }),
  });
}

export async function addTagToContact(contactId: string, tagId: string) {
  const link = await prisma.tagOnContact.create({
    data: { contactId, tagId },
    include: {
      tag: { select: { id: true, name: true, color: true } },
    },
  });
  void notifyTagAdded({ contactId, tagId, tagName: link.tag.name });
  return link;
}

/**
 * Marca no contato uma tag que JÁ EXISTE, uma única vez.
 *
 * Tag inventada não é gatilho de automação nenhuma, então criar na hora
 * daria ao operador uma regra que "roda" sem efeito. Tag já aplicada
 * também não reaplica: o `tag_added` dispararia de novo a cada mensagem
 * que casasse com a regra.
 *
 * Nunca lança — quem chama está no meio de um atendimento, e derrubar o
 * turno porque a tag não existe é pior do que seguir.
 *
 * @returns true se marcou agora.
 */
export async function applyExistingTagToContact(args: {
  contactId: string | null | undefined;
  tagName: string | null | undefined;
  /// Prefixo do log, para o operador saber de onde veio a tentativa.
  source: string;
}): Promise<boolean> {
  const name = args.tagName?.trim();
  if (!name || !args.contactId) return false;
  try {
    const tag = await prisma.tag.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (!tag) {
      console.error(
        `${args.source}: tag "${name}" não existe no CRM — crie a tag antes de usá-la.`,
      );
      return false;
    }
    const already = await prisma.tagOnContact.findFirst({
      where: { contactId: args.contactId, tagId: tag.id },
      select: { contactId: true },
    });
    if (already) return false;
    await addTagToContact(args.contactId, tag.id);
    return true;
  } catch (err) {
    console.error(`${args.source}: falha ao marcar tag`, err);
    return false;
  }
}

export async function removeTagFromContact(contactId: string, tagId: string) {
  await prisma.tagOnContact.delete({
    where: {
      contactId_tagId: { contactId, tagId },
    },
  });
}
