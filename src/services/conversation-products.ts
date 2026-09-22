/**
 * Envio de produtos no Inbox: caminho nativo Meta (product / product_list)
 * ou fallback para o fluxo atual (texto/imagem via attachments).
 *
 * Não altera POST /messages nem POST /attachments.
 */
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { getContactWhatsAppTargets } from "@/lib/contact-whatsapp-target";
import { HUMAN_OUTBOUND_REPLY_MARK } from "@/lib/conversation-reply-marking";
import {
  formatMetaSendError,
  metaClientFromConfig,
  type MetaWhatsAppClient,
} from "@/lib/meta-whatsapp/client";
import { publishProductToMetaCatalog } from "@/services/meta-catalog";
import { getOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  parseProductWhatsAppSendMode,
  PRODUCT_WHATSAPP_SEND_MODE_KEY,
  resolveProductSendFormat,
  type ProductSendFormat,
  type ProductWhatsAppSendMode,
} from "@/lib/product-whatsapp-send-mode";
import { isBaileysChannel } from "@/lib/send-whatsapp";
import { sseBus } from "@/lib/sse-bus";
import { resolveOutboundChannel } from "@/lib/outbound-channel";
import { logEvent } from "@/services/activity-log";
import { cancelActiveContextsForContactIfAny } from "@/services/automation-context";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";
import { getConversationLite, reopenResolvedAsNewTicket } from "@/services/conversations";
import { cancelPendingForConversation } from "@/services/scheduled-messages";

import type { NextResponse } from "next/server";

export type ProductSendActor = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  organizationId: string | null;
  isSuperAdmin?: boolean;
};

export type CatalogProductSendResult =
  | {
      ok: true;
      used: "catalog";
      format: "catalog_product" | "catalog_product_list";
      sendMode: ProductWhatsAppSendMode;
      conversationId: string;
      reopenedConversationId?: string;
      message: {
        id: string;
        content: string;
        createdAt: string;
        direction: "out";
        messageType: string;
        senderName: string;
        externalId: string | null;
      };
    }
  | {
      ok: true;
      used: "legacy";
      fallback: true;
      sendMode: ProductWhatsAppSendMode;
      reason: string;
      conversationId: string;
      reopenedConversationId?: string;
    }
  | {
      ok: true;
      used: "ask";
      needsFormatChoice: true;
      sendMode: "ask";
      formats: ProductSendFormat[];
      conversationId: string;
    }
  | { ok: false; status: number; message: string };

async function denialToFailure(denied: NextResponse): Promise<CatalogProductSendResult> {
  let message = "Acesso negado.";
  try {
    const body = (await denied.json()) as { message?: unknown };
    if (typeof body?.message === "string" && body.message.trim()) {
      message = body.message;
    }
  } catch {
    /* keep default */
  }
  return { ok: false, status: denied.status, message };
}

async function ensureRetailerInCatalog(
  client: MetaWhatsAppClient,
  args: {
    catalogId: string;
    retailerId: string;
    productId: string;
    channelId: string;
  },
): Promise<string | null> {
  try {
    const found = await client.findCatalogProductByRetailerId(
      args.catalogId,
      args.retailerId,
    );
    if (found) return args.retailerId;
  } catch {
    /* publica de novo */
  }
  try {
    const link = await publishProductToMetaCatalog({
      productId: args.productId,
      channelId: args.channelId,
      productRetailerId: args.retailerId,
    });
    return link.productRetailerId ?? null;
  } catch {
    return args.retailerId;
  }
}

function actorName(actor: ProductSendActor): string {
  return actor.name?.trim() || actor.email?.trim() || "Agente";
}

function publishNewMessage(
  conv: { id: string; organizationId: string; contactId: string | null },
  content: string,
  timestamp: Date,
): void {
  try {
    sseBus.publish("new_message", {
      organizationId: conv.organizationId,
      conversationId: conv.id,
      contactId: conv.contactId,
      direction: "out",
      content,
      timestamp,
    });
  } catch {
    /* best-effort */
  }
}

