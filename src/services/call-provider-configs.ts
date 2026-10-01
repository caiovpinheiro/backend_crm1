/**
 * Service: CallProviderConfig — configuração de provedor de webhook por org.
 *
 * Cada registro mapeia um provedor (ex.: "generic-sip") a uma org, com:
 *  - webhookToken único (identifica a org no endpoint público)
 *  - webhookSecretEncrypted (HMAC secret ou token de auth — cifrado)
 *  - fieldMappings (config do adapter)
 */
import { randomBytes } from "node:crypto";
import { Prisma, type RecordingDelivery, type WebhookAuthMode } from "@prisma/client";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { withOrg } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { Api4ComClient } from "@/services/api4com/client";
import { resolveApi4ComGateway } from "@/services/telephony-providers/api4com";
import { listProviders } from "./call-adapters";

// ── Tipos ─────────────────────────────────────────────────────────────────

export type CreateProviderConfigInput = {
  providerKey: string;
  fieldMappings?: Record<string, unknown>;
  authMode: WebhookAuthMode;
  /** Secret em plaintext — será cifrado antes de salvar. */
  webhookSecret: string;
  signatureHeader?: string | null;
  recordingDelivery?: RecordingDelivery;
  createContactsForCalls?: boolean;
  isActive?: boolean;
};

export type UpdateProviderConfigInput = {
  providerKey?: string;
  fieldMappings?: Record<string, unknown>;
  authMode?: WebhookAuthMode;
  /** Novo secret em texto puro — cifrado antes de persistir. */
  webhookSecret?: string;
  signatureHeader?: string | null;
  recordingDelivery?: RecordingDelivery;
  createContactsForCalls?: boolean;
  isActive?: boolean;
};

export type ProviderConfigPublic = {
  id: string;
  organizationId: string;
  providerKey: string;
  fieldMappings: unknown;
  authMode: WebhookAuthMode;
  /** Indica se o secret está configurado (nunca retorna o valor). */
  hasWebhookSecret: boolean;
  signatureHeader: string | null;
  /**
   * Token e URL só em detalhe/create/update administrativos
   * (`sip_extension:manage`). Listagens omitem.
   */
  webhookToken?: string;
  recordingDelivery: RecordingDelivery;
  createContactsForCalls: boolean;
  isActive: boolean;
  webhookUrl?: string;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT_DB = {
  id: true,
  organizationId: true,
  providerKey: true,
  fieldMappings: true,
  authMode: true,
  webhookSecretEncrypted: true,
  signatureHeader: true,
  webhookToken: true,
  recordingDelivery: true,
  createContactsForCalls: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

function sanitizeFieldMappings(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith("__")) continue;
    out[key] = value;
  }
  return out;
}

