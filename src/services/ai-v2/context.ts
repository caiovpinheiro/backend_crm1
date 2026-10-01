/**
 * Carrega contato, negócios abertos e campos permitidos para o motor v2.
 * Nenhum domínio de cliente aqui.
 */

import { derivedFieldMissing, derivedFieldValues, maskFieldValue } from "@/lib/ai-v2/field-mask";
import { prisma } from "@/lib/prisma";
import {
  loadCrmFieldCatalog,
  partitionFieldValues,
  crmFieldKey,
  type CrmFieldExposure,
} from "@/services/ai/crm-field-policy";
import type { V2AgentConfig, V2CRMContext, V2FieldConfig } from "@/lib/ai-v2/types";

/** Campo configurado (usar/dizer) que veio sem valor neste cadastro. */
export type V2EmptyField = {
  entity: "contact" | "deal";
  label: string;
  /** Existe campo com o mesmo nome na outra entidade (contato × negócio). */
  onOtherEntity: boolean;
};

/** Como cada campo configurado foi achado no cadastro (para o passo "dados"). */
export type V2FieldDiagnostics = {
  /** Valores de campos personalizados que o registro tem no CRM. */
  contactCustomCount: number;
  dealCustomCount: number;
  dealLabel: string | null;
  /** Configurados achados pelo nome/rótulo (a chave gravada não é o id do campo). */
  byName: Array<{ entity: "contact" | "deal"; label: string; via: string }>;
  /** Configurados que não existem no CRM (nem por id, nem por nome/rótulo). */
  unknown: Array<{ entity: "contact" | "deal"; label: string }>;
};

