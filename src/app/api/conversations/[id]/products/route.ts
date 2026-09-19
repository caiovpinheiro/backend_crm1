import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requireConversationAccess } from "@/lib/conversation-access";
import { getContactChannelSession, getConversationSession } from "@/lib/channel-session";
import { getConversationLite } from "@/services/conversations";
import { sendProductsToConversation } from "@/services/conversation-products";
import {
  isProductSendFormat,
  type ProductSendFormat,
} from "@/lib/product-whatsapp-send-mode";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const { id } = await context.params;
    const denied = await requireConversationAccess({ user: authResult.user }, id);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const rawIds = rec.productIds;
    const productIds = Array.isArray(rawIds)
      ? rawIds.filter((v): v is string => typeof v === "string")
      : typeof rec.productId === "string"
        ? [rec.productId]
        : [];

    const formatRaw = rec.format;
    let requestedFormat: ProductSendFormat | "auto" | null = null;
    if (formatRaw === "auto" || formatRaw == null || formatRaw === "") {
      requestedFormat = formatRaw === "auto" ? "auto" : null;
    } else if (isProductSendFormat(formatRaw)) {
      requestedFormat = formatRaw;
    } else {
      return NextResponse.json(
        { message: "format inválido. Use auto, legacy, catalog_product ou catalog_product_list." },
        { status: 400 },
      );
    }

    const conv = await getConversationLite(id);
    if (!conv) {
      return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
    }

    if (!authResult.viaToken && conv.channelRef?.provider === "META_CLOUD_API") {
      const requestedChannelId =
        typeof rec.channelId === "string" && rec.channelId.trim() ? rec.channelId.trim() : null;
      const hasChannelOverride = !!requestedChannelId && requestedChannelId !== conv.channelId;
      const targetSession =
        hasChannelOverride && conv.contactId
          ? await getContactChannelSession(conv.contactId, requestedChannelId)
          : await getConversationSession(conv);
      if (!targetSession.active) {
        return NextResponse.json(
          {
            message: "Sessão de 24h encerrada neste canal. Envie um template.",
            code: "SESSION_CLOSED",
          },
          { status: 409 },
        );
      }
    }

    const result = await sendProductsToConversation({
      conversationId: id,
      actor: {
        id: authResult.user.id,
        name: authResult.user.name,
        email: authResult.user.email,
        role: authResult.user.role,
        organizationId: authResult.user.organizationId ?? null,
        isSuperAdmin: authResult.user.isSuperAdmin,
      },
      productIds,
      requestedFormat,
      body: typeof rec.body === "string" ? rec.body : null,
      header: typeof rec.header === "string" ? rec.header : null,
      footer: typeof rec.footer === "string" ? rec.footer : null,
      channelId: typeof rec.channelId === "string" ? rec.channelId : null,
    });

    if (!result.ok) {
      return NextResponse.json({ message: result.message }, { status: result.status });
    }
    const status = result.used === "catalog" ? 201 : 200;
    return NextResponse.json(result, { status });
  });
}
