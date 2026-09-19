import {
  formatMetaSendError,
  isMetaGraphError,
  MetaGraphTimeoutError,
  metaClientFromConfig,
} from "@/lib/meta-whatsapp/client";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { parseStoragePath, presignStoredGetUrl } from "@/lib/storage/local";
import {
  parseChannelConfigDecrypted,
} from "@/services/channels";

export type MetaCatalogReason =
  | "NO_CHANNEL"
  | "CHANNEL_NOT_META"
  | "DISCONNECTED"
  | "MISSING_WABA"
  | "TOKEN_INVALID"
  | "NO_PERMISSION"
  | "NO_CATALOG"
  | "GRAPH_ERROR";

export type MetaCatalogStatus = {
  connected: boolean;
  catalogId: string | null;
  catalogName: string | null;
  canUseCatalog: boolean;
  channelId: string | null;
  reason?: MetaCatalogReason;
  message?: string;
};

function safeGraphMessage(err: unknown): { reason: MetaCatalogReason; message: string } {
  if (err instanceof MetaGraphTimeoutError) {
    return {
      reason: "GRAPH_ERROR",
      message: "A Meta demorou para responder. Tente criar de novo em alguns segundos.",
    };
  }
  if (isMetaGraphError(err)) {
    if (err.code === 190 || err.httpStatus === 401) {
      return {
        reason: "TOKEN_INVALID",
        message: "Token do canal Meta inválido ou expirado. Reconecte o canal.",
      };
    }
    if (err.code === 10 || err.code === 200 || err.httpStatus === 403) {
      return {
        reason: "NO_PERMISSION",
        message: "O token do canal não tem permissão para ler o catálogo da WABA.",
      };
    }
    return {
      reason: "GRAPH_ERROR",
      message: formatMetaSendError(err).slice(0, 280),
    };
  }
  return {
    reason: "GRAPH_ERROR",
    message: "Não foi possível consultar o catálogo da Meta.",
  };
}

async function resolveMetaChannel(channelId?: string | null) {
  if (channelId?.trim()) {
    return prisma.channel.findFirst({
      where: { id: channelId.trim() },
      select: {
        id: true,
        name: true,
        provider: true,
        status: true,
        config: true,
      },
    });
  }
  return prisma.channel.findFirst({
    where: { provider: "META_CLOUD_API", status: "CONNECTED" },
    orderBy: { lastConnectedAt: "desc" },
    select: {
      id: true,
      name: true,
      provider: true,
      status: true,
      config: true,
    },
  });
}

export async function detectWabaProductCatalog(
  channelId?: string | null,
): Promise<MetaCatalogStatus> {
  const channel = await resolveMetaChannel(channelId);
  if (!channel) {
    return {
      connected: false,
      catalogId: null,
      catalogName: null,
      canUseCatalog: false,
      channelId: null,
      reason: "NO_CHANNEL",
      message: "Nenhum canal WhatsApp Cloud API encontrado nesta organização.",
    };
  }
  if (channel.provider !== "META_CLOUD_API") {
    return {
      connected: false,
      catalogId: null,
      catalogName: null,
      canUseCatalog: false,
      channelId: channel.id,
      reason: "CHANNEL_NOT_META",
      message: "O canal informado não é WhatsApp Cloud API.",
    };
  }
  if (channel.status !== "CONNECTED") {
    return {
      connected: false,
      catalogId: null,
      catalogName: null,
      canUseCatalog: false,
      channelId: channel.id,
      reason: "DISCONNECTED",
      message: "Reconecte o canal Meta em Configurações → Canais.",
    };
  }

  const cfg = parseChannelConfigDecrypted({
    provider: channel.provider,
    config: channel.config,
  });
  const client = metaClientFromConfig(cfg, { allowEnvFallback: false });
  if (!client.templatesConfigured) {
    return {
      connected: false,
      catalogId: null,
      catalogName: null,
      canUseCatalog: false,
      channelId: channel.id,
      reason: "MISSING_WABA",
      message: "Canal sem businessAccountId (WABA). Configure o canal Meta.",
    };
  }

  try {
    const payload = await client.listProductCatalogs();
    const first = payload.data?.find((row) => typeof row.id === "string" && row.id.trim());
    if (!first?.id) {
      return {
        connected: false,
        catalogId: null,
        catalogName: null,
        canUseCatalog: false,
        channelId: channel.id,
        reason: "NO_CATALOG",
        message: "A WABA deste canal não tem catálogo Commerce associado.",
      };
    }
    return {
      connected: true,
      catalogId: first.id.trim(),
      catalogName: typeof first.name === "string" ? first.name : null,
      canUseCatalog: true,
      channelId: channel.id,
    };
  } catch (err) {
    const mapped = safeGraphMessage(err);
    console.warn("[meta-catalog] listProductCatalogs falhou", {
      channelId: channel.id,
      reason: mapped.reason,
    });
    return {
      connected: false,
      catalogId: null,
      catalogName: null,
      canUseCatalog: false,
      channelId: channel.id,
      reason: mapped.reason,
      message: mapped.message,
    };
  }
}

export class MetaCatalogPublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "MetaCatalogPublishError";
  }
}

const RETAILER_SAFE = /[^A-Za-z0-9._-]/g;

