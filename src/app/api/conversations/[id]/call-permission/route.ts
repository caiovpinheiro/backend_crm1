import { after, NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getCallPermissionTemplateName } from "@/lib/call-permission-env";
import { buildOutboundTemplateMessageContent } from "@/lib/whatsapp-outbound-template-label";
import { requireConversationAccess } from "@/lib/conversation-access";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getRequestContext, runWithContext } from "@/lib/request-context";
import { reopenResolvedAsNewTicket } from "@/services/conversations";
import {
  publishConversationUpdated,
  publishNewMessage,
} from "@/lib/realtime-events";

import { WhatsappCallConsentStatus } from "@prisma/client";

import type { InboxMessageDto } from "../messages/route";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/conversations/[id]/call-permission");

/** No background a Graph pode demorar; o request já foi respondido. */
const GRAPH_BG_TIMEOUT_MS = 15_000;

function strField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Cópia já conhecida pelo inbox — evita relistar `message_templates` no POST. */
function previewFromBody(b: Record<string, unknown>): {
  bodyText: string;
  headerText: string;
  footerText: string;
  buttons: string[];
} | null {
  const bodyText = strField(b.bodyText);
  const headerText = strField(b.headerText);
  const footerText = strField(b.footerText);
  const buttons = Array.isArray(b.buttons)
    ? b.buttons.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
    : [];
  if (!bodyText && !headerText && !footerText && buttons.length === 0) return null;
  return { bodyText, headerText, footerText, buttons };
}

function fillPlaceholders(text: string, name: string): string {
  const n = name.trim();
  if (!n) return text;
  return text.replace(/\{\{\s*\d+\s*\}\}/g, n);
}

/** Templates CALL_PERMISSION com `{{1}}` exigem body.parameters no Graph. */
function bodyComponentsFromTemplate(
  bodyText: string,
  contactName: string,
): unknown[] | undefined {
  const idxs = [...bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  if (idxs.length === 0) return undefined;
  const max = Math.max(...idxs.filter((n) => Number.isFinite(n) && n > 0));
  if (!Number.isFinite(max) || max < 1) return undefined;
  const name = contactName.trim() || "cliente";
  return [
    {
      type: "body",
      parameters: Array.from({ length: max }, () => ({ type: "text", text: name })),
    },
  ];
}

type RouteContext = { params: Promise<{ id: string }> };

const VALID_PATCH = new Set<string>(Object.values(WhatsappCallConsentStatus));

type SendResult =
  | { ok: true; dto: InboxMessageDto }
  | { ok: false; message: string };

async function dispatchCallPermissionTemplate(args: {
  conv: { id: string; organizationId: string; contactId: string | null };
  to: string | undefined;
  recipient: string | undefined;
  templateName: string;
  languageCode: string;
  contactName: string;
  bodyTextForParams: string;
  content: string;
  senderName: string;
  orgIdFilter: string;
  metaClient: ReturnType<typeof metaClientFromConfig>;
}): Promise<SendResult> {
  let externalId: string | null = null;
  try {
    const result = await args.metaClient.sendTemplate(
      args.to,
      args.templateName,
      args.languageCode,
      bodyComponentsFromTemplate(args.bodyTextForParams, args.contactName),
      args.recipient,
      { maxAttempts: 1, timeoutMs: GRAPH_BG_TIMEOUT_MS },
    );
    externalId = result.messages?.[0]?.id ?? null;
  } catch (e: unknown) {
    log.error({ err: e }, "[call-permission-template] falhou");
    const msg =
      e instanceof Error ? e.message : "Falha ao enviar template pelo WhatsApp.";
    try {
      await prisma.message.create({
        data: withOrgFromCtx({
          conversationId: args.conv.id,
          content: args.content,
          direction: "out",
          messageType: "template",
          senderName: args.senderName,
          sendStatus: "failed",
          sendError: msg.slice(0, 500),
        }),
      });
      publishNewMessage({
        organizationId: args.conv.organizationId,
        conversationId: args.conv.id,
        contactId: args.conv.contactId,
        direction: "out",
        content: args.content,
        timestamp: new Date(),
      });
    } catch (persistErr) {
      log.error({ err: persistErr }, "[call-permission] persist fail");
    }
    return { ok: false, message: msg };
  }

  const now = new Date();
  const prior = await prisma.conversation.findUnique({
    where: { id: args.conv.id },
    select: { whatsappCallConsentStatus: true },
  });
  // Reenviar o template NÃO revoga um opt-in ainda válido. Zerar para
  // REQUESTED apagava type/expiresAt e o botão de ligar ficava cinza
  // mesmo com "✅ Cliente aceitou" na timeline.
  const keepGranted = prior?.whatsappCallConsentStatus === "GRANTED";

  const savedMsg = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: args.conv.id,
      content: args.content,
      direction: "out",
      messageType: "template",
      senderName: args.senderName,
      ...(externalId ? { externalId } : {}),
    }),
  });

  if (!keepGranted) {
    await prisma.conversation.update({
      where: { id: args.conv.id },
      data: {
        whatsappCallConsentStatus: "REQUESTED",
        whatsappCallConsentUpdatedAt: now,
        updatedAt: now,
      },
    });
    try {
      await prisma.$executeRaw`
        UPDATE "conversations"
        SET
          "whatsappCallConsentType" = NULL,
          "whatsappCallConsentExpiresAt" = NULL
        WHERE "id" = ${args.conv.id}
          AND "organizationId" = ${args.orgIdFilter}
      `;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[call-permission] não resetou type/expiresAt (migration pendente?)",
      );
    }
  }

  publishNewMessage({
    organizationId: args.conv.organizationId,
    conversationId: args.conv.id,
    contactId: args.conv.contactId,
    direction: "out",
    content: args.content,
    timestamp: savedMsg.createdAt,
  });
  publishConversationUpdated({
    organizationId: args.conv.organizationId,
    conversationId: args.conv.id,
    contactId: args.conv.contactId,
    whatsappCallConsentStatus: keepGranted ? "GRANTED" : "REQUESTED",
  });

  return {
    ok: true,
    dto: {
      id: externalId ?? savedMsg.id,
      content: args.content,
      createdAt: savedMsg.createdAt.toISOString(),
      direction: "out",
      messageType: "template",
      senderName: args.senderName,
    },
  };
}

