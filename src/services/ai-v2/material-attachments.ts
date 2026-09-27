/**
 * Anexos dos materiais: vídeo, imagem, áudio ou PDF ligados a um material
 * da base. Quando o agente lê um trecho do material, vê a lista de anexos
 * (com o "quando enviar" escrito por quem configura) e pode mandar ao
 * cliente depois da resposta, pelo mesmo envio das mensagens prontas.
 * Tabela própria do motor v2 (o material é compartilhado com o motor
 * antigo). Nenhum domínio de cliente.
 */

import { randomUUID } from "node:crypto";
import { prismaBase } from "@/lib/prisma-base";
import { isOrgOwnedStorageUrl } from "@/lib/storage/read-for-send";

export const MATERIAL_ATTACHMENT_LIMITS = { perMaterial: 5, perTurnOffered: 6, perReply: 2, descriptionChars: 300, nameChars: 120 };

export type V2MaterialAttachmentKind = "image" | "video" | "audio" | "document";

/**
 * Quando o mesmo anexo pode sair de novo na conversa: "7d" (padrão, a trava
 * de sempre), "24h", "30m" ou "always" (sai toda vez que for usado).
 * A contagem começa no último #reset.
 */
export type V2AttachmentResendWindow = "always" | "30m" | "24h" | "7d";
export const RESEND_WINDOWS: V2AttachmentResendWindow[] = ["always", "30m", "24h", "7d"];
const RESEND_WINDOW_MS: Record<V2AttachmentResendWindow, number> = { always: 0, "30m": 30 * 60_000, "24h": 24 * 3_600_000, "7d": 7 * 86_400_000 };

/** A partir de quando um envio anterior conta como repetição (para o envio de anexos). */
export function resendSince(window: V2AttachmentResendWindow, lastReset: Date | null, now: Date = new Date()): Date {
  const ms = RESEND_WINDOW_MS[window] ?? RESEND_WINDOW_MS["7d"];
  // "Sempre": nada antes de agora conta.
  const fromWindow = ms === 0 ? now.getTime() : now.getTime() - ms;
  return new Date(Math.max(fromWindow, lastReset?.getTime() ?? 0));
}

export type V2MaterialAttachment = {
  id: string;
  docId: string;
  url: string;
  mimeType: string | null;
  name: string;
  /** Quando enviar (vai para o agente decidir). */
  description: string;
  /** Envia sempre que o material for a principal fonte da resposta. */
  autoSend: boolean;
  /** Quando pode repetir na mesma conversa. */
  resendWindow: V2AttachmentResendWindow;
  kind: V2MaterialAttachmentKind;
  position: number;
  createdAt: string;
};

export function attachmentKind(mimeType: string | null | undefined): V2MaterialAttachmentKind {
  const m = (mimeType ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}

export const ATTACHMENT_KIND_LABEL: Record<V2MaterialAttachmentKind, string> = {
  image: "imagem",
  video: "vídeo",
  audio: "áudio",
  document: "documento",
};

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
};

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady || process.env.NODE_ENV === "test") return;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_material_attachments" (
      "id" TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "docId" TEXT NOT NULL,
      "url" TEXT NOT NULL,
      "mimeType" TEXT,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "position" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_v2_material_attachments_doc_idx" ON "ai_v2_material_attachments" ("agentId", "docId")`);
  await db.$executeRawUnsafe(`ALTER TABLE "ai_v2_material_attachments" ADD COLUMN IF NOT EXISTS "autoSend" BOOLEAN NOT NULL DEFAULT false`);
  await db.$executeRawUnsafe(`ALTER TABLE "ai_v2_material_attachments" ADD COLUMN IF NOT EXISTS "resendWindow" TEXT NOT NULL DEFAULT '7d'`);
  schemaReady = true;
}

function toAttachment(r: Record<string, unknown>): V2MaterialAttachment {
  const mimeType = (r.mimeType as string | null) ?? null;
  return {
    id: String(r.id),
    docId: String(r.docId),
    url: String(r.url),
    mimeType,
    name: String(r.name ?? ""),
    description: String(r.description ?? ""),
    autoSend: r.autoSend === true,
    resendWindow: RESEND_WINDOWS.includes(r.resendWindow as V2AttachmentResendWindow) ? (r.resendWindow as V2AttachmentResendWindow) : "7d",
    kind: attachmentKind(mimeType),
    position: Number(r.position ?? 0),
    createdAt: new Date(r.createdAt as string).toISOString(),
  };
}

