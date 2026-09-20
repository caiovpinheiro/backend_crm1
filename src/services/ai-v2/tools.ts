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

  const where: Record<string, unknown> = {
    organizationId: orgId,
    isActive: true,
  };
  if (args.type) where.type = args.type;

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

export async function searchV2CrmRecords(args: {
  query: string;
  scope?: "current_contact" | "organization";
  contactId?: string;
  dealId?: string;
  limit?: number;
}): Promise<{
  query: string;
  contacts: Array<Record<string, unknown>>;
  deals: Array<Record<string, unknown>>;
}> {
  const orgId = getOrgIdOrThrow();
  const term = args.query.trim();
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 10);
  const scopeOrg = args.scope === "organization";

  const contacts: any[] = await (prisma as any).contact.findMany({
    where: {
      organizationId: orgId,
      ...(scopeOrg ? {} : args.contactId ? { id: args.contactId } : { id: "" }),
    },
    take: scopeOrg ? 200 : 1,
    include: { customValues: { include: { customField: { select: { name: true, label: true } } } } },
  });

  const matchedContacts = contacts
    .map((c: any) => {
      const cfText = c.customValues.map((v: any) => `${v.customField.name} ${v.value}`).join(" ");
      const score =
        scoreTextMatch(c.name ?? "", term) +
        scoreTextMatch(c.phone ?? "", term) +
        scoreTextMatch(c.email ?? "", term) +
        scoreTextMatch(cfText, term);
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        customFields: c.customValues
          .filter((v: any) => v.value && v.value.trim())
          .map((v: any) => ({ label: v.customField.label ?? v.customField.name, value: v.value })),
        score,
      };
    })
    .filter((c: any) => c.score > 0 || (!scopeOrg && args.contactId))
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit);

  const deals: any[] = await (prisma as any).deal.findMany({
    where: {
      organizationId: orgId,
      status: { not: "LOST" },
      ...(scopeOrg
        ? {}
        : args.contactId
          ? { contactId: args.contactId }
          : args.dealId
            ? { id: args.dealId }
            : { id: "" }),
    },
    take: scopeOrg ? 200 : 5,
    include: {
      stage: { select: { id: true, name: true } },
      customValues: { include: { customField: { select: { name: true, label: true } } } },
    },
  });

  const matchedDeals = deals
    .map((d: any) => {
      const cfText = d.customValues.map((v: any) => `${v.customField.name} ${v.value}`).join(" ");
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
        customFields: d.customValues
          .filter((v: any) => v.value && v.value.trim())
          .map((v: any) => ({ label: v.customField.label ?? v.customField.name, value: v.value })),
        score,
      };
    })
    .filter((d: any) => d.score > 0 || (!scopeOrg && (args.contactId || args.dealId)))
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit);

  return {
    query: term,
    contacts: matchedContacts.map(({ score: _s, ...rest }: any) => rest),
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
  );
  const allowed = args.allowedDocIds && args.allowedDocIds.length > 0 ? new Set(args.allowedDocIds) : null;
  const filtered = allowed
    ? chunks.filter((c) => allowed.has(c.docId))
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
