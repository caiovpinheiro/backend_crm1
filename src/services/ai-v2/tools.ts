/**
 * Tools de consulta do motor v2.
 * Nenhum domínio de cliente.
 *
 * Reutiliza services da v1 quando possível (RAG, modelos internos) e
 * implementa buscas locais para produtos e CRM. Todas as funções são
 * puros de entrada/saída para facilitar testes.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { retrieveAgentKnowledge } from "@/services/ai/retrieval";
import {
  retrieveRelevantMessageModels,
  type RetrievedMessageModel,
} from "@/services/ai/message-models-retrieval";

function normalizeSearch(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreTextMatch(haystack: string, query: string): number {
  const q = normalizeSearch(query);
  const h = normalizeSearch(haystack);
  if (!q || !h) return 0;
  if (h.includes(q)) return 100;
  const qWords = q.split(/\s+/).filter((w) => w.length >= 2);
  if (qWords.length === 0) return 0;
  const hWords = new Set(h.split(/\s+/).filter(Boolean));
  const hits = qWords.filter((w) => {
    for (const hw of hWords) {
      if (hw.includes(w) || w.includes(hw)) return true;
    }
    return false;
  }).length;
  if (hits === 0) return 0;
  return 20 + (hits / qWords.length) * 40;
}

export async function searchV2Products(args: {
  query: string;
  type?: "PRODUCT" | "SERVICE";
  allowedIds?: string[];
  limit?: number;
}): Promise<{
  query: string;
  total: number;
  products: Array<{
    id: string;
    name: string;
    sku: string | null;
    type: string;
    unit: string | null;
    price: number | null;
    priceFormatted: string | null;
    description: string | null;
    customFields: Array<{ name: string; label: string; value: string }>;
  }>;
}> {
  const orgId = getOrgIdOrThrow();
  const term = args.query.trim();
  const take = Math.min(Math.max(args.limit ?? 5, 1), 20);

  const allowedIds = Array.isArray(args.allowedIds) && args.allowedIds.length > 0 ? args.allowedIds : null;
  const where: Record<string, unknown> = {
    organizationId: orgId,
    isActive: true,
  };
  if (args.type) where.type = args.type;
  if (allowedIds) where.id = { in: allowedIds };

  const candidates = await prisma.product.findMany({
    where,
    take: 500,
    orderBy: { name: "asc" },
    include: {
      customValues: {
        include: {
          customField: { select: { id: true, name: true, label: true, type: true } },
        },
      },
    },
  });

  const scored = candidates
    .map((p) => {
      const cfText = p.customValues
        .map((v) => `${v.customField.name} ${v.customField.label} ${v.value}`)
        .join(" ");
      const score =
        scoreTextMatch(p.name, term) +
        scoreTextMatch(p.sku ?? "", term) +
        scoreTextMatch(p.description ?? "", term) +
        scoreTextMatch(cfText, term) * 0.5;
      return { product: p, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, take);

  const fmtBRL = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  return {
    query: term,
    total: scored.length,
    products: scored.map(({ product: p }) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      type: p.type,
      unit: p.unit,
      price: p.price ? Number(p.price) : null,
      priceFormatted: p.price ? fmtBRL.format(Number(p.price)) : null,
      description: p.description,
      customFields: p.customValues
        .filter((v) => v.value && v.value.trim())
        .map((v) => ({
          name: v.customField.name,
          label: v.customField.label,
          value: v.value,
        })),
    })),
  };
}

/**
 * Busca no contato e no negócio DA CONVERSA — nunca no CRM inteiro.
 *
 * Antes aceitava `scope: "organization"` e devolvia nome, telefone, e-mail e
 * todos os campos personalizados de até 200 contatos: qualquer cliente
 * podia pedir ao agente os dados de outra pessoa. Também ignorava as
 * permissões de campo do agente. Agora só volta o que a config libera
 * (`readableKeys`, no formato "contact.<chave>" / "deal.<chave>").
 *
 * (A relação em Contact/Deal é `customFields`; o código usava
 * `customValues`, que só existe em Product — toda chamada falhava.)
 */
