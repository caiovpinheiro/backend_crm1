/**
 * Carrega contato, negócios abertos e campos permitidos para o motor v2.
 * Nenhum domínio de cliente aqui.
 */

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
};

function buildExposure(config: V2AgentConfig): CrmFieldExposure {
  const keys: string[] = [];
  const add = (fields: V2FieldConfig[], entity: string) => {
    for (const f of fields) {
      if (f.permissions.includes("read") || f.permissions.includes("cite")) {
        keys.push(crmFieldKey(entity, f.key));
      }
    }
  };
  add(config.contextFields.contact, "contact");
  add(config.contextFields.deal, "deal");
  return { readableKeys: keys, orgWide: false };
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
      customValues: true,
      tags: { select: { tag: { select: { name: true } } } },
    } as Record<string, unknown>,
  });
  if (!contact) return {};

  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key.startsWith("contact.")) {
      const fieldName = key.replace("contact.", "");
      if (contact[fieldName] !== undefined) out[fieldName] = contact[fieldName];
    }
  }
  // Campos customizados vêm em customValues (JSON)
  if (contact.customValues && typeof contact.customValues === "object") {
    const custom = contact.customValues as Record<string, unknown>;
    for (const [k, v] of Object.entries(custom)) {
      if (allowedKeys.includes(`contact.${k}`)) out[k] = v;
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
      customValues: true,
    } as Record<string, unknown>,
  });
  if (!deal) return null;

  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key.startsWith("deal.")) {
      const fieldName = key.replace("deal.", "");
      if (deal[fieldName] !== undefined) out[fieldName] = deal[fieldName];
    }
  }
  if (deal.customValues && typeof deal.customValues === "object") {
    const custom = deal.customValues as Record<string, unknown>;
    for (const [k, v] of Object.entries(custom)) {
      if (allowedKeys.includes(`deal.${k}`)) out[k] = v;
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
  return out;
}

export async function loadV2Context(args: {
  organizationId: string;
  conversationId: string;
  contactId?: string;
  config: V2AgentConfig;
}): Promise<V2LoadedContext> {
  const exposure = buildExposure(args.config);

  let contactId = args.contactId;
  if (!contactId) {
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
      selectedDeal = deals[0];
      dealId = String(selectedDeal.id);
    }
  }

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
      value: contact?.[f.key] != null ? String(contact[f.key]) : "",
    };
  });

  const selectedDealFields = args.config.contextFields.deal.map((f) => {
    const key = crmFieldKey("deal", f.key);
    const descriptor = catalog.fields.find((d) => d.key === key);
    const value = selectedDeal?.[f.key] != null ? String(selectedDeal[f.key]) : "";
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

  const visibleDeal: Record<string, unknown> = {};
  for (const v of dealPartition.visible) visibleDeal[v.label] = v.value;

  return {
    contact: visibleContact,
    deals,
    selectedDeal: selectedDeal ? visibleDeal : null,
    fields: args.config.contextFields,
    exposure,
    contactId,
    dealId,
  };
}