export type V2LoadedContext = V2CRMContext & {
  exposure: CrmFieldExposure;
  emptyFields?: V2EmptyField[];
  fieldDiagnostics?: V2FieldDiagnostics;
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

type CustomValue = { id: string; name: string; label: string; value: string };

/** Valores personalizados do registro, fora do objeto (não vão ao prompt). */
const CUSTOM_VALUES = new WeakMap<object, CustomValue[]>();
const DEAL_NUMBER = new WeakMap<object, number>();

function customValuesOf(rows: Array<{ customFieldId: string; value: unknown; customField?: unknown }>): CustomValue[] {
  return rows.map((r) => {
    const def = (r.customField ?? {}) as { name?: string | null; label?: string | null };
    return { id: r.customFieldId, name: def.name ?? "", label: def.label ?? "", value: r.value == null ? "" : String(r.value) };
  });
}

const CONTACT_BUILTIN = new Set(["id", "name", "phone", "email", "tags"]);
const DEAL_BUILTIN = new Set([
  "id",
  "title",
  "stage",
  "stageId",
  "stageName",
  "pipelineName",
  "status",
  "value",
  "number",
  "lostReason",
  "expectedClose",
]);
const squashName = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

/**
 * Campo configurado cujo valor não veio pelo id: acha no mesmo registro pelo
 * nome técnico ou rótulo do campo. A chave gravada no agente pode ser o nome
 * do campo (o catálogo usa nome) e a leitura só aceitava o id — todo campo
 * personalizado vinha vazio, com o valor preenchido no CRM. Só no próprio
 * registro; nunca de outro contato ou negócio.
 */
function resolveConfiguredFields(
  record: Record<string, unknown>,
  entity: "contact" | "deal",
  fields: V2FieldConfig[],
  defs: Map<string, { name: string; label: string }>,
  diag: V2FieldDiagnostics,
): void {
  const custom = CUSTOM_VALUES.get(record) ?? [];
  const builtin = entity === "contact" ? CONTACT_BUILTIN : DEAL_BUILTIN;
  for (const f of fields) {
    if (!f.permissions.includes("read") && !f.permissions.includes("cite")) continue;
    if (builtin.has(f.key)) continue;
    const current = record[f.key];
    if (current !== null && current !== undefined && String(current).trim() !== "") continue;
    const def = defs.get(f.key);
    const label = def?.label || f.label || f.key;
    const wanted = new Set([def?.name, def?.label, f.label, f.key].filter((x): x is string => !!x).map(squashName).filter((x) => x.length >= 2));
    const matches = (c: CustomValue) => c.id === f.key || wanted.has(squashName(c.name)) || wanted.has(squashName(c.label));
    const hit = custom.find((c) => c.value.trim() !== "" && matches(c));
    if (hit) {
      record[f.key] = normalizeFieldValue(hit.value);
      if (hit.id !== f.key && !diag.byName.some((b) => b.entity === entity && b.label === label)) {
        diag.byName.push({ entity, label, via: hit.label || hit.name });
      }
      continue;
    }
    // Não existe no CRM: nem o id configurado, nem campo com esse nome/rótulo.
    if (!def && !custom.some(matches) && !diag.unknown.some((u) => u.entity === entity && u.label === label)) {
      diag.unknown.push({ entity, label });
    }
  }
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
      customFields: { select: { customFieldId: true, value: true, customField: { select: { name: true, label: true } } } },
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
  CUSTOM_VALUES.set(out, customValuesOf(customFields));
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
      stage: { select: { id: true, name: true, pipeline: { select: { name: true } } } },
      status: true,
      value: true,
      number: true,
      // Constam no catálogo de campos do negócio; sem estarem aqui o campo
      // liberado na tela chegava sempre vazio ao agente.
      lostReason: true,
      expectedClose: true,
      customFields: { select: { customFieldId: true, value: true, customField: { select: { name: true, label: true } } } },
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
  CUSTOM_VALUES.set(out, customValuesOf(dealCustomFields));
  if (typeof deal.number === "number") DEAL_NUMBER.set(out, deal.number);
  out.id = deal.id;
  out.title = deal.title;
  if (deal.stage) {
    const stage = deal.stage as { id: string; name: string; pipeline?: { name?: string | null } | null };
    out.stageId = stage.id;
    out.stageName = stage.name;
    if (stage.pipeline?.name) out.pipelineName = stage.pipeline.name;
    // "stage" é a chave do catálogo: o agente recebe o nome da etapa, não o
    // objeto da relação.
    if (allowedKeys.includes("deal.stage")) out.stage = stage.name;
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
  let usedLostDeal = false;
  if (contactId) {
    const dealClient = (prisma as unknown as {
      deal: {
        findMany: (args: {
          where: { contactId: string; status?: { not: string } | string };
          orderBy: { updatedAt: "desc" };
          take: number;
          select: { id: boolean };
        }) => Promise<Array<{ id: string }>>;
      };
    });
    const dealContactId = contactId;
    const findDeals = (status: { not: string } | string) =>
      dealClient.deal.findMany({
        where: { contactId: dealContactId, status },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true },
      });
    let rows = await findDeals({ not: "LOST" });
    // Negócio em andamento sempre vem primeiro; o perdido só entra quando
    // não há outro e o agente foi configurado para isso.
    if (rows.length === 0 && args.config.includeLostDeals) {
      rows = await findDeals("LOST");
      usedLostDeal = rows.length > 0;
    }
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

  // Campos configurados: além do id, pelo nome/rótulo no próprio registro.
  const diag: V2FieldDiagnostics = {
    contactCustomCount: contact ? (CUSTOM_VALUES.get(contact) ?? []).filter((c) => c.value.trim()).length : 0,
    dealCustomCount: selectedDeal ? (CUSTOM_VALUES.get(selectedDeal) ?? []).filter((c) => c.value.trim()).length : 0,
    dealLabel: selectedDeal ? `${DEAL_NUMBER.has(selectedDeal) ? `#${DEAL_NUMBER.get(selectedDeal)} ` : ""}${String(selectedDeal.title ?? "")}`.trim() : null,
    byName: [],
    unknown: [],
  };
  // Campos das informações montadas (ex.: um código montado de partes de campos) também: podem
  // não estar na lista de dados do cliente.
  const derivedFieldsOf = (entity: "contact" | "deal"): V2FieldConfig[] =>
    (args.config.derivedFields ?? [])
      .flatMap((d) => d.parts ?? [])
      .filter((p) => p.kind === "field" && !!p.key && (p.entity === "deal" ? "deal" : "contact") === entity)
      .filter((p) => !args.config.contextFields[entity].some((f) => f.key === p.key))
      .map((p) => ({ key: p.key as string, permissions: ["read"] }) as V2FieldConfig);
  const contactResolveFields = [...args.config.contextFields.contact, ...derivedFieldsOf("contact")];
  const dealResolveFields = [...args.config.contextFields.deal, ...derivedFieldsOf("deal")];
  const configuredKeys = [...contactResolveFields, ...dealResolveFields].map((f) => f.key);
  const defRows = configuredKeys.length
    ? await Promise.resolve()
        .then(() =>
          (prisma as unknown as { customField: { findMany: (a: unknown) => Promise<Array<{ id: string; name: string; label: string }>> } }).customField.findMany({
            where: { id: { in: configuredKeys } },
            select: { id: true, name: true, label: true },
          }),
        )
        .catch(() => [] as Array<{ id: string; name: string; label: string }>)
    : [];
  const defs = new Map((defRows ?? []).map((d) => [d.id, { name: d.name, label: d.label }]));
  if (contact) resolveConfiguredFields(contact, "contact", contactResolveFields, defs, diag);
  for (const d of deals) resolveConfiguredFields(d, "deal", dealResolveFields, defs, diag);

  const dealSelectionReason =
    args.config.dealSelection === "ask" && deals.length > 1
      ? selectedDeal
        ? "Negócio escolhido pelo cliente salvo na conversa."
        : "Modo 'perguntar': há vários negócios abertos; aguardando escolha do cliente."
      : deals.length > 0
        ? usedLostDeal
          ? "Nenhum negócio em andamento: usando o negócio perdido mais recente."
          : "Negócio mais recente selecionado automaticamente."
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

  // Configurado e vazio: o caso comum é o valor estar na outra entidade
  // (configurado em "Dados do contato", preenchido no negócio).
  const norm = (s: string) => s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const emptyFields: V2EmptyField[] = [];
  const collectEmpty = (
    entity: "contact" | "deal",
    configs: V2FieldConfig[],
    loaded: Array<{ field: { label: string }; value: string }>,
  ) => {
    const other = entity === "contact" ? "deal" : "contact";
    configs.forEach((f, i) => {
      if (!f.permissions.includes("read") && !f.permissions.includes("cite")) return;
      const item = loaded[i];
      if (!item || item.value !== "") return;
      const label = item.field.label || f.label || f.key;
      emptyFields.push({
        entity,
        label,
        onOtherEntity: catalog.fields.some((d) => d.entity === other && norm(d.label) === norm(label)),
      });
    });
  };
  if (contact) collectEmpty("contact", args.config.contextFields.contact, contactFieldConfigs);
  if (selectedDeal) collectEmpty("deal", args.config.contextFields.deal, selectedDealFields);

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
    emptyFields,
    contactId,
    dealId,
    dealSelectionReason,
    fieldDiagnostics: diag,
  };
}

/**
 * Passo "dados" do turno: o que o agente recebeu do cadastro — rótulos do que
 * ele usa e do que pode dizer, e cada informação montada (✓ ou por que não
 * saiu). Só nomes, nunca valores. Sem isto não dava para saber por que ele
 * respondeu "não tenho essa informação".
 */
export function describeV2ContextForTrace(config: V2AgentConfig, ctx: V2LoadedContext): string {
  const derivedLabels = new Set((config.derivedFields ?? []).map((d) => d.label?.trim()).filter(Boolean));
  const names = (obj: Record<string, unknown> | null | undefined) =>
    Object.keys(obj ?? {}).filter((k) => !derivedLabels.has(k));
  const part = (title: string, visible: Record<string, unknown> | null | undefined, citable: Record<string, unknown> | null | undefined) => {
    const use = names(visible);
    const say = names(citable);
    return `${title}: usa ${use.length ? use.join(", ") : "nenhum campo preenchido"}${say.length ? `; pode dizer ${say.join(", ")}` : ""}`;
  };
  const out: string[] = [];
  out.push(ctx.contactRaw ? part("Contato", ctx.contact, ctx.citableContact) : "Contato: sem cadastro");
  out.push(ctx.selectedDealRaw ? part("Negócio", ctx.selectedDeal, ctx.citableDeal) : "Negócio: nenhum");
  // Prova do que veio do CRM: sem isto não dava para saber se o dado falta
  // no cadastro ou se o agente não conseguiu ler o campo.
  const fd = ctx.fieldDiagnostics;
  if (fd) {
    if (ctx.selectedDealRaw) out.push(`Negócio lido: ${fd.dealLabel || "sem título"} (${fd.dealCustomCount} campo(s) personalizado(s) preenchido(s) no CRM)`);
    if (fd.byName.length) {
      out.push(`Achados pelo nome do campo (a configuração guarda o nome, não o id): ${fd.byName.map((b) => `${b.label} → “${b.via}”`).join(", ")}`);
    }
    if (fd.unknown.length) {
      out.push(`Configurados que não existem no CRM (escolha de novo em Dados do cliente): ${fd.unknown.map((u) => `${u.label} (${u.entity === "contact" ? "contato" : "negócio"})`).join(", ")}`);
    }
  }
  const empty = ctx.emptyFields ?? [];
  if (empty.length) {
    const where = (e: "contact" | "deal") => (e === "contact" ? "contato" : "negócio");
    out.push(
      `Configurados sem valor: ${empty
        .map((e) => `${e.label} (${where(e.entity)}${e.onOtherEntity ? `; há campo com esse nome no ${where(e.entity === "contact" ? "deal" : "contact")} — configure lá` : ""})`)
        .join(", ")}`,
    );
  }
  const derived = (config.derivedFields ?? []).filter((d) => d.label?.trim());
  if (derived.length) {
    out.push(
      `Informações montadas: ${derived
        .map((d) => {
          const why = derivedFieldMissing(d, config, ctx.contactRaw, ctx.selectedDealRaw);
          return why ? `${d.label} ✗ (${why})` : `${d.label} ✓`;
        })
        .join("; ")}`,
    );
  }
  return out.join(" · ");
}