function clean(text: unknown, max: number): string {
  return typeof text === "string" ? text.trim().slice(0, max) : "";
}

/** O material é deste agente (e desta organização). */
async function assertDoc(organizationId: string, agentId: string, docId: string): Promise<void> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "ai_agent_knowledge_docs" WHERE "id" = $1 AND "agentId" = $2 AND "organizationId" = $3`,
    docId, agentId, organizationId,
  );
  if (rows.length === 0) throw new Error("Material não encontrado.");
}

export async function listMaterialAttachments(organizationId: string, agentId: string, docId: string): Promise<V2MaterialAttachment[]> {
  await ensureSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM "ai_v2_material_attachments" WHERE "organizationId" = $1 AND "agentId" = $2 AND "docId" = $3 ORDER BY "position", "createdAt"`,
    organizationId, agentId, docId,
  );
  return rows.map(toAttachment);
}

export async function addMaterialAttachment(args: {
  organizationId: string;
  agentId: string;
  docId: string;
  url: unknown;
  mimeType: unknown;
  name: unknown;
  description?: unknown;
}): Promise<V2MaterialAttachment> {
  await ensureSchema();
  await assertDoc(args.organizationId, args.agentId, args.docId);
  const url = clean(args.url, 2000);
  // Só arquivo que subiu pelo armazenamento da organização (o envio também confere).
  if (!url || !isOrgOwnedStorageUrl(url)) throw new Error("Arquivo inválido: envie pelo botão de anexar.");
  const existing = await listMaterialAttachments(args.organizationId, args.agentId, args.docId);
  if (existing.length >= MATERIAL_ATTACHMENT_LIMITS.perMaterial) {
    throw new Error(`Cada material aceita até ${MATERIAL_ATTACHMENT_LIMITS.perMaterial} anexos.`);
  }
  const id = randomUUID();
  const mimeType = clean(args.mimeType, 100) || null;
  const name = clean(args.name, MATERIAL_ATTACHMENT_LIMITS.nameChars) || "arquivo";
  const description = clean(args.description, MATERIAL_ATTACHMENT_LIMITS.descriptionChars);
  await db.$executeRawUnsafe(
    `INSERT INTO "ai_v2_material_attachments" ("id","organizationId","agentId","docId","url","mimeType","name","description","position")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    id, args.organizationId, args.agentId, args.docId, url, mimeType, name, description, existing.length,
  );
  const [row] = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "ai_v2_material_attachments" WHERE "id" = $1`, id);
  return toAttachment(row);
}

