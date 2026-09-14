import { Prisma, type ChannelType, type TemplateStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

export type TemplateAttachment = {
  /** Vazio = passo só de texto (`messageBefore`). */
  url: string;
  mimeType?: string | null;
  name?: string | null;
  /** Texto enviado neste passo (antes do arquivo, se houver). */
  messageBefore?: string | null;
};

export const MAX_TEMPLATE_ATTACHMENTS = 5;
/** Arquivos + textos extras na sequência (além do `content` principal). */
export const MAX_TEMPLATE_SEQUENCE_ITEMS = 10;

export function firstFileAttachment(
  items: TemplateAttachment[],
): TemplateAttachment | null {
  return items.find((a) => a.url.trim()) ?? null;
}

/** 400-message se a lista crua estourar tetos; `null` se ok. */
export function templateSequenceLimitError(raw: unknown[]): string | null {
  if (raw.length > MAX_TEMPLATE_SEQUENCE_ITEMS) {
    return `Máximo de ${MAX_TEMPLATE_SEQUENCE_ITEMS} passos na sequência do modelo.`;
  }
  let files = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const url = (item as Record<string, unknown>).url;
    if (typeof url === "string" && url.trim()) files += 1;
  }
  if (files > MAX_TEMPLATE_ATTACHMENTS) {
    return `Máximo de ${MAX_TEMPLATE_ATTACHMENTS} arquivos por modelo.`;
  }
  return null;
}

/**
 * Valida e normaliza o array de anexos recebido do client.
 * Passo só de texto: `url` vazio + `messageBefore`. Arquivo: `url` obrigatório.
 * Limites de quantidade são da rota (`templateSequenceLimitError`).
 */
export function normalizeTemplateAttachments(raw: unknown): TemplateAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const urlRaw = rec.url;
    const url = typeof urlRaw === "string" ? urlRaw.trim() : "";
    const mimeType = rec.mimeType;
    const name = rec.name;
    const messageBeforeRaw = rec.messageBefore;
    const messageBefore =
      typeof messageBeforeRaw === "string" && messageBeforeRaw.trim()
        ? messageBeforeRaw.trim()
        : null;
    if (!url && !messageBefore) continue;
    out.push({
      url,
      mimeType: typeof mimeType === "string" && mimeType ? mimeType : null,
      name: typeof name === "string" && name ? name : null,
      messageBefore,
    });
  }
  return out;
}

/** Serializa o array de anexos pro formato Json aceito pelo Prisma (`null` vira `Prisma.JsonNull`). */
function attachmentsToJsonInput(
  attachments: TemplateAttachment[] | null,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return attachments === null
    ? Prisma.JsonNull
    : (attachments as unknown as Prisma.InputJsonValue);
}

export async function getTemplates() {
  return prisma.messageTemplate.findMany({ orderBy: { name: "asc" } });
}

export async function getTemplateById(id: string) {
  return prisma.messageTemplate.findUnique({ where: { id } });
}

export async function createTemplate(data: {
  name: string;
  content: string;
  category?: string;
  language?: string;
  channelType?: ChannelType;
  mediaUrl?: string | null;
  mediaType?: string | null;
  mediaName?: string | null;
  /** Anexos extras (máx. `MAX_TEMPLATE_ATTACHMENTS`, validado na rota). Quando
   *  fornecido (mesmo vazio), espelha o índice 0 em mediaUrl/mediaType/mediaName. */
  attachments?: TemplateAttachment[];
}) {
  let mediaUrl = data.mediaUrl ?? null;
  let mediaType = data.mediaType ?? null;
  let mediaName = data.mediaName ?? null;
  let attachments: TemplateAttachment[] | null = null;

  if (data.attachments !== undefined) {
    attachments = data.attachments.length > 0 ? data.attachments : null;
    const firstFile = firstFileAttachment(data.attachments);
    mediaUrl = firstFile?.url || null;
    mediaType = firstFile?.mimeType ?? null;
    mediaName = firstFile?.name ?? null;
  } else if (mediaUrl) {
    attachments = [{ url: mediaUrl, mimeType: mediaType, name: mediaName }];
  }

  return prisma.messageTemplate.create({
    data: withOrgFromCtx({
      name: data.name,
      content: data.content,
      category: data.category ?? null,
      language: data.language ?? "pt_BR",
      channelType: data.channelType ?? null,
      mediaUrl,
      mediaType,
      mediaName,
      attachments: attachmentsToJsonInput(attachments),
    }),
  });
}

export async function updateTemplate(
  id: string,
  data: {
    name?: string;
    content?: string;
    category?: string;
    language?: string;
    status?: TemplateStatus;
    channelType?: ChannelType | null;
    mediaUrl?: string | null;
    mediaType?: string | null;
    mediaName?: string | null;
    /** Quando fornecido (mesmo vazio), sincroniza mediaUrl/mediaType/mediaName
     *  a partir do índice 0. Quando ausente, comportamento legado é mantido:
     *  se `mediaUrl` vier na chamada, espelha em `attachments` (nice-to-have). */
    attachments?: TemplateAttachment[];
  }
) {
  let mediaUrl = data.mediaUrl;
  let mediaType = data.mediaType;
  let mediaName = data.mediaName;
  let attachments: TemplateAttachment[] | null | undefined;

  if (data.attachments !== undefined) {
    attachments = data.attachments.length > 0 ? data.attachments : null;
    const firstFile = firstFileAttachment(data.attachments);
    mediaUrl = firstFile?.url || null;
    mediaType = firstFile?.mimeType ?? null;
    mediaName = firstFile?.name ?? null;
  } else if (mediaUrl !== undefined) {
    attachments = mediaUrl
      ? [{ url: mediaUrl, mimeType: mediaType ?? null, name: mediaName ?? null }]
      : null;
  }

  return prisma.messageTemplate.update({
    where: { id },
    data: {
      name: data.name,
      content: data.content,
      category: data.category,
      language: data.language,
      status: data.status,
      channelType: data.channelType,
      mediaUrl,
      mediaType,
      mediaName,
      attachments: attachments === undefined ? undefined : attachmentsToJsonInput(attachments),
    },
  });
}

export async function deleteTemplate(id: string) {
  return prisma.messageTemplate.delete({ where: { id } });
}