export async function searchV2CrmRecords(args: {
  query: string;
  contactId?: string;
  dealId?: string;
  limit?: number;
  readableKeys?: string[];
}): Promise<{
  query: string;
  contacts: Array<Record<string, unknown>>;
  deals: Array<Record<string, unknown>>;
}> {
  const orgId = getOrgIdOrThrow();
  const term = args.query.trim();
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 10);
  const readable = new Set(args.readableKeys ?? []);
  if (!args.contactId && !args.dealId) return { query: term, contacts: [], deals: [] };

  const contacts: any[] = args.contactId
    ? await (prisma as any).contact.findMany({
        where: { organizationId: orgId, id: args.contactId },
        take: 1,
        include: { customFields: { include: { customField: { select: { name: true, label: true } } } } },
      })
    : [];

  const matchedContacts = contacts.map((c: any) => {
    const fields = (c.customFields ?? []).filter(
      (v: any) => v.value && String(v.value).trim() && readable.has(`contact.${v.customFieldId}`),
    );
    return {
      id: c.id,
      name: c.name,
      ...(readable.has("contact.phone") ? { phone: c.phone } : {}),
      ...(readable.has("contact.email") ? { email: c.email } : {}),
      customFields: fields.map((v: any) => ({ label: v.customField.label ?? v.customField.name, value: v.value })),
    };
  });

  const deals: any[] = await (prisma as any).deal.findMany({
    where: {
      organizationId: orgId,
      status: { not: "LOST" },
      ...(args.contactId ? { contactId: args.contactId } : { id: args.dealId }),
    },
    take: 5,
    include: {
      stage: { select: { id: true, name: true } },
      customFields: { include: { customField: { select: { name: true, label: true } } } },
    },
  });

  const matchedDeals = deals
    .map((d: any) => {
      const fields = (d.customFields ?? []).filter(
        (v: any) => v.value && String(v.value).trim() && readable.has(`deal.${v.customFieldId}`),
      );
      const cfText = fields.map((v: any) => `${v.customField.name} ${v.value}`).join(" ");
      const score =
        scoreTextMatch(d.title, term) +
        scoreTextMatch(cfText, term) +
        scoreTextMatch(d.stage?.name ?? "", term);
      return {
        id: d.id,
        title: d.title,
        status: d.status,
        value: d.value ? Number(d.value) : null,
        stage: d.stage,
        customFields: fields.map((v: any) => ({ label: v.customField.label ?? v.customField.name, value: v.value })),
        score,
      };
    })
    // Negócio da conversa entra sempre; entre vários, os que casam primeiro.
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit);

  return {
    query: term,
    contacts: matchedContacts,
    deals: matchedDeals.map(({ score: _s, ...rest }: any) => rest),
  };
}

export async function searchV2Knowledge(args: {
  agentId: string;
  apiKey: string;
  query: string;
  allowedDocIds?: string[];
  limit?: number;
}): Promise<{
  query: string;
  chunks: Array<{ docId: string; docTitle: string; content: string; distance: number }>;
}> {
  const { chunks } = await retrieveAgentKnowledge(
    args.agentId,
    args.query,
    args.apiKey,
    args.limit ?? 4,
    new Date(),
    args.allowedDocIds,
  );
  const allowedSet = Array.isArray(args.allowedDocIds)
    ? new Set(args.allowedDocIds)
    : null;
  const filtered = allowedSet
    ? chunks.filter((c) => allowedSet.has(c.docId))
    : chunks;
  return {
    query: args.query.trim(),
    chunks: filtered.map((c) => ({
      docId: c.docId,
      docTitle: c.docTitle,
      content: c.content,
      distance: c.distance,
    })),
  };
}

export type V2MessageModelSummary = { id: string; name: string; mediaKinds: string[] };

function mediaKindOf(mime: string | null, name: string | null): string {
  const t = (mime ?? "").toLowerCase();
  const n = (name ?? "").toLowerCase();
  if (t.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(n)) return "imagem";
  if (t.startsWith("video/") || /\.(mp4|mov|3gp)$/.test(n)) return "vídeo";
  if (t.startsWith("audio/") || /\.(mp3|ogg|opus|m4a|aac)$/.test(n)) return "áudio";
  return "documento";
}

/**
 * Mensagens prontas liberadas para o agente/assunto, com o tipo de mídia
 * anexada. Vai para o prompt: sem isso o modelo só descobria que uma
 * mensagem pronta existia (e tinha vídeo/imagem) se chamasse a busca.
 */
export async function describeV2MessageModels(ids: string[]): Promise<V2MessageModelSummary[]> {
  if (ids.length === 0) return [];
  const { mediaFromTemplateRow } = await import("@/services/ai/message-models-retrieval");
  const rows = await (prisma as any).messageTemplate.findMany({
    where: { organizationId: getOrgIdOrThrow(), id: { in: ids.slice(0, 50) } },
    select: { id: true, name: true, mediaUrl: true, mediaType: true, mediaName: true, attachments: true },
  });
  return (rows as Array<{ id: string; name: string; mediaUrl: string | null; mediaType: string | null; mediaName: string | null; attachments: unknown }>).map((r) => ({
    id: r.id,
    name: r.name,
    mediaKinds: mediaFromTemplateRow(r).map((m) => mediaKindOf(m.mimeType, m.name)),
  }));
}

export async function listV2MessageModels(args: {
  query: string;
  allowedIds?: string[];
  limit?: number;
}): Promise<{
  query: string;
  models: RetrievedMessageModel[];
}> {
  const models = await retrieveRelevantMessageModels(args.query, args.limit ?? 3);
  const allowed = args.allowedIds && args.allowedIds.length > 0 ? new Set(args.allowedIds) : null;
  const filtered = allowed ? models.filter((m) => allowed.has(m.id)) : models;
  return {
    query: args.query.trim(),
    models: filtered,
  };
}