export async function updateMaterialAttachment(args: {
  organizationId: string;
  agentId: string;
  attachmentId: string;
  name?: unknown;
  description?: unknown;
  autoSend?: unknown;
  resendWindow?: unknown;
}): Promise<V2MaterialAttachment | null> {
  await ensureSchema();
  const sets: string[] = [];
  const values: unknown[] = [args.attachmentId, args.organizationId, args.agentId];
  if (args.name !== undefined) {
    values.push(clean(args.name, MATERIAL_ATTACHMENT_LIMITS.nameChars) || "arquivo");
    sets.push(`"name" = $${values.length}`);
  }
  if (args.description !== undefined) {
    values.push(clean(args.description, MATERIAL_ATTACHMENT_LIMITS.descriptionChars));
    sets.push(`"description" = $${values.length}`);
  }
  if (typeof args.autoSend === "boolean") {
    values.push(args.autoSend);
    sets.push(`"autoSend" = $${values.length}`);
  }
  if (typeof args.resendWindow === "string" && RESEND_WINDOWS.includes(args.resendWindow as V2AttachmentResendWindow)) {
    values.push(args.resendWindow);
    sets.push(`"resendWindow" = $${values.length}`);
  }
  if (sets.length > 0) {
    await db.$executeRawUnsafe(
      `UPDATE "ai_v2_material_attachments" SET ${sets.join(", ")} WHERE "id" = $1 AND "organizationId" = $2 AND "agentId" = $3`,
      ...values,
    );
  }
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM "ai_v2_material_attachments" WHERE "id" = $1 AND "organizationId" = $2 AND "agentId" = $3`,
    args.attachmentId, args.organizationId, args.agentId,
  );
  return rows[0] ? toAttachment(rows[0]) : null;
}

export async function deleteMaterialAttachment(organizationId: string, agentId: string, attachmentId: string): Promise<boolean> {
  await ensureSchema();
  const n = await db.$executeRawUnsafe(
    `DELETE FROM "ai_v2_material_attachments" WHERE "id" = $1 AND "organizationId" = $2 AND "agentId" = $3`,
    attachmentId, organizationId, agentId,
  );
  return n > 0;
}

/** Anexos dos materiais lidos no turno (para o prompt). Falha: lista vazia. */
export async function attachmentsForDocs(agentId: string, docIds: string[]): Promise<Array<V2MaterialAttachment & { docTitle: string }>> {
  const ids = [...new Set(docIds.filter(Boolean))];
  if (ids.length === 0) return [];
  try {
    await ensureSchema();
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT a.*, d."title" AS "docTitle"
         FROM "ai_v2_material_attachments" a
         JOIN "ai_agent_knowledge_docs" d ON d."id" = a."docId" AND d."agentId" = a."agentId"
        WHERE a."agentId" = $1 AND a."docId" = ANY($2::text[])
        ORDER BY array_position($2::text[], a."docId"), a."position"
        LIMIT $3`,
      agentId, ids, MATERIAL_ATTACHMENT_LIMITS.perTurnOffered,
    );
    return rows.map((r) => ({ ...toAttachment(r), docTitle: String(r.docTitle ?? "") }));
  } catch (err) {
    console.warn("[ai-v2] anexos dos materiais indisponíveis:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Anexos pelo id (para enviar). */
export async function attachmentsByIds(agentId: string, ids: string[]): Promise<V2MaterialAttachment[]> {
  if (ids.length === 0) return [];
  await ensureSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM "ai_v2_material_attachments" WHERE "agentId" = $1 AND "id" = ANY($2::text[])`,
    agentId, ids,
  );
  const byId = new Map(rows.map((r) => [String(r.id), toAttachment(r)]));
  return ids.map((id) => byId.get(id)).filter((a): a is V2MaterialAttachment => !!a);
}

/**
 * Anexos pedidos que já saíram na conversa dentro da trava de cada um (o
 * envio os barraria). Mesma conta do envio: janela do anexo, no máximo 7
 * dias, a partir do último #reset.
 */
export async function attachmentsBlockedByResend(agentId: string, conversationId: string, ids: string[], now: Date = new Date()): Promise<Set<string>> {
  const list = await attachmentsByIds(agentId, ids);
  if (list.length === 0) return new Set();
  const { lastV2ResetAt } = await import("./sent-materials");
  const { prisma } = await import("@/lib/prisma");
  const lastReset = await lastV2ResetAt(conversationId).catch(() => null);
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const sinceOf = (a: V2MaterialAttachment) => Math.max(weekAgo, resendSince(a.resendWindow, lastReset, now).getTime());
  // Envio que falhou não conta (o anexo não chegou; pode sair de novo).
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      mediaUrl: { in: list.map((a) => a.url) },
      createdAt: { gte: new Date(Math.min(...list.map(sinceOf))) },
      sendStatus: { not: "failed" },
    },
    select: { mediaUrl: true, createdAt: true },
  });
  return new Set(list.filter((a) => rows.some((r) => r.mediaUrl === a.url && new Date(r.createdAt).getTime() >= sinceOf(a))).map((a) => a.id));
}

/** Linhas do prompt: o que dá para enviar e quando. */
export function attachmentsPromptSection(list: Array<Pick<V2MaterialAttachment, "id" | "kind" | "name" | "description"> & { docTitle: string }>): string {
  if (list.length === 0) return "";
  return [
    "# Anexos dos materiais",
    `Arquivos ligados aos materiais acima. Para enviar ao cliente, devolva attachments: ["<id>"] (até ${MATERIAL_ATTACHMENT_LIMITS.perReply}). Envie quando ajudar o cliente a ver ou ouvir o que a resposta explica (onde clicar, como fazer, o documento pedido). O anexo chega depois da sua reply: a reply apresenta em uma frase curta, sem descrever o arquivo.`,
    ...list.map((a) => `- ${a.id}: ${ATTACHMENT_KIND_LABEL[a.kind]} "${a.name}" (material "${a.docTitle}")${a.description ? ` — enviar quando: ${a.description}` : ""}`),
  ].join("\n");
}