export async function sendProductsToConversation(args: {
  conversationId: string;
  actor: ProductSendActor;
  productIds: string[];
  requestedFormat?: ProductSendFormat | "auto" | null;
  body?: string | null;
  header?: string | null;
  footer?: string | null;
  channelId?: string | null;
}): Promise<CatalogProductSendResult> {
  const productIds = [...new Set(args.productIds.map((id) => id.trim()).filter(Boolean))];
  if (productIds.length === 0) {
    return { ok: false, status: 400, message: "Informe ao menos um produto." };
  }
  if (productIds.length > 30) {
    return { ok: false, status: 400, message: "Máximo de 30 produtos por envio (limite Meta)." };
  }

  const sendMode = parseProductWhatsAppSendMode(
    await getOrgSetting(PRODUCT_WHATSAPP_SEND_MODE_KEY),
  );
  const decision = resolveProductSendFormat({
    mode: sendMode,
    productCount: productIds.length,
    requestedFormat: args.requestedFormat,
  });

  const found = await getConversationLite(args.conversationId);
  if (!found) return { ok: false, status: 404, message: "Conversa não encontrada." };

  if (decision.needsChoice) {
    return {
      ok: true,
      used: "ask",
      needsFormatChoice: true,
      sendMode: "ask",
      formats: ["legacy", "catalog_product", "catalog_product_list"],
      conversationId: found.id,
    };
  }

  const format = decision.format ?? "legacy";
  if (format === "legacy") {
    return {
      ok: true,
      used: "legacy",
      fallback: true,
      sendMode,
      reason: sendMode === "normal" ? "SEND_MODE_NORMAL" : "FORMAT_LEGACY",
      conversationId: found.id,
    };
  }

  let conv = found;
  let reopenedConversationId: string | undefined;
  if (conv.status === "RESOLVED" && conv.contactId) {
    const reopened = await reopenResolvedAsNewTicket(conv.id);
    if (reopened.id !== conv.id) {
      const fresh = await getConversationLite(reopened.id);
      if (fresh) {
        reopenedConversationId = fresh.id;
        conv = fresh;
      }
    }
  }

  const sendDenied = await requireChannelScope(
    {
      id: args.actor.id,
      role: args.actor.role ?? undefined,
      organizationId: args.actor.organizationId,
      isSuperAdmin: args.actor.isSuperAdmin,
    },
    "send",
    conv.channelId,
  );
  if (sendDenied) return denialToFailure(sendDenied);

  const resolved = await resolveOutboundChannel({
    conv: {
      channelId: conv.channelId,
      channelRef: conv.channelRef,
      organizationId: conv.organizationId,
    },
    user: {
      id: args.actor.id,
      role: args.actor.role ?? null,
      organizationId: args.actor.organizationId,
      isSuperAdmin: args.actor.isSuperAdmin,
    },
    requestedChannelId: args.channelId ?? null,
  });
  if (!resolved.ok) return denialToFailure(resolved.response);

  const outboundChannelRef = resolved.channelRef;
  const outboundChannelId = resolved.channelId;

  if (conv.channel !== "whatsapp" || isBaileysChannel(outboundChannelRef)) {
    return {
      ok: true,
      used: "legacy",
      fallback: true,
      sendMode,
      reason: "CHANNEL_NOT_META_CLOUD",
      conversationId: conv.id,
      ...(reopenedConversationId ? { reopenedConversationId } : {}),
    };
  }
  if (outboundChannelRef?.status && outboundChannelRef.status !== "CONNECTED") {
    return {
      ok: true,
      used: "legacy",
      fallback: true,
      sendMode,
      reason: "CHANNEL_DISCONNECTED",
      conversationId: conv.id,
      ...(reopenedConversationId ? { reopenedConversationId } : {}),
    };
  }

  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isActive: true },
    select: {
      id: true,
      name: true,
      description: true,
      price: true,
      imageUrl: true,
      metaLinks: {
        where: { channelId: outboundChannelId ?? "" },
        select: { metaCatalogId: true, productRetailerId: true },
        take: 1,
      },
    },
  });
  if (products.length !== productIds.length) {
    return { ok: false, status: 400, message: "Um ou mais produtos não foram encontrados." };
  }

  const ordered = productIds
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is (typeof products)[number] => Boolean(p));

  const links = ordered.map((p) => p.metaLinks[0] ?? null);
  const missing = links.some((link) => !link?.metaCatalogId?.trim() || !link?.productRetailerId?.trim());
  if (missing) {
    console.warn("[conversation-products] fallback legacy: vínculo Meta ausente", {
      conversationId: conv.id,
      productIds,
    });
    return {
      ok: true,
      used: "legacy",
      fallback: true,
      sendMode,
      reason: "MISSING_META_LINK",
      conversationId: conv.id,
      ...(reopenedConversationId ? { reopenedConversationId } : {}),
    };
  }

  const catalogIds = new Set(links.map((l) => l!.metaCatalogId!.trim()));
  if (catalogIds.size !== 1) {
    console.warn("[conversation-products] fallback legacy: catálogos Meta misturados", {
      conversationId: conv.id,
    });
    return {
      ok: true,
      used: "legacy",
      fallback: true,
      sendMode,
      reason: "MIXED_META_CATALOG",
      conversationId: conv.id,
      ...(reopenedConversationId ? { reopenedConversationId } : {}),
    };
  }

  const catalogId = [...catalogIds][0]!;
  const retailerIds = links.map((l) => l!.productRetailerId!.trim() as string);
  const channelConfig = outboundChannelRef?.config as Record<string, unknown> | null | undefined;
  const metaClient = metaClientFromConfig(channelConfig, { allowEnvFallback: false });
  if (!metaClient.configured) {
    return {
      ok: true,
      used: "legacy",
      fallback: true,
      sendMode,
      reason: "META_NOT_CONFIGURED",
      conversationId: conv.id,
      ...(reopenedConversationId ? { reopenedConversationId } : {}),
    };
  }

  const target = await getContactWhatsAppTargets(conv.contactId ?? "");
  if (!target) {
    return { ok: false, status: 400, message: "Contato sem telefone nem BSUID WhatsApp." };
  }

  const senderName = actorName(args.actor);
  const names = ordered.map((p) => p.name).filter(Boolean);
  const resolvedRetailerIds: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    resolvedRetailerIds.push(
      await ensureRetailerInCatalog(metaClient, {
        catalogId,
        retailerId: retailerIds[i],
        productId: ordered[i].id,
        channelId: outboundChannelId ?? "",
      }),
    );
  }

  const useCarousel = format === "catalog_product_list" && resolvedRetailerIds.length >= 2;
  const preview = useCarousel ? names.join("\n") : names[0] ?? "Produto";
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      channelId: outboundChannelId ?? undefined,
      content: preview,
      direction: "out",
      messageType: ordered[0]?.imageUrl ? "image" : "interactive",
      mediaUrl: ordered[0]?.imageUrl ?? undefined,
      senderName,
      sendStatus: "pending",
    }),
  });

  let externalId: string | null = null;
  try {
    const result = useCarousel
      ? await metaClient.sendCatalogProductList(
          target.to,
          {
            catalogId,
            header: args.header?.trim() || "Produtos",
            body: "Confira as opções:",
            sections: [
              {
                title: "Cursos",
                productRetailerIds: resolvedRetailerIds,
              },
            ],
          },
          target.recipient,
        )
      : await metaClient.sendCatalogProduct(
          target.to,
          {
            catalogId,
            productRetailerId: resolvedRetailerIds[0],
          },
          target.recipient,
        );
    externalId = result.messages?.[0]?.id ?? null;
    await prisma.message
      .update({
        where: { id: saved.id },
        data: { externalId, sendStatus: "sent" },
      })
      .catch(() => {});
  } catch (err) {
    const reason = formatMetaSendError(err);
    console.warn("[conversation-products] envio catálogo falhou — fallback legacy", {
      conversationId: conv.id,
      reason,
    });
    await prisma.message.delete({ where: { id: saved.id } }).catch(() => {});
    return {
      ok: true,
      used: "legacy",
      fallback: true,
      sendMode,
      reason: "META_SEND_FAILED",
      conversationId: conv.id,
      ...(reopenedConversationId ? { reopenedConversationId } : {}),
    };
  }

  try {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        ...HUMAN_OUTBOUND_REPLY_MARK,
        hasError: false,
      },
    });
  } catch {
    /* colunas opcionais */
  }

  void logEvent({
    type: "MESSAGE_SENT",
    entityType: "MESSAGE",
    entityId: saved.id,
    entityLabel: senderName,
    conversationId: conv.id,
    contactId: conv.contactId,
    meta: {
      preview: preview.slice(0, 200),
      channel: "WhatsApp",
      kind: useCarousel ? "catalog_product_list" : "catalog_product",
      catalogId,
      productRetailerIds: resolvedRetailerIds,
      externalId,
      count: resolvedRetailerIds.length,
    },
  });

  publishNewMessage(conv, preview, saved.createdAt);

  if (conv.contactId) {
    try {
      await cancelActiveContextsForContactIfAny(conv.contactId);
    } catch (err) {
      console.warn("[automation] cancel after catalog product:", err);
    }
  }
  fireTrigger("message_sent", {
    contactId: conv.contactId,
    data: buildMessageTriggerData({
      channel: conv.channel || "WhatsApp",
      channelId: outboundChannelId,
      conversationId: conv.id,
      content: preview,
    }),
  }).catch((err) => console.warn("[automation trigger] message_sent:", err));
  cancelPendingForConversation(conv.id, "agent_reply", args.actor.id).catch((err) =>
    console.warn("[scheduled-messages] falha ao cancelar apos produto Meta:", err),
  );

  return {
    ok: true,
    used: "catalog",
    format,
    sendMode,
    conversationId: conv.id,
    ...(reopenedConversationId ? { reopenedConversationId } : {}),
    message: {
      id: saved.id,
      content: preview,
      createdAt: saved.createdAt.toISOString(),
      direction: "out",
      messageType: ordered[0]?.imageUrl ? "image" : "interactive",
      senderName,
      externalId,
    },
  };
}
