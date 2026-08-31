/**
 * Reparo em massa de mídias de modelos (message_templates + quick_replies)
 * cujo objeto sumiu do driver ativo (Spaces em prod).
 *
 * Recupera bytes só da mesma org, sem inventar arquivo e sem fetch de
 * URL arbitrária (SSRF):
 *   1. buckets de reuse + alias jpg/jpeg + ListObjects do stem
 *   2. STORAGE_ROOT local e public/uploads
 *   3. STORAGE_FALLBACK_URL GET (700ms / 15s p/ mp4) — host legado via env
 *
 * Se recuperou: saveFile na key canônica (automation-media ou o bucket
 * original). Atualiza URL legado `/uploads/...` para `/api/storage/...`.
 */
import { Prisma } from "@prisma/client";

import { prismaBase } from "@/lib/prisma-base";
import {
  buildPublicUrl,
  existsStoredFile,
  locateReusableStoredObject,
  readLegacyUploadsFile,
  readStoredFile,
  resolveOrgOwnedReuseUrl,
  reuseFileNameAliases,
  saveFile,
  type OrgOwnedReuseUrl,
} from "@/lib/storage/local";
import {
  readUpstreamFallbackBytes,
  storageFallbackConfigured,
} from "@/lib/storage/upstream-fallback";
import {
  normalizeTemplateAttachments,
  type TemplateAttachment,
} from "@/services/templates";

export type RepairItemKind = "template" | "quick_reply";

export type RepairMediaItem = {
  kind: RepairItemKind;
  name: string;
  fileName: string;
};

export type RepairSkippedReason = "ok" | "no_media" | "not_storage";

export type RepairSkippedItem = {
  kind: RepairItemKind;
  name: string;
  reason: RepairSkippedReason;
};

export type RepairTemplateMediaResult = {
  repaired: RepairMediaItem[];
  missing: RepairMediaItem[];
  skipped: RepairSkippedItem[];
  fallbackConfigured: boolean;
};

export type RepairTemplateMediaOptions = {
  orgId: string;
  cookieHeader?: string | null;
  dryRun?: boolean;
};

export type ClassifiedMediaUrl =
  | { status: "empty" }
  | { status: "not_storage" }
  | { status: "repairable"; parsed: OrgOwnedReuseUrl };

/** Classifica uma URL gravada no modelo. Não acessa disco nem rede. */
export function classifyTemplateMediaUrl(raw: string, orgId: string): ClassifiedMediaUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { status: "empty" };
  const parsed = resolveOrgOwnedReuseUrl(trimmed, orgId);
  if (!parsed) return { status: "not_storage" };
  return { status: "repairable", parsed };
}

