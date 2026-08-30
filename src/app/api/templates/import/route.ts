import type { ChannelType, TemplateStatus } from "@prisma/client";
import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  readDelimiterFlag,
  readUpdateExistingFlag,
  readUploadedTable,
} from "@/lib/import-helpers";
import { prisma } from "@/lib/prisma";
import { createTemplate, updateTemplate } from "@/services/templates";

const MAX_ROWS = 5_000;

const CHANNELS = new Set<ChannelType>([
  "WHATSAPP",
  "INSTAGRAM",
  "FACEBOOK",
  "EMAIL",
  "WEBCHAT",
]);

const STATUSES = new Set<TemplateStatus>([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
]);

const KEY_ALIASES: Record<string, string> = {
  nome: "name",
  name: "name",
  titulo: "name",
  conteudo: "content",
  content: "content",
  mensagem: "content",
  texto: "content",
  categoria: "category",
  category: "category",
  idioma: "language",
  language: "language",
  status: "status",
  canal: "channelType",
  channel: "channelType",
  channeltype: "channelType",
  url_da_midia: "mediaUrl",
  mediaurl: "mediaUrl",
  tipo_da_midia: "mediaType",
  mediatype: "mediaType",
  nome_da_midia: "mediaName",
  medianame: "mediaName",
};

function norm(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function cell(row: Record<string, string>, key: string): string {
  return (row[key] ?? "").trim();
}

function parseChannel(raw: string): ChannelType | undefined {
  const v = raw.toUpperCase();
  return CHANNELS.has(v as ChannelType) ? (v as ChannelType) : undefined;
}

function parseStatus(raw: string): TemplateStatus | undefined {
  const v = raw.toUpperCase();
  return STATUSES.has(v as TemplateStatus) ? (v as TemplateStatus) : undefined;
}

/**
 * POST /api/templates/import
 * CSV de modelos internos. Casa por nome (case-insensitive).
 */
export async function POST(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const role = (authResult.user as { role?: string }).role;
      if (role !== "ADMIN" && role !== "MANAGER") {
        return NextResponse.json(
          { message: "Apenas administradores e gerentes podem importar dados." },
          { status: 403 },
        );
      }

      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { message: 'Envie o arquivo CSV no campo "file".' },
          { status: 400 },
        );
      }

      const delimiter = readDelimiterFlag(formData);
      const updateExisting = readUpdateExistingFlag(formData);
      const { headers, rows } = await readUploadedTable(file, delimiter);

      if (rows.length > MAX_ROWS) {
        return NextResponse.json(
          { message: `Limite de ${MAX_ROWS} linhas por importação.` },
          { status: 400 },
        );
      }

      const headerMap = new Map<string, string>();
      for (const h of headers) {
        headerMap.set(h, KEY_ALIASES[norm(h)] ?? h);
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      const failed: { row: number; message: string }[] = [];

      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i]!;
        const mapped: Record<string, string> = {};
        for (const [src, dest] of headerMap) {
          mapped[dest] = (raw[src] ?? "").trim();
        }

        const name = cell(mapped, "name");
        const content = cell(mapped, "content");
        if (!name || !content) {
          failed.push({
            row: i + 2,
            message: "Nome e conteúdo são obrigatórios.",
          });
          continue;
        }

        try {
          const existing = await prisma.messageTemplate.findFirst({
            where: { name: { equals: name, mode: "insensitive" } },
            select: { id: true },
          });

          const channelType = parseChannel(cell(mapped, "channelType"));
          const status = parseStatus(cell(mapped, "status"));
          const language = cell(mapped, "language") || undefined;
          const category = cell(mapped, "category") || undefined;
          const mediaUrl = cell(mapped, "mediaUrl") || undefined;
          const mediaType = cell(mapped, "mediaType") || undefined;
          const mediaName = cell(mapped, "mediaName") || undefined;

          if (existing) {
            if (!updateExisting) {
              skipped += 1;
              continue;
            }
            await updateTemplate(existing.id, {
              name,
              content,
              category,
              language,
              status,
              ...(channelType !== undefined ? { channelType } : {}),
              ...(mediaUrl !== undefined ? { mediaUrl } : {}),
              ...(mediaType !== undefined ? { mediaType } : {}),
              ...(mediaName !== undefined ? { mediaName } : {}),
            });
            updated += 1;
          } else {
            await createTemplate({
              name,
              content,
              category,
              language,
              channelType,
              mediaUrl,
              mediaType,
              mediaName,
            });
            created += 1;
          }
        } catch (err) {
          failed.push({
            row: i + 2,
            message: err instanceof Error ? err.message : "Falha ao gravar.",
          });
        }
      }

      return NextResponse.json({ created, updated, skipped, failed });
    });
  } catch (e) {
    console.error("[templates/import]", e);
    return NextResponse.json(
      { message: "Erro ao importar modelos internos." },
      { status: 500 },
    );
  }
}
