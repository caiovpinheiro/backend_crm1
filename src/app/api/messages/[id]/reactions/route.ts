import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getContactWhatsAppTargets } from "@/lib/contact-whatsapp-target";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/messages/[id]/reactions");

type Ctx = { params: Promise<{ id: string }> };

/**
 * Schema unificado das reações no CRM.
 *
 *   `from`  — identifica o reator:
 *              - "agent:<userId>" quando é o operador do CRM
 *              - "<wa_id>" ou "<bsuid>" quando é o cliente (populado
 *                pelo webhook Meta)
 *   `emoji` — emoji unicode. Vazio = remoção.
 *   `at`    — ISO timestamp de quando a reação entrou.
 *
 * MESMO formato que `meta-webhook/handler.ts::applyIncomingReaction`
 * grava para reações recebidas, garantindo que o front lê os dois
 * lados pelo mesmo shape.
 */
type Reaction = { emoji: string; from: string; at: string };

function isReaction(v: unknown): v is Reaction {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.emoji === "string" && typeof r.from === "string";
}

export async function POST(request: Request, ctx: Ctx) {
  // withOrgContext popula o AsyncLocalStorage com `organizationId` +
  // `userId` + `isSuperAdmin`, requisito da extensao multi-tenant do
  // Prisma. Sem isso o `getOrgIdOrThrow()` estoura em qualquer
  // `prisma.message.findFirst()` que atravesse a tabela `Message`.
  return withOrgContext(async (session) => {
    try {
      const { id: ref } = await ctx.params;
      const body = (await request
        .json()
        .catch(() => ({}))) as Record<string, unknown>;
      const rawEmoji = typeof body.emoji === "string" ? body.emoji.trim() : "";

      // Sanidade: 8 bytes UTF-16 cobre um emoji + variation selector + skin
      // tone. Bloqueia payloads absurdos.
      if (rawEmoji.length > 8) {
        return NextResponse.json({ message: "Emoji inválido." }, { status: 400 });
      }

      const message = await prisma.message.findFirst({
        where: {
          OR: [{ id: ref }, { externalId: ref }],
        },
        select: {
          id: true,
          reactions: true,
          conversationId: true,
          direction: true,
          externalId: true,
          conversation: {
            select: {
              contactId: true,
              channelRef: { select: { config: true, provider: true } },
            },
          },
        },
      });

      if (!message) {
        return NextResponse.json(
          { message: "Mensagem não encontrada." },
          { status: 404 },
        );
      }

      const gate = await requireConversationAccess(session, message.conversationId);
      if (gate) return gate;

      // Identificador único do reator. `agent:<userId>` distingue de
      // reações do cliente (que usam wa_id / BSUID puros). Antes o
      // endpoint usava `senderName` (nome exibível), que colidia se dois
      // agentes tivessem o mesmo nome e não sobrevivia a rename.
      const agentTag = `agent:${(session.user as { id: string }).id}`;

      const current: Reaction[] = Array.isArray(message.reactions)
        ? (message.reactions as unknown[]).filter(isReaction)
        : [];

      // WhatsApp: 1 reação por reator por mensagem. Clicar de novo no
      // mesmo emoji remove; clicar em outro substitui.
      const previous = current.find((r) => r.from === agentTag);
      const withoutAgent = current.filter((r) => r.from !== agentTag);

      let updated: Reaction[];
      let metaEmoji: string;
      if (!rawEmoji || (previous && previous.emoji === rawEmoji)) {
        // Toggle-off: mesmo emoji ou string vazia → remove.
        updated = withoutAgent;
        metaEmoji = "";
      } else {
        updated = [
          ...withoutAgent,
          { emoji: rawEmoji, from: agentTag, at: new Date().toISOString() },
        ];
        metaEmoji = rawEmoji;
      }

      await prisma.message.update({
        where: { id: message.id },
        data: { reactions: updated as unknown as object[] },
      });

      // Só envia à Meta quando a mensagem tem wamid E o canal é Cloud
      // API. Reagir em mensagens Baileys / notas / falhas locais só
      // afeta o estado interno.
      let metaError: string | undefined;
      if (
        message.externalId &&
        message.conversation?.contactId &&
        message.conversation?.channelRef?.provider === "META_CLOUD_API"
      ) {
        const channelConfig = message.conversation.channelRef.config as
          | Record<string, unknown>
          | null
          | undefined;
        const metaClient = metaClientFromConfig(channelConfig);
        if (metaClient.configured) {
          const targets = await getContactWhatsAppTargets(
            message.conversation.contactId,
          );
          if (targets) {
            try {
              await metaClient.sendReaction(
                targets.to,
                message.externalId,
                metaEmoji,
                targets.recipient,
              );
            } catch (e) {
              metaError = e instanceof Error ? e.message : String(e);
              log.warn({ err: metaError }, "[meta-reaction] falhou");
            }
          }
        }
      }

      return NextResponse.json({ reactions: updated, metaError });
    } catch (e) {
      log.error({ err: e }, "POST falhou");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
