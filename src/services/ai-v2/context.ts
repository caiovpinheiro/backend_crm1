/**
 * Carrega contato, negócios abertos e campos permitidos para o motor v2.
 * Nenhum domínio de cliente aqui.
 */

import { derivedFieldValues, maskFieldValue } from "@/lib/ai-v2/field-mask";
import { prisma } from "@/lib/prisma";
import {
  loadCrmFieldCatalog,
  partitionFieldValues,
  crmFieldKey,
  type CrmFieldExposure,
} from "@/services/ai/crm-field-policy";
import type { V2AgentConfig, V2CRMContext, V2FieldConfig } from "@/lib/ai-v2/types";

export type V2LoadedContext = V2CRMContext & {
  exposure: CrmFieldExposure;
  contactId?: string;
  dealId?: string;
  dealSelectionReason: string;
};

function normalizeFieldValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  // Decimal do Prisma vira número; Date vira ISO string.
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && !Array.isArray(value)) {
    const anyValue = value as { toNumber?: () => number; toString?: () => string };
    if (typeof anyValue.toNumber === "function") {
      return anyValue.toNumber();
    }
  }
  // Arrays e objetos genéricos viram string JSON para não renderizar [object Object].
  return JSON.stringify(value);
}

function buildExposure(config: V2AgentConfig): CrmFieldExposure {
  const readableKeys: string[] = [];
  const citableKeys: string[] = [];
  const add = (fields: V2FieldConfig[], entity: string) => {
    for (const f of fields) {
      const key = crmFieldKey(entity, f.key);
      if (f.permissions.includes("read") || f.permissions.includes("cite")) {
        readableKeys.push(key);
      }
      if (f.permissions.includes("cite")) {
        citableKeys.push(key);
      }
    }
  };
  add(config.contextFields.contact, "contact");
  add(config.contextFields.deal, "deal");
  return { readableKeys, citableKeys, orgWide: false };
}

async function loadContactFields(
  contactId: string,
  allowedKeys: string[],
): Promise<Record<string, unknown>> {
  const contact = await (prisma as unknown as {
    contact: {
      findUnique: (args: {
        where: { id: string };
        select: Record<string, unknown>;
      }) => Promise<Record<string, unknown> | null>;
    };
  }).contact.findUnique({
    where: { id: contactId },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      tags: { select: { tag: { select: { name: true } } } },
      customFields: { select: { customFieldId: true, value: true } },
    } as Record<string, unknown>,
  });
  if (!contact) return {};

  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key.startsWith("contact.")) {
      const fieldName = key.replace("contact.", "");
      if (contact[fieldName] !== undefined) out[fieldName] = normalizeFieldValue(contact[fieldName]);
    }
  }
  // Campos customizados vêm da relação ContactCustomFieldValue.
  const customFields = Array.isArray(contact.customFields)
    ? (contact.customFields as Array<{ customFieldId: string; value: unknown }>)
    : [];
  for (const cf of customFields) {
    if (allowedKeys.includes(`contact.${cf.customFieldId}`)) {
      out[cf.customFieldId] = normalizeFieldValue(cf.value);
    }
  }
  out.id = contact.id;
  out.name = contact.name;
  out.phone = contact.phone;
  out.email = contact.email;
  if (Array.isArray(contact.tags)) {
    out.tags = (contact.tags as Array<{ tag?: { name?: string } }>)
      .map((t) => t.tag?.name)
      .filter((n): n is string => Boolean(n));
  }
  // Normaliza valores finais para não vazar objetos (ex.: Decimal, Date).
  for (const k of Object.keys(out)) {
    out[k] = normalizeFieldValue(out[k]);
  }
  return out;
}