function toPublic(
  row: {
    id: string;
    organizationId: string;
    providerKey: string;
    fieldMappings: unknown;
    authMode: WebhookAuthMode;
    webhookSecretEncrypted: string;
    signatureHeader: string | null;
    webhookToken: string;
    recordingDelivery: RecordingDelivery;
    createContactsForCalls: boolean;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  opts: { includeWebhookToken?: boolean } = {},
): ProviderConfigPublic {
  const includeWebhookToken = opts.includeWebhookToken === true;
  return {
    id: row.id,
    organizationId: row.organizationId,
    providerKey: row.providerKey,
    fieldMappings: sanitizeFieldMappings(row.fieldMappings),
    authMode: row.authMode,
    hasWebhookSecret: Boolean(row.webhookSecretEncrypted),
    signatureHeader: row.signatureHeader,
    recordingDelivery: row.recordingDelivery,
    createContactsForCalls: row.createContactsForCalls,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(includeWebhookToken
      ? {
          webhookToken: row.webhookToken,
          webhookUrl: buildWebhookUrl(row.providerKey, row.webhookToken),
        }
      : {}),
  };
}

function buildWebhookUrl(providerKey: string, webhookToken: string): string {
  return `/api/webhooks/calls/${encodeURIComponent(providerKey)}?token=${webhookToken}`;
}

function generateWebhookToken(): string {
  return randomBytes(24).toString("hex");
}

// ── CRUD ──────────────────────────────────────────────────────────────────

/** Cria uma nova configuração de provedor para a org corrente. */
export async function createProviderConfig(
  input: CreateProviderConfigInput,
): Promise<ProviderConfigPublic> {
  const organizationId = getOrgIdOrThrow();

  const providers = listProviders();
  if (!providers.includes(input.providerKey)) {
    throw new Error(
      `Provedor desconhecido: "${input.providerKey}". Disponíveis: ${providers.join(", ")}`,
    );
  }

  const webhookToken = generateWebhookToken();
  const webhookSecretEncrypted = encryptSecret(input.webhookSecret);

  const row = await prisma.callProviderConfig.create({
    data: withOrg(
      {
        providerKey: input.providerKey,
        fieldMappings: input.fieldMappings ?? {},
        authMode: input.authMode,
        webhookSecretEncrypted,
        signatureHeader: input.signatureHeader ?? null,
        webhookToken,
        recordingDelivery: input.recordingDelivery ?? "URL",
        createContactsForCalls: input.createContactsForCalls ?? false,
        isActive: input.isActive ?? true,
      },
      organizationId,
    ),
    select: SELECT_DB,
  });

  return toPublic(row, { includeWebhookToken: true });
}

/** Lista todas as configs de provedor da org corrente. */
export async function listProviderConfigs(): Promise<ProviderConfigPublic[]> {
  const rows = await prisma.callProviderConfig.findMany({
    select: SELECT_DB,
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => toPublic(row));
}

/** Busca uma config pelo id (org-scoped via extension). */
export async function getProviderConfig(id: string): Promise<ProviderConfigPublic | null> {
  const row = await prisma.callProviderConfig.findUnique({ where: { id }, select: SELECT_DB });
  return row ? toPublic(row, { includeWebhookToken: true }) : null;
}

/** Atualiza campos de uma config existente. */
export async function updateProviderConfig(
  id: string,
  input: UpdateProviderConfigInput,
): Promise<ProviderConfigPublic> {
  const updateData: Record<string, unknown> = {};

  if (input.fieldMappings !== undefined) updateData.fieldMappings = input.fieldMappings;
  if (input.authMode !== undefined) updateData.authMode = input.authMode;
  if (input.webhookSecret !== undefined)
    updateData.webhookSecretEncrypted = encryptSecret(input.webhookSecret);
  if (input.signatureHeader !== undefined) updateData.signatureHeader = input.signatureHeader;
  if (input.recordingDelivery !== undefined) updateData.recordingDelivery = input.recordingDelivery;
  if (input.createContactsForCalls !== undefined)
    updateData.createContactsForCalls = input.createContactsForCalls;

  const row = await prisma.callProviderConfig.update({
    where: { id },
    data: updateData,
    select: SELECT_DB,
  });

  return toPublic(row, { includeWebhookToken: true });
}

/** Remove uma config de provedor. */
export async function deleteProviderConfig(id: string): Promise<void> {
  await prisma.callProviderConfig.delete({ where: { id } });
}

/**
 * Busca uma config pelo webhookToken (SEM filtro de org).
 * Usado exclusivamente pelo endpoint de webhook público, que precisa
 * resolver a org a partir do token antes de ter qualquer contexto.
 *
 * Usa prismaBase (sem extension multi-tenant) porque o organizationId
 * ainda é desconhecido nesse ponto.
 */
export async function findConfigByWebhookToken(webhookToken: string): Promise<{
  id: string;
  organizationId: string;
  providerKey: string;
  fieldMappings: unknown;
  authMode: WebhookAuthMode;
  webhookSecretEncrypted: string;
  signatureHeader: string | null;
  webhookToken: string;
  recordingDelivery: RecordingDelivery;
  createContactsForCalls: boolean;
  isActive: boolean;
} | null> {
  return prismaBase.callProviderConfig.findUnique({
    where: { webhookToken },
    select: {
      id: true,
      organizationId: true,
      providerKey: true,
      fieldMappings: true,
      authMode: true,
      webhookSecretEncrypted: true,
      signatureHeader: true,
      webhookToken: true,
      recordingDelivery: true,
      createContactsForCalls: true,
      isActive: true,
    },
  });
}

/**
 * Descriptografa o webhookSecret de uma config.
 * NUNCA logar o retorno.
 */
export function decryptWebhookSecret(config: { webhookSecretEncrypted: string }): string {
  return decryptSecret(config.webhookSecretEncrypted);
}

/**
 * Busca ou cria a CallProviderConfig do tipo "api4com" para a org corrente.
 * Idempotente — pode ser chamado múltiplas vezes (cada operador que conecta
 * Api4com via UI cai aqui; só o primeiro cria, os demais reaproveitam).
 *
 * Modo TOKEN (Api4com não usa HMAC nos webhooks — autentica via token único
 * na URL `?token=<webhookToken>`). O webhookSecret aqui é o próprio token —
 * armazenamos cifrado por convenção do schema, mas a validação real no
 * `processWebhookEvent` é feita por `findConfigByWebhookToken`.
 */
async function loadOrCreateApi4ComDbRow(organizationId: string) {
  const existing = await prisma.callProviderConfig.findFirst({
    where: { organizationId, providerKey: "api4com" },
    select: SELECT_DB,
  });
  if (existing) return existing;

  const webhookToken = generateWebhookToken();
  const webhookSecretEncrypted = encryptSecret(webhookToken);

  return prisma.callProviderConfig.create({
    data: withOrg(
      {
        providerKey: "api4com",
        fieldMappings: {},
        authMode: "TOKEN" as WebhookAuthMode,
        webhookSecretEncrypted,
        signatureHeader: null,
        webhookToken,
        recordingDelivery: "URL" as RecordingDelivery,
        createContactsForCalls: false,
        isActive: true,
      },
      organizationId,
    ),
    select: SELECT_DB,
  });
}

export async function getOrCreateApi4ComProviderConfig(
  organizationId = getOrgIdOrThrow(),
): Promise<ProviderConfigPublic> {
  const row = await loadOrCreateApi4ComDbRow(organizationId);
  return toPublic(row, { includeWebhookToken: true });
}

const API4COM_TOKEN_KEY = "__api4comServiceTokenEncrypted";
const API4COM_GATEWAY_KEY = "__api4comGateway";

export type Api4ComIntegrationPublic = {
  webhookUrl: string;
  hasServiceToken: boolean;
  hasEnvToken: boolean;
  gateway: string;
  isActive: boolean;
  webhookRegistered: boolean | null;
  webhookError: string | null;
};

function readMappings(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

function absoluteWebhookUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "").replace(/\/$/, "");
  if (path.startsWith("http")) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

function tokenFromMappings(mappings: Record<string, unknown>): string | null {
  const enc = mappings[API4COM_TOKEN_KEY];
  if (typeof enc !== "string" || !enc) return null;
  try {
    const token = decryptSecret(enc).trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function resolveOrgApi4ComGateway(organizationId: string): Promise<string> {
  const row = await prisma.callProviderConfig.findFirst({
    where: { organizationId, providerKey: "api4com" },
    select: { fieldMappings: true },
  });
  const mappings = readMappings(row?.fieldMappings);
  const saved = mappings[API4COM_GATEWAY_KEY];
  if (typeof saved === "string" && saved.trim()) return saved.trim();
  return resolveApi4ComGateway(organizationId);
}

/** Token da org (UI) com fallback para `API4COM_SERVICE_TOKEN` do env. */
export async function resolveApi4ComServiceToken(
  organizationId: string,
): Promise<string | null> {
  const row = await prisma.callProviderConfig.findFirst({
    where: { organizationId, providerKey: "api4com" },
    select: { fieldMappings: true },
  });
  const fromOrg = tokenFromMappings(readMappings(row?.fieldMappings));
  if (fromOrg) return fromOrg;
  return process.env.API4COM_SERVICE_TOKEN?.trim() || null;
}

export async function getApi4ComIntegration(
  organizationId = getOrgIdOrThrow(),
): Promise<Api4ComIntegrationPublic> {
  const row = await loadOrCreateApi4ComDbRow(organizationId);
  const mappings = readMappings(row.fieldMappings);
  const gateway =
    typeof mappings[API4COM_GATEWAY_KEY] === "string" && String(mappings[API4COM_GATEWAY_KEY]).trim()
      ? String(mappings[API4COM_GATEWAY_KEY]).trim()
      : resolveApi4ComGateway(organizationId);
  const publicConfig = toPublic(row, { includeWebhookToken: true });

  return {
    webhookUrl: absoluteWebhookUrl(publicConfig.webhookUrl ?? ""),
    hasServiceToken: Boolean(tokenFromMappings(mappings)),
    hasEnvToken: Boolean(process.env.API4COM_SERVICE_TOKEN?.trim()),
    gateway,
    isActive: row.isActive,
    webhookRegistered: null,
    webhookError: null,
  };
}

export async function updateApi4ComIntegration(
  input: { serviceToken?: string | null; gateway?: string },
  organizationId = getOrgIdOrThrow(),
): Promise<Api4ComIntegrationPublic> {
  const row = await loadOrCreateApi4ComDbRow(organizationId);
  const mappings = readMappings(row.fieldMappings);

  if (input.serviceToken !== undefined) {
    const trimmed = input.serviceToken?.trim() ?? "";
    if (trimmed) {
      mappings[API4COM_TOKEN_KEY] = encryptSecret(trimmed);
    } else if (input.serviceToken === null || input.serviceToken === "") {
      delete mappings[API4COM_TOKEN_KEY];
    }
  }
  if (input.gateway !== undefined) {
    mappings[API4COM_GATEWAY_KEY] = input.gateway.trim();
  }

  await prisma.callProviderConfig.update({
    where: { id: row.id },
    data: { fieldMappings: mappings as Prisma.InputJsonValue },
  });

  const result = await getApi4ComIntegration(organizationId);
  const token = await resolveApi4ComServiceToken(organizationId);
  if (!token) {
    return { ...result, webhookRegistered: false, webhookError: null };
  }

  try {
    const client = new Api4ComClient({ token });
    const webhookVersion = process.env.API4COM_WEBHOOK_VERSION ?? "1.8";
    await client.upsertIntegration({
      gateway: result.gateway,
      webhook: true,
      webhookConstraint: { metadata: { gateway: result.gateway } },
      metadata: {
        webhookUrl: result.webhookUrl,
        webhookVersion,
        webhookTypes: ["channel-answer", "channel-hangup"],
      },
    });
    return { ...result, webhookRegistered: true, webhookError: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...result, webhookRegistered: false, webhookError: msg.slice(0, 500) };
  }
}
