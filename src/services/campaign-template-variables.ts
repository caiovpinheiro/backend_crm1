/**
 * Variáveis de template em campanha TEMPLATE.
 *
 * O disparador grava em `Campaign.templateComponents` um payload com
 * placeholders `{{dealCustomFields.x}}` / `{{contact.name}}` etc. No envio,
 * o worker resolve por destinatário (negócio OPEN mais recente + CFs).
 *
 * Formato gravado (v1):
 * ```json
 * {
 *   "version": 1,
 *   "components": [ { "type": "body", "parameters": [{ "type": "text", "text": "{{dealCustomFields.x}}" }] } ],
 *   "headerMediaUrl": "{{dealCustomFields.imagem}}"
 * }
 * ```
 * Arrays legados (sem tokens) continuam válidos — envio idêntico para todos.
 */

import { prisma } from "@/lib/prisma";

export type CampaignTemplatePayload = {
  version?: number;
  components?: unknown[];
  /** Token CRM ou URL fixa HTTPS para header IMAGE/VIDEO/DOCUMENT. */
  headerMediaUrl?: string | null;
  /** Espelha o format do template — evita depender só da Graph no envio. */
  headerMediaType?: "image" | "video" | "document" | null;
};

const TOKEN_RE = /\{\{\s*([\w.]+)(?:\s*\|\s*([a-zA-Z0-9_]+))?\s*\}\}/g;

export function parseCampaignTemplatePayload(
  raw: unknown,
): CampaignTemplatePayload {
  if (raw == null) return {};
  if (Array.isArray(raw)) return { components: raw };
  if (typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const components = Array.isArray(o.components)
    ? (o.components as unknown[])
    : undefined;
  const headerMediaUrl =
    typeof o.headerMediaUrl === "string" ? o.headerMediaUrl : null;
  const rawType =
    typeof o.headerMediaType === "string"
      ? o.headerMediaType.trim().toLowerCase()
      : "";
  const headerMediaType =
    rawType === "image" || rawType === "video" || rawType === "document"
      ? rawType
      : null;
  return {
    version: typeof o.version === "number" ? o.version : 1,
    components,
    headerMediaUrl,
    headerMediaType,
  };
}

/** True se o payload (ou array legado) ainda tem token `{{...}}` a resolver. */
export function campaignTemplatePayloadIsDynamic(
  payload: CampaignTemplatePayload,
): boolean {
  if (payload.headerMediaUrl && /\{\{/.test(payload.headerMediaUrl)) {
    return true;
  }
  return JSON.stringify(payload.components ?? []).includes("{{");
}

function resolveDottedPath(
  root: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function valueToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Achatamento exigido pela Meta em parâmetros de texto (132000/132012). */
export function sanitizeTemplateParameterText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim();
}

export function interpolateCampaignTokenString(
  template: string,
  root: Record<string, unknown>,
): string {
  if (!template.includes("{{")) return template;
  return template.replace(
    TOKEN_RE,
    (_m, path: string, transform?: string) => {
      let value = valueToString(resolveDottedPath(root, path));
      if (transform) {
        const t = transform.trim().toLowerCase();
        if (t === "first" || t === "first_name" || t === "primeiro_nome") {
          value = value.trim().split(/\s+/)[0] ?? "";
        }
      }
      return value;
    },
  );
}

function interpolateDeep(
  value: unknown,
  root: Record<string, unknown>,
  sanitizeTextParams: boolean,
): unknown {
  if (typeof value === "string") {
    const resolved = interpolateCampaignTokenString(value, root);
    return sanitizeTextParams
      ? sanitizeTemplateParameterText(resolved)
      : resolved;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateDeep(v, root, sanitizeTextParams));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // `text` de parâmetro Meta: achatar. Links de mídia: preservar URL.
      const sanitize = sanitizeTextParams && k === "text";
      out[k] = interpolateDeep(v, root, sanitize);
    }
    return out;
  }
  return value;
}

export type CampaignInterpolationRoot = {
  contact: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
  } | null;
  deal: {
    id: string;
    title: string;
    value: string;
    status: string;
  } | null;
  contactCustomFields: Record<string, string>;
  dealCustomFields: Record<string, string>;
  contactId: string | null;
  dealId: string | null;
};

/**
 * Contato + negócio OPEN mais recente + custom fields.
 * Mesma prioridade de deal das automações (OPEN; sem fallback para fechado).
 */
export async function loadCampaignInterpolationRoot(
  contactId: string,
): Promise<CampaignInterpolationRoot> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, name: true, phone: true, email: true },
  });

  const openDeal = await prisma.deal.findFirst({
    where: { contactId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, value: true, status: true },
  });

  const contactCustomFields: Record<string, string> = {};
  const dealCustomFields: Record<string, string> = {};

  const contactRows = await prisma.contactCustomFieldValue.findMany({
    where: { contactId },
    select: { value: true, customField: { select: { name: true } } },
  });
  for (const r of contactRows) {
    const name = r.customField?.name;
    if (name) contactCustomFields[name] = r.value ?? "";
  }

  if (openDeal) {
    const dealRows = await prisma.dealCustomFieldValue.findMany({
      where: { dealId: openDeal.id },
      select: { value: true, customField: { select: { name: true } } },
    });
    for (const r of dealRows) {
      const name = r.customField?.name;
      if (name) dealCustomFields[name] = r.value ?? "";
    }
  }

  return {
    contact: contact
      ? {
          id: contact.id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
        }
      : null,
    deal: openDeal
      ? {
          id: openDeal.id,
          title: openDeal.title,
          value: String(openDeal.value ?? ""),
          status: openDeal.status,
        }
      : null,
    contactCustomFields,
    dealCustomFields,
    contactId,
    dealId: openDeal?.id ?? null,
  };
}

export function interpolateCampaignTemplatePayload(
  payload: CampaignTemplatePayload,
  root: CampaignInterpolationRoot,
): { components: unknown[] | undefined; headerMediaUrl: string | null } {
  const rootObj = root as unknown as Record<string, unknown>;
  const components = payload.components
    ? (interpolateDeep(payload.components, rootObj, true) as unknown[])
    : undefined;
  const headerRaw = payload.headerMediaUrl?.trim() || null;
  const headerMediaUrl = headerRaw
    ? interpolateCampaignTokenString(headerRaw, rootObj).trim() || null
    : null;
  return { components, headerMediaUrl };
}