async function loadDealFields(
  dealId: string,
  allowedKeys: string[],
): Promise<Record<string, unknown> | null> {
  const deal = await (prisma as unknown as {
    deal: {
      findUnique: (args: {
        where: { id: string };
        select: Record<string, unknown>;
      }) => Promise<Record<string, unknown> | null>;
    };
  }).deal.findUnique({
    where: { id: dealId },
    select: {
      id: true,
      title: true,
      stage: { select: { id: true, name: true } },
      status: true,
      value: true,
      customFields: { select: { customFieldId: true, value: true } },
    } as Record<string, unknown>,
  });
  if (!deal) return null;

  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key.startsWith("deal.")) {
      const fieldName = key.replace("deal.", "");
      if (deal[fieldName] !== undefined) out[fieldName] = normalizeFieldValue(deal[fieldName]);
    }
  }
  const dealCustomFields = Array.isArray(deal.customFields)
    ? (deal.customFields as Array<{ customFieldId: string; value: unknown }>)
    : [];
  for (const cf of dealCustomFields) {
    if (allowedKeys.includes(`deal.${cf.customFieldId}`)) {
      out[cf.customFieldId] = normalizeFieldValue(cf.value);
    }
  }
  out.id = deal.id;
  out.title = deal.title;
  if (deal.stage) {
    out.stageId = (deal.stage as { id: string; name: string }).id;
    out.stageName = (deal.stage as { id: string; name: string }).name;
  }
  out.status = deal.status;
  out.value = deal.value;
  // Normaliza valores finais para não vazar objetos (ex.: Decimal, Date).
  for (const k of Object.keys(out)) {
    out[k] = normalizeFieldValue(out[k]);
  }
  return out;
}

export function buildDealDisplay(
  deal: Record<string, unknown>,
  config: V2AgentConfig,
): string {
  const citableKeys = new Set(
    config.contextFields.deal.filter((f) => f.permissions.includes("cite")).map((f) => f.key),
  );
  const parts: string[] = [];
  if (citableKeys.has("title") && deal.title) parts.push(String(deal.title));
  if (citableKeys.has("stageName") && deal.stageName) parts.push(String(deal.stageName));
  for (const f of config.contextFields.deal) {
    if (f.key === "title" || f.key === "stageName") continue;
    if (!f.permissions.includes("cite")) continue;
    const v = deal[f.key];
    if (v === null || v === undefined || v === "") continue;
    parts.push(`${f.label ?? f.key}: ${v}`);
  }
  // Fallback mínimo se nada é citável.
  if (parts.length === 0 && deal.title) parts.push(String(deal.title));
  return parts.join(" — ");
}

export function tryParseDealChoice(
  text: string,
  deals: Array<Record<string, unknown>>,
  config: V2AgentConfig,
): string | null {
  const normalized = text.toLowerCase().trim();
  // Resposta por número da opção (1, 2, 3…)
  let number = "";
  let started = false;
  for (const ch of normalized) {
    if (ch >= "0" && ch <= "9") {
      number += ch;
      started = true;
    } else if (started) {
      break;
    }
  }
  if (number) {
    const idx = parseInt(number, 10) - 1;
    if (idx >= 0 && idx < deals.length) return String(deals[idx].id);
  }
  // Resposta pelo nome/valor de campos marcados como "Citar".
  const citableKeys = new Set(
    config.contextFields.deal.filter((f) => f.permissions.includes("cite")).map((f) => f.key),
  );
  for (const deal of deals) {
    const values: string[] = [];
    for (const key of citableKeys) {
      const v = deal[key];
      if (v !== null && v !== undefined && String(v).trim()) {
        values.push(String(v).toLowerCase());
      }
    }
    for (const value of values) {
      if (value.length >= 2 && normalized.includes(value)) return String(deal.id);
    }
  }
  return null;
}

export function buildAskDealMessage(
  deals: Array<Record<string, unknown>>,
  config: V2AgentConfig,
): string {
  let msg = "Você tem mais de um negócio aberto. Qual deles você quer tratar?";
  for (let i = 0; i < deals.length; i++) {
    const display = buildDealDisplay(deals[i], config);
    msg += `\n${i + 1}. ${display}`;
  }
  return msg;
}