export function collectTemplateMediaUrls(row: {
  mediaUrl: string | null;
  attachments: unknown;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  if (typeof row.mediaUrl === "string") add(row.mediaUrl);
  for (const item of normalizeTemplateAttachments(row.attachments)) add(item.url);
  return out;
}

function attachmentsToJson(
  attachments: TemplateAttachment[] | null,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return attachments === null
    ? Prisma.JsonNull
    : (attachments as unknown as Prisma.InputJsonValue);
}

async function readLocatedBytes(hit: OrgOwnedReuseUrl): Promise<Buffer | null> {
  if (hit.legacyRelative) {
    const file = await readLegacyUploadsFile(hit.legacyRelative);
    return file?.buffer?.length ? file.buffer : null;
  }
  const file = await readStoredFile(hit.orgId, hit.bucket, hit.fileName);
  return file?.buffer?.length ? file.buffer : null;
}

async function recoverBytes(
  parsed: OrgOwnedReuseUrl,
  cookieHeader: string | null | undefined,
): Promise<Buffer | null> {
  const located = await locateReusableStoredObject(parsed, { deadlineMs: null });
  if (located) {
    const fromLocated = await readLocatedBytes(located);
    if (fromLocated) return fromLocated;
  }

  const names = reuseFileNameAliases(parsed.fileName);
  for (const fileName of names) {
    const joined = `${parsed.orgId}/${parsed.bucket}/${fileName}`;
    const imported = await readUpstreamFallbackBytes(joined, cookieHeader ?? null);
    if (imported?.length) return imported;
  }
  return null;
}

function item(kind: RepairItemKind, name: string, fileName: string): RepairMediaItem {
  return { kind, name, fileName };
}

async function persistTemplateUrls(
  row: {
    id: string;
    mediaUrl: string | null;
    mediaType: string | null;
    mediaName: string | null;
    attachments: unknown;
  },
  replacements: Map<string, string>,
): Promise<void> {
  if (replacements.size === 0) return;
  let mediaUrl = row.mediaUrl;
  if (mediaUrl && replacements.has(mediaUrl)) mediaUrl = replacements.get(mediaUrl) ?? mediaUrl;

  let attachments = normalizeTemplateAttachments(row.attachments);
  if (attachments.length === 0 && mediaUrl) {
    attachments = [{ url: mediaUrl, mimeType: row.mediaType, name: row.mediaName }];
  }
  attachments = attachments.map((a) =>
    replacements.has(a.url) ? { ...a, url: replacements.get(a.url) ?? a.url } : a,
  );
  if (attachments[0]) mediaUrl = attachments[0].url;

  await prismaBase.messageTemplate.update({
    where: { id: row.id },
    data: {
      mediaUrl,
      attachments: attachmentsToJson(attachments.length > 0 ? attachments : null),
    },
  });
}

async function repairUrl(
  orgId: string,
  raw: string,
  cookieHeader: string | null | undefined,
  dryRun: boolean,
): Promise<
  | { outcome: "ok" }
  | { outcome: "not_storage" }
  | { outcome: "repaired"; fileName: string; nextUrl: string | null }
  | { outcome: "missing"; fileName: string }
> {
  const classified = classifyTemplateMediaUrl(raw, orgId);
  if (classified.status === "empty") return { outcome: "ok" };
  if (classified.status === "not_storage") return { outcome: "not_storage" };

  const { parsed } = classified;
  const canonicalUrl = buildPublicUrl(parsed.orgId, parsed.bucket, parsed.fileName);
  const already = await existsStoredFile(parsed.orgId, parsed.bucket, parsed.fileName);
  if (already) {
    const needsRewrite = raw !== canonicalUrl;
    return needsRewrite
      ? { outcome: "repaired", fileName: parsed.fileName, nextUrl: canonicalUrl }
      : { outcome: "ok" };
  }

  const bytes = await recoverBytes(parsed, cookieHeader);
  if (!bytes) return { outcome: "missing", fileName: parsed.fileName };

  if (!dryRun) {
    await saveFile({
      orgId: parsed.orgId,
      bucket: parsed.bucket,
      fileName: parsed.fileName,
      buffer: bytes,
    });
  }

  const nextUrl = raw !== canonicalUrl ? canonicalUrl : null;
  return { outcome: "repaired", fileName: parsed.fileName, nextUrl };
}

export async function repairOrgTemplateMedia(
  opts: RepairTemplateMediaOptions,
): Promise<RepairTemplateMediaResult> {
  const { orgId, cookieHeader, dryRun = false } = opts;
  const repaired: RepairMediaItem[] = [];
  const missing: RepairMediaItem[] = [];
  const skipped: RepairSkippedItem[] = [];

  const templates = await prismaBase.messageTemplate.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      name: true,
      mediaUrl: true,
      mediaType: true,
      mediaName: true,
      attachments: true,
    },
    orderBy: { name: "asc" },
  });

  for (const row of templates) {
    const urls = collectTemplateMediaUrls(row);
    if (urls.length === 0) {
      skipped.push({ kind: "template", name: row.name, reason: "no_media" });
      continue;
    }

    const replacements = new Map<string, string>();
    let sawStorage = false;
    let sawRepair = false;
    let sawMissing = false;
    let sawNotStorage = false;
    for (const raw of urls) {
      const result = await repairUrl(orgId, raw, cookieHeader, dryRun);
      if (result.outcome === "not_storage") {
        sawNotStorage = true;
        continue;
      }
      sawStorage = true;
      if (result.outcome === "ok") continue;
      if (result.outcome === "missing") {
        sawMissing = true;
        missing.push(item("template", row.name, result.fileName));
        continue;
      }
      sawRepair = true;
      repaired.push(item("template", row.name, result.fileName));
      if (result.nextUrl) replacements.set(raw, result.nextUrl);
    }

    if (!sawRepair && !sawMissing) {
      skipped.push({
        kind: "template",
        name: row.name,
        reason: sawStorage ? "ok" : sawNotStorage ? "not_storage" : "no_media",
      });
    }

    if (!dryRun && replacements.size > 0) {
      await persistTemplateUrls(row, replacements);
    }
  }

  const replies = await prismaBase.quickReply.findMany({
    where: { organizationId: orgId, attachmentUrl: { not: null } },
    select: { id: true, title: true, attachmentUrl: true },
    orderBy: { title: "asc" },
  });

  for (const row of replies) {
    const raw = row.attachmentUrl?.trim() ?? "";
    if (!raw) {
      skipped.push({ kind: "quick_reply", name: row.title, reason: "no_media" });
      continue;
    }
    const result = await repairUrl(orgId, raw, cookieHeader, dryRun);
    if (result.outcome === "not_storage") {
      skipped.push({ kind: "quick_reply", name: row.title, reason: "not_storage" });
      continue;
    }
    if (result.outcome === "ok") {
      skipped.push({ kind: "quick_reply", name: row.title, reason: "ok" });
      continue;
    }
    if (result.outcome === "missing") {
      missing.push(item("quick_reply", row.title, result.fileName));
      continue;
    }
    repaired.push(item("quick_reply", row.title, result.fileName));
    if (!dryRun && result.nextUrl) {
      await prismaBase.quickReply.update({
        where: { id: row.id },
        data: { attachmentUrl: result.nextUrl },
      });
    }
  }

  return {
    repaired,
    missing,
    skipped,
    fallbackConfigured: storageFallbackConfigured(),
  };
}