function sanitizeRetailerId(raw: string): string {
  return raw
    .trim()
    .replace(RETAILER_SAFE, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

function publicHttpsUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseOwnedImage(raw: string | null | undefined) {
  const value = raw?.trim();
  if (!value) return null;
  const direct = parseStoragePath(value);
  if (direct) return direct;
  try {
    return parseStoragePath(new URL(value).pathname);
  } catch {
    return null;
  }
}

async function resolveCatalogImageUrl(raw: string | null | undefined): Promise<string | null> {
  const publicUrl = publicHttpsUrl(raw);
  if (publicUrl) return publicUrl;
  const stored = parseOwnedImage(raw);
  if (!stored) return null;
  return presignStoredGetUrl(stored.orgId, stored.bucket, stored.fileName);
}

function isDuplicateRetailer(err: unknown): boolean {
  if (!isMetaGraphError(err)) return false;
  const text = `${err.message} ${err.details ?? ""} ${err.userMsg ?? ""}`.toLowerCase();
  return (
    text.includes("retailer_id") &&
    (text.includes("already") ||
      text.includes("exist") ||
      text.includes("duplicate") ||
      text.includes("unique"))
  );
}

export async function publishProductToMetaCatalog(params: {
  productId: string;
  channelId?: string | null;
  productRetailerId?: string | null;
}) {
  const product = await prisma.product.findFirst({
    where: { id: params.productId },
    select: {
      id: true,
      name: true,
      description: true,
      sku: true,
      price: true,
      imageUrl: true,
      number: true,
      isActive: true,
      organization: { select: { name: true } },
    },
  });
  if (!product) {
    throw new MetaCatalogPublishError("Produto não encontrado.", 404);
  }

  if (!product.imageUrl?.trim()) {
    throw new MetaCatalogPublishError(
      "Salve uma imagem neste produto e tente de novo.",
      400,
      "MISSING_IMAGE",
    );
  }
  const imageUrl = await resolveCatalogImageUrl(product.imageUrl);
  if (!imageUrl) {
    throw new MetaCatalogPublishError(
      "Não foi possível gerar um link da capa para a Meta. Salve o produto com a imagem e tente de novo.",
      400,
      "MISSING_IMAGE",
    );
  }

  const priceCents = Math.round(Number(product.price) * 100);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    throw new MetaCatalogPublishError(
      "Informe um preço maior que zero antes de publicar na Meta.",
      400,
      "INVALID_PRICE",
    );
  }

  const detected = await detectWabaProductCatalog(params.channelId);
  if (!detected.canUseCatalog || !detected.catalogId || !detected.channelId) {
    throw new MetaCatalogPublishError(
      detected.message ?? "Não foi possível detectar o catálogo Meta.",
      400,
      detected.reason,
    );
  }

  const channel = await prisma.channel.findFirst({
    where: { id: detected.channelId, provider: "META_CLOUD_API" },
    select: { id: true, config: true },
  });
  if (!channel) {
    throw new MetaCatalogPublishError("Canal Meta Cloud API não encontrado.", 400, "NO_CHANNEL");
  }

  const retailerId =
    sanitizeRetailerId(params.productRetailerId ?? "") ||
    sanitizeRetailerId(product.sku ?? "") ||
    `bwipo-${product.number || product.id}`;

  const cfg = parseChannelConfigDecrypted({
    provider: "META_CLOUD_API",
    config: channel.config,
  });
  const client = metaClientFromConfig(cfg, { allowEnvFallback: false });
  const payload = {
    catalogId: detected.catalogId,
    retailerId,
    name: product.name,
    description: product.description ?? undefined,
    priceCents,
    currency: "BRL",
    imageUrl,
    url: imageUrl,
    availability: product.isActive ? ("in stock" as const) : ("out of stock" as const),
    brand: product.organization?.name,
  };

  try {
    try {
      await client.createCatalogProduct(payload);
    } catch (err) {
      if (!isDuplicateRetailer(err)) throw err;
      const existing = await client.findCatalogProductByRetailerId(
        detected.catalogId,
        retailerId,
      );
      if (!existing) throw err;
      await client.updateCatalogProduct(existing.id, payload);
    }
  } catch (err) {
    const mapped = safeGraphMessage(err);
    const message =
      mapped.reason === "NO_PERMISSION"
        ? "O token do canal não tem permissão para criar produto no catálogo Commerce."
        : mapped.message;
    await prisma.productMetaLink.upsert({
      where: {
        productId_channelId: { productId: product.id, channelId: channel.id },
      },
      update: {
        metaCatalogId: detected.catalogId,
        productRetailerId: retailerId,
        syncStatus: "ERROR",
        lastSyncError: message.slice(0, 500),
      },
      create: withOrgFromCtx({
        productId: product.id,
        channelId: channel.id,
        metaCatalogId: detected.catalogId,
        productRetailerId: retailerId,
        syncStatus: "ERROR",
        lastSyncError: message.slice(0, 500),
      }),
    });
    throw new MetaCatalogPublishError(message, 400, mapped.reason);
  }

  return prisma.productMetaLink.upsert({
    where: {
      productId_channelId: { productId: product.id, channelId: channel.id },
    },
    update: {
      metaCatalogId: detected.catalogId,
      productRetailerId: retailerId,
      syncStatus: "SYNCED",
      lastSyncedAt: new Date(),
      lastSyncError: null,
    },
    create: withOrgFromCtx({
      productId: product.id,
      channelId: channel.id,
      metaCatalogId: detected.catalogId,
      productRetailerId: retailerId,
      syncStatus: "SYNCED",
      lastSyncedAt: new Date(),
    }),
  });
}