export async function loadV2Context(args: {
  organizationId: string;
  conversationId?: string;
  contactId?: string;
  config: V2AgentConfig;
  selectedDealId?: string;
}): Promise<V2LoadedContext> {
  const exposure = buildExposure(args.config);

  let contactId = args.contactId;
  if (!contactId && args.conversationId) {
    const conv = await (prisma as unknown as {
      conversation: {
        findUnique: (args: { where: { id: string }; select: { contactId: boolean } }) => Promise<{ contactId: string | null } | null>;
      };
    }).conversation.findUnique({
      where: { id: args.conversationId },
      select: { contactId: true },
    });
    contactId = conv?.contactId ?? undefined;
  }

  let contact: Record<string, unknown> | null = null;
  if (contactId) {
    contact = await loadContactFields(contactId, exposure.readableKeys);
  }

  // Busca negócios abertos do contato, mais recente primeiro
  let deals: Array<Record<string, unknown>> = [];
  let selectedDeal: Record<string, unknown> | null = null;
  let dealId: string | undefined;
  if (contactId) {
    const rows = await (prisma as unknown as {
      deal: {
        findMany: (args: {
          where: { contactId: string; status?: { not: string } };
          orderBy: { updatedAt: "desc" };
          take: number;
          select: { id: boolean };
        }) => Promise<Array<{ id: string }>>;
      };
    }).deal.findMany({
      where: { contactId, status: { not: "LOST" } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true },
    });
    for (const row of rows) {
      const d = await loadDealFields(row.id, exposure.readableKeys);
      if (d) deals.push(d);
    }

    if (deals.length > 0) {
      if (args.config.dealSelection === "ask" && deals.length > 1) {
        // Se a conversa já tem uma escolha salva, respeita.
        const picked = args.selectedDealId
          ? deals.find((d) => String(d.id) === args.selectedDealId)
          : undefined;
        if (picked) {
          selectedDeal = picked;
          dealId = String(picked.id);
        } else {
          selectedDeal = null;
          dealId = undefined;
        }
      } else {
        // latest (padrão) ou só existe um negócio aberto.
        selectedDeal = deals[0];
        dealId = String(selectedDeal.id);
      }
    }
  }

  const dealSelectionReason =
    args.config.dealSelection === "ask" && deals.length > 1
      ? selectedDeal
        ? "Negócio escolhido pelo cliente salvo na conversa."
        : "Modo 'perguntar': há vários negócios abertos; aguardando escolha do cliente."
      : deals.length > 0
        ? "Negócio mais recente selecionado automaticamente."
        : "Nenhum negócio aberto encontrado.";

  // Campos permitidos com metadados do catálogo
  const catalog = await loadCrmFieldCatalog({
    sensitiveTerms: [],
  });

  const contactFieldConfigs = args.config.contextFields.contact.map((f) => {
    const key = crmFieldKey("contact", f.key);
    const descriptor = catalog.fields.find((d) => d.key === key);
    return {
      field: descriptor ?? {
        key,
        entity: "contact",
        name: f.key,
        label: f.label ?? f.key,
        source: "custom" as const,
        type: null,
        sensitiveHint: false,
        valueAvailable: true,
        readable: true,
      },
      value: contact?.[f.key] != null ? maskFieldValue(String(contact[f.key]), f.mask) : "",
    };
  });

  const selectedDealFields = args.config.contextFields.deal.map((f) => {
    const key = crmFieldKey("deal", f.key);
    const descriptor = catalog.fields.find((d) => d.key === key);
    const value = selectedDeal?.[f.key] != null ? maskFieldValue(String(selectedDeal[f.key]), f.mask) : "";
    return { field: descriptor ?? {
      key,
      entity: "deal",
      name: f.key,
      label: f.label ?? f.key,
      source: "custom" as const,
      type: null,
      sensitiveHint: false,
      valueAvailable: true,
      readable: true,
    }, value };
  });

  const contactPartition = partitionFieldValues(contactFieldConfigs, exposure);
  const dealPartition = partitionFieldValues(selectedDealFields, exposure);

  const visibleContact: Record<string, unknown> = {};
  for (const v of contactPartition.visible) visibleContact[v.label] = v.value;
  const citableContact: Record<string, unknown> = {};
  for (const v of contactPartition.citable) citableContact[v.label] = v.value;

  // Informações montadas (config): o agente pode dizer ao cliente; o motor
  // calcula a partir dos campos, o modelo só recebe o resultado.
  for (const [label, value] of Object.entries(derivedFieldValues(args.config, contact, selectedDeal))) {
    visibleContact[label] = value;
    citableContact[label] = value;
  }

  const visibleDeal: Record<string, unknown> = {};
  for (const v of dealPartition.visible) visibleDeal[v.label] = v.value;
  const citableDeal: Record<string, unknown> = {};
  for (const v of dealPartition.citable) citableDeal[v.label] = v.value;

  return {
    contact: visibleContact,
    contactRaw: contact,
    citableContact,
    deals,
    selectedDeal: selectedDeal ? visibleDeal : null,
    selectedDealRaw: selectedDeal,
    citableDeal: selectedDeal ? citableDeal : null,
    fields: args.config.contextFields,
    exposure,
    contactId,
    dealId,
    dealSelectionReason,
  };
}