/**
 * POST: envia template de opt-in de chamada e marca REQUESTED.
 * Nome do template: corpo `templateName` ou env META_WHATSAPP_CALL_PERMISSION_TEMPLATE.
 * PATCH: ADMIN/MANAGER — ajuste manual do consentimento até o webhook de botões estar 100% alinhado.
 */
// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

      let languageCode = "pt_BR";
      let bodyFromRequest: Record<string, unknown> = {};
      try {
        bodyFromRequest = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      } catch {
        bodyFromRequest = {};
      }
      const b = bodyFromRequest;
      if (typeof b.languageCode === "string" && b.languageCode.trim()) {
        languageCode = b.languageCode.trim();
      }
      const fromBody =
        typeof b.templateName === "string" ? b.templateName.trim() : "";
      const templateName = fromBody || getCallPermissionTemplateName() || "";
      if (!templateName) {
        return NextResponse.json(
          {
            message:
              "Informe o nome do template no corpo (templateName) ou defina META_WHATSAPP_CALL_PERMISSION_TEMPLATE no servidor.",
          },
          { status: 400 }
        );
      }

      let conv = await prisma.conversation.findUnique({
        where: { id },
        include: {
          contact: { select: { phone: true, whatsappBsuid: true, name: true } },
          // Resolver cliente Meta correto pelo canal da conversa (per-tenant).
          channelRef: { select: { id: true, config: true } },
        },
      });

      if (!conv) {
        return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
      }
      if (conv.channel !== "whatsapp") {
        return NextResponse.json(
          { message: "Opt-in de chamada só se aplica a conversas WhatsApp." },
          { status: 400 }
        );
      }

      let reopenedConversationId: string | null = null;
      if (conv.status === "RESOLVED" && conv.contactId) {
        const reopened = await reopenResolvedAsNewTicket(conv.id);
        if (reopened.id !== conv.id) {
          const fresh = await prisma.conversation.findUnique({
            where: { id: reopened.id },
            include: {
              contact: { select: { phone: true, whatsappBsuid: true, name: true } },
              channelRef: { select: { id: true, config: true } },
            },
          });
          if (fresh) {
            reopenedConversationId = fresh.id;
            conv = fresh;
          }
        }
      }

      const digits = conv.contact?.phone?.replace(/\D/g, "") ?? "";
      const to = digits.length >= 8 ? digits : undefined;
      const recipient = conv.contact?.whatsappBsuid?.trim() || undefined;
      if (!to && !recipient) {
        return NextResponse.json(
          { message: "Contato sem telefone nem BSUID WhatsApp (Meta)." },
          { status: 400 }
        );
      }

      const channelConfig = conv.channelRef?.config as
        | Record<string, unknown>
        | null
        | undefined;
      const metaClient = metaClientFromConfig(channelConfig);

      if (!metaClient.configured) {
        return NextResponse.json(
          {
            message:
              "Canal WhatsApp da conversa sem credenciais Meta (accessToken/phoneNumberId). Configure em Canais.",
          },
          { status: 503 }
        );
      }

      const senderName = session.user.name ?? session.user.email ?? "Agente";
      log.info({ conversationId: id, templateName, languageCode }, "[call-permission] send");

      // Templates CALL_PERMISSIONS_REQUEST não usam WhatsApp Flow. Relistar
      // `message_templates` (preview + enrich) no POST estoura o timeout do
      // EasyPanel e o browser recebe 502 HTML em vez do JSON da API.
      const contactName = conv.contact?.name?.trim() ?? "";
      const previewRaw = previewFromBody(b);
      const preview = previewRaw
        ? {
            bodyText: fillPlaceholders(previewRaw.bodyText, contactName),
            headerText: fillPlaceholders(previewRaw.headerText, contactName),
            footerText: fillPlaceholders(previewRaw.footerText, contactName),
            buttons: previewRaw.buttons,
          }
        : null;
      const content = buildOutboundTemplateMessageContent(
        templateName,
        "call_permission",
        null,
        preview?.bodyText ?? null,
        preview
          ? {
              bodyText: preview.bodyText,
              headerText: preview.headerText,
              footerText: preview.footerText,
              buttons: preview.buttons,
            }
          : undefined,
      );

      const ctx = getRequestContext();
      if (!ctx) {
        return NextResponse.json(
          { message: "Contexto de organização ausente." },
          { status: 500 },
        );
      }

      const pending = runWithContext(ctx, () =>
        dispatchCallPermissionTemplate({
          conv: {
            id: conv.id,
            organizationId: conv.organizationId,
            contactId: conv.contactId,
          },
          to,
          recipient,
          templateName,
          languageCode,
          contactName,
          bodyTextForParams: previewRaw?.bodyText ?? "",
          content,
          senderName,
          orgIdFilter: session.user.organizationId ?? "__no_org__",
          metaClient,
        }),
      );

      // Responde na hora. Esperar a Graph (mesmo 2s) estoura o Traefik do
      // frontend e o browser vê 502 HTML. O chat atualiza por SSE.
      after(() =>
        pending
          .then((r) => {
            if (!r.ok) log.error({ detail: r.message }, "[call-permission] bg fail");
          })
          .catch((e) => log.error({ err: e }, "[call-permission] bg falhou")),
      );
      return NextResponse.json(
        {
          pending: true,
          ...(reopenedConversationId ? { reopenedConversationId } : {}),
        },
        { status: 202 },
      );
    } catch (e: unknown) {
      log.error({ err: e }, "POST falhou");
      const msg = e instanceof Error ? e.message : "Erro ao solicitar permissão de chamada.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const user = session.user as { id: string; role: "ADMIN" | "MANAGER" | "MEMBER" };
      if (user.role !== "ADMIN" && user.role !== "MANAGER") {
        return NextResponse.json({ message: "Sem permissão." }, { status: 403 });
      }

      const { id } = await context.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }
      const b = body as { status?: unknown };
      const raw = typeof b.status === "string" ? b.status.trim().toUpperCase() : "";
      const status =
        raw && VALID_PATCH.has(raw) ? (raw as WhatsappCallConsentStatus) : null;
      if (!status) {
        return NextResponse.json(
          { message: "Informe status: NONE, REQUESTED, GRANTED ou EXPIRED." },
          { status: 400 }
        );
      }

      const conv = await prisma.conversation.findUnique({
        where: { id },
        select: { id: true, channel: true, contactId: true, organizationId: true },
      });
      if (!conv) {
        return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
      }
      if (conv.channel !== "whatsapp") {
        return NextResponse.json({ message: "Apenas conversas WhatsApp." }, { status: 400 });
      }

      const now = new Date();
      await prisma.conversation.update({
        where: { id },
        data: {
          whatsappCallConsentStatus: status,
          whatsappCallConsentUpdatedAt: now,
          updatedAt: now,
        },
      });

      publishConversationUpdated({
        organizationId: conv.organizationId,
        conversationId: conv.id,
        contactId: conv.contactId,
        whatsappCallConsentStatus: status,
      });

      return NextResponse.json({ consentStatus: status });
    } catch (e: unknown) {
      log.error({ err: e }, "PATCH falhou");
      return NextResponse.json({ message: "Erro ao atualizar consentimento." }, { status: 500 });
    }
  });
}
