import { createHash } from "crypto";
import { unzipSync } from "fflate";

import { prisma } from "@/lib/prisma";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { asJson, plainTextFromDoc } from "./doc";
import { basename, normalizeZipPath, parseKeepHtmlDocument, rewriteImageSrcs } from "./html";
import { KeepError } from "./keeps";

const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_UNCOMPRESSED = 80 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_NOTES = 400;
const MAX_IMAGE = 12 * 1024 * 1024;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
  };
  return map[ext] ?? "application/octet-stream";
}

function isSafeZipName(name: string): boolean {
  const n = name.replace(/\\/g, "/");
  if (!n || n.startsWith("/") || n.includes("..")) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  return true;
}

export async function importGoogleKeepZip(opts: {
  orgId: string;
  userId: string;
  fileName: string;
  buffer: Buffer;
}) {
  if (opts.buffer.length > MAX_ZIP_BYTES) {
    throw new KeepError("ZIP acima de 25 MB.", 413);
  }
  const fileHash = createHash("sha256").update(opts.buffer).update("\nkeep-html-split-v2").digest("hex");

  const dup = await prisma.keepImport.findFirst({
    where: { userId: opts.userId, fileHash },
    select: { id: true, noteCount: true, createdAt: true },
  });
  if (dup) {
    throw new KeepError("Este arquivo já foi importado. As notas já estão no Bwipo Keeps.", 409);
  }

  let entries: Record<string, Uint8Array>;
  try {
    let uncompressed = 0;
    let count = 0;
    entries = unzipSync(new Uint8Array(opts.buffer), {
      filter: (file: { name: string; size: number }) => {
        if (!isSafeZipName(file.name)) return false;
        count += 1;
        if (count > MAX_ENTRIES) return false;
        uncompressed += file.size;
        if (uncompressed > MAX_UNCOMPRESSED) return false;
        return true;
      },
    });
  } catch {
    throw new KeepError("Não foi possível ler o ZIP (arquivo inválido ou corrompido).", 400);
  }

  const files = new Map<string, { name: string; data: Buffer }>();
  for (const [name, data] of Object.entries(entries)) {
    if (!isSafeZipName(name)) continue;
    files.set(normalizeZipPath(name), { name, data: Buffer.from(data) });
  }

  const htmlFiles = [...files.values()].filter((f) => /\.html?$/i.test(f.name) && !/\/index\.html?$/i.test(f.name));
  if (htmlFiles.length === 0) {
    throw new KeepError("Nenhum HTML de nota encontrado no ZIP. Use o export “Página da Web” do Google Keep.", 400);
  }
  if (htmlFiles.length > MAX_NOTES) {
    throw new KeepError("O ZIP tem notas demais para esta importação (máx. 400).", 400);
  }

  const batch = await prisma.keepImport.create({
    data: {
      organizationId: opts.orgId,
      userId: opts.userId,
      fileName: opts.fileName.slice(0, 180),
      fileHash,
      noteCount: 0,
    },
  });

  let imported = 0;
  const minPos = await prisma.keepNote.aggregate({
    where: { userId: opts.userId, trashed: false, archived: false },
    _min: { position: true },
  });
  let nextPos = (minPos._min.position ?? 1000) - 1000;
  try {
    for (const htmlFile of htmlFiles) {
      const parsedNotes = parseKeepHtmlDocument(htmlFile.data.toString("utf8"));
      for (const parsed of parsedNotes) {
        const imageMap = new Map<string, string>();
        const attachmentPayloads: Array<{
          fileName: string;
          mimeType: string;
          storageKey: string;
          fileSize: number;
        }> = [];

        const imgSrcs = collectImageSrcs(parsed.html);
        for (const src of imgSrcs) {
          const found = resolveZipImage(files, src, htmlFile.name);
          if (!found) continue;
          if (found.data.length > MAX_IMAGE) continue;
          const ext = (found.name.split(".").pop() ?? "jpg").toLowerCase();
          if (!IMAGE_EXT.has(ext)) continue;
          const storageKey = generateFileName({ prefix: "keepimg", ext });
          await saveFile({
            orgId: opts.orgId,
            bucket: "keeps",
            fileName: storageKey,
            buffer: found.data,
          });
          const url = `/api/storage/${opts.orgId}/keeps/${encodeURIComponent(storageKey)}`;
          imageMap.set(normalizeZipPath(src), url);
          imageMap.set(basename(src), url);
          attachmentPayloads.push({
            fileName: basename(found.name),
            mimeType: mimeFromName(found.name),
            storageKey,
            fileSize: found.data.length,
          });
        }

        const doc = rewriteImageSrcs(parsed.doc, imageMap);
        const note = await prisma.keepNote.create({
          data: {
            organizationId: opts.orgId,
            userId: opts.userId,
            title: parsed.title.slice(0, 240),
            content: asJson(docSafe(doc)),
            plainText: plainTextFromDoc(doc),
            source: "google_keep_html",
            importBatchId: batch.id,
            position: nextPos,
          },
        });
        nextPos -= 1000;
        if (attachmentPayloads.length) {
          await prisma.keepAttachment.createMany({
            data: attachmentPayloads.map((a) => ({
              organizationId: opts.orgId,
              userId: opts.userId,
              noteId: note.id,
              fileName: a.fileName.slice(0, 180),
              mimeType: a.mimeType,
              fileSize: a.fileSize,
              storageKey: a.storageKey,
            })),
          });
        }
        imported += 1;
        if (imported > MAX_NOTES) {
          throw new KeepError("O ZIP tem notas demais para esta importação (máx. 400).", 400);
        }
      }
    }
  } catch (err) {
    await prisma.keepNote.deleteMany({ where: { importBatchId: batch.id, userId: opts.userId } });
    await prisma.keepImport.delete({ where: { id: batch.id } }).catch(() => undefined);
    throw err;
  }

  await prisma.keepImport.update({
    where: { id: batch.id },
    data: { noteCount: imported },
  });

  return { batchId: batch.id, imported };
}

function docSafe(doc: ReturnType<typeof rewriteImageSrcs>) {
  return doc.content.length ? doc : { type: "doc" as const, content: [{ type: "paragraph" }] };
}

function collectImageSrcs(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b[^>]*src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function resolveZipImage(
  files: Map<string, { name: string; data: Buffer }>,
  src: string,
  htmlName: string,
): { name: string; data: Buffer } | null {
  const cleaned = src.split("?")[0].split("#")[0];
  const key = normalizeZipPath(cleaned);
  const direct = files.get(key);
  if (direct) return direct;
  const byBase = files.get(basename(key));
  if (byBase) return byBase;
  const dir = htmlName.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  const joined = normalizeZipPath(`${dir}/${cleaned}`);
  return files.get(joined) ?? null;
}
