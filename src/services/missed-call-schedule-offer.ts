import { getContactWhatsAppTargets } from "@/lib/contact-whatsapp-target";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { enrichTemplateComponentsForFlowSend } from "@/lib/meta-whatsapp/enrich-template-flow";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";
import { publishNewMessage } from "@/lib/realtime-events";
import { buildOutboundTemplateMessageContent } from "@/lib/whatsapp-outbound-template-label";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";

function templateName(): string | null {
  const n = process.env.META_WHATSAPP_CALL_SCHEDULE_TEMPLATE_NAME?.trim();
  return n || null;
}

function templateLang(): string {
  return process.env.META_WHATSAPP_CALL_SCHEDULE_TEMPLATE_LANG?.trim() || "pt_BR";
}

function templateComponents(): unknown[] | undefined {
  const raw = process.env.META_WHATSAPP_CALL_SCHEDULE_TEMPLATE_COMPONENTS_JSON?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Após chamada de entrada perdida (sem `connect`), envia template Meta para o contacto
 * agendar / combinar retorno — se `META_WHATSAPP_CALL_SCHEDULE_TEMPLATE_NAME` estiver definido.
 */
export async function maybeSendMissedCallScheduleTemplate(params: {
  conversationId: string;
  contactId: string;
  callId: string;
}): Promise<void> {
  const name = templateName();
  if (!name) return;

  // Resolve cliente Meta pelo canal da conversa (per-tenant). Sem isso,
  // o template "agendar retorno" saia pelo numero da primeira org configurada
  // no env -> cross-tenant leak.
  const conv = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: { channelRef: { select: { id: true, config: true } } },
  });
  const channelConfig = conv?.channelRef?.config as
    | Record<string, unknown>
    | null
    | undefined;
  const metaClient = metaClientFromConfig(channelConfig);

  if (!metaClient.configured) {
    console.warn("[missed-call-schedule] Canal sem credenciais Meta — template não enviado.");
    return;
  }

  const extId = `call_schedule_tpl:${params.callId}`;
  const dup = await prisma.message.findFirst({
    where: { conversationId: params.conversationId, externalId: extId },
    select: { id: true },
  });
  if (dup) return;

  const waTarget = await getContactWhatsAppTargets(params.contactId);
  if (!waTarget?.to && !waTarget?.recipient) {
    console.warn("[missed-call-schedule] Contacto sem telefone/BSUID — template não enviado.");
    return;
  }

  const lang = templateLang();
  const components = templateComponents();

  let templateGraphId: string | null = null;
  try {
    const cfg = await prisma.whatsAppTemplateConfig.findFirst({
      where: { metaTemplateName: name },
      select: { metaTemplateId: true },
    });
    templateGraphId = cfg?.metaTemplateId?.trim() || null;
  } catch {
    /* ignore */
  }
  if (!templateGraphId) {
    console.warn(`[meta-flow-enrich] template config não encontrada para nome=${name}`);
  }

  let resolvedFlowToken: string | null = null;
  try {
    const enrichResult = await enrichTemplateComponentsForFlowSend(metaClient, {
      templateName: name,
      languageCode: lang,
      components,
      templateGraphId,
    });
    resolvedFlowToken = enrichResult.flowToken;
    await metaClient.sendTemplate(
      waTarget.to,
      name,
      lang,
      enrichResult.components,
      waTarget.recipient
    );
  } catch (e) {
    console.error("[missed-call-schedule] Falha ao enviar template:", e);
    return;
  }

  const content = buildOutboundTemplateMessageContent(name, "generic");
  await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: params.conversationId,
      content,
      direction: "out",
      messageType: "template",
      senderName: "Sistema",
      externalId: extId,
      ...(typeof resolvedFlowToken === "string" && resolvedFlowToken.trim()
        ? { flowToken: resolvedFlowToken.trim() }
        : {}),
    }),
  });

  await prisma.conversation
    .update({
      where: { id: params.conversationId },
      data: {
        lastMessageDirection: "out",
        updatedAt: new Date(),
      },
    })
    .catch(() => {});

  fireTrigger("message_sent", {
    contactId: params.contactId,
    data: buildMessageTriggerData({
      channel: "WhatsApp",
      conversationId: params.conversationId,
      extra: { templateScheduleOffer: true },
    }),
  }).catch(() => {});

  publishNewMessage({
    organizationId: getOrgIdOrNull(),
    conversationId: params.conversationId,
    contactId: params.contactId,
    direction: "out",
    content,
    timestamp: new Date(),
  });
}
