/**
 * "Mídia, links e docs" do grupo WhatsApp (como no WhatsApp): tudo sai das
 * mensagens já gravadas — nada novo no banco. Mídia = foto/vídeo; docs =
 * documento; links = URLs achadas no texto das mensagens.
 */
import { prisma } from "@/lib/prisma";

export type GroupMediaKind = "media" | "docs" | "links";

export const GROUP_MEDIA_PAGE = 60;
/** Teto de mensagens varridas atrás de links (contagem e lista). */
export const GROUP_LINK_SCAN = 500;

const MEDIA_TYPES = ["image", "video"];
const DOC_TYPES = ["document"];

export type GroupMediaItem = {
  id: string;
  messageType: string;
  mediaUrl: string | null;
  mimeType: string | null;
  fileName: string | null;
  text: string;
  author: string;
  fromMe: boolean;
  createdAt: string;
};

export type GroupLinkItem = {
  /** messageId + posição: um texto pode ter mais de um link. */
  id: string;
  url: string;
  domain: string;
  snippet: string;
  author: string;
  fromMe: boolean;
  createdAt: string;
};

export type GroupMediaCounts = { media: number; docs: number; links: number };

const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+/gi;

/** Links de um texto, sem pontuação final ("veja https://x.com." → https://x.com). */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(URL_RE) ?? []) {
    const url = m.replace(/[.,;:!?…]+$/, "");
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") out.push(url);
    } catch {
      /* não é URL de verdade */
    }
  }
  return [...new Set(out)];
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function authorOf(m: { fromMe: boolean; fromName: string | null; fromPhone: string | null }): string {
  if (m.fromMe) return "Você";
  return m.fromName?.trim() || m.fromPhone || "Participante";
}

const ROW_SELECT = {
  id: true,
  messageType: true,
  mediaUrl: true,
  mimeType: true,
  fileName: true,
  text: true,
  fromMe: true,
  fromName: true,
  fromPhone: true,
  createdAt: true,
} as const;

function beforeWhere(before?: Date | null) {
  return before ? { createdAt: { lt: before } } : {};
}

/** Fotos/vídeos ou documentos, mais recentes primeiro. Só com arquivo guardado. */
export async function listGroupMediaItems(
  groupId: string,
  kind: "media" | "docs",
  opts: { limit?: number; before?: Date | null } = {},
): Promise<GroupMediaItem[]> {
  const rows = await prisma.whatsAppGroupMessage.findMany({
    where: {
      groupId,
      messageType: { in: kind === "media" ? MEDIA_TYPES : DOC_TYPES },
      mediaUrl: { not: null },
      ...beforeWhere(opts.before),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.limit ?? GROUP_MEDIA_PAGE, 1), 200),
    select: ROW_SELECT,
  });
  return rows.map((r) => ({
    id: r.id,
    messageType: r.messageType,
    mediaUrl: r.mediaUrl,
    mimeType: r.mimeType,
    fileName: r.fileName,
    text: r.text,
    author: authorOf(r),
    fromMe: r.fromMe,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function scanLinkMessages(groupId: string, before?: Date | null) {
  return prisma.whatsAppGroupMessage.findMany({
    where: {
      groupId,
      text: { contains: "http", mode: "insensitive" },
      ...beforeWhere(before),
    },
    orderBy: { createdAt: "desc" },
    take: GROUP_LINK_SCAN,
    select: ROW_SELECT,
  });
}

/** Links do grupo, mais recentes primeiro. */
export async function listGroupLinks(
  groupId: string,
  opts: { limit?: number; before?: Date | null } = {},
): Promise<GroupLinkItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? GROUP_MEDIA_PAGE, 1), 200);
  const rows = await scanLinkMessages(groupId, opts.before);
  const out: GroupLinkItem[] = [];
  for (const r of rows) {
    const links = extractLinks(r.text);
    const snippet = r.text.replace(/\s+/g, " ").trim().slice(0, 140);
    links.forEach((url, i) => {
      out.push({
        id: `${r.id}:${i}`,
        url,
        domain: domainOf(url),
        snippet,
        author: authorOf(r),
        fromMe: r.fromMe,
        createdAt: r.createdAt.toISOString(),
      });
    });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** Totais das três abas (o número ao lado de "Mídia, links e docs"). */
export async function countGroupMedia(groupId: string): Promise<GroupMediaCounts> {
  const [byType, linkRows] = await Promise.all([
    prisma.whatsAppGroupMessage.groupBy({
      by: ["messageType"],
      where: { groupId, messageType: { in: [...MEDIA_TYPES, ...DOC_TYPES] }, mediaUrl: { not: null } },
      _count: { _all: true },
    }),
    scanLinkMessages(groupId),
  ]);
  let media = 0;
  let docs = 0;
  for (const row of byType) {
    if (MEDIA_TYPES.includes(row.messageType)) media += row._count._all;
    else docs += row._count._all;
  }
  const links = linkRows.reduce((n, r) => n + extractLinks(r.text).length, 0);
  return { media, docs, links };
}
