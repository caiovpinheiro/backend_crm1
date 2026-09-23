/**
 * Executor das ações estruturadas da v2.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import type { V2Action, V2ActionType, V2AgentConfig, V2Destination, V2LLMOutput } from "@/lib/ai-v2/types";
import { sendAgentMessage, type HumanBehaviorConfig } from "@/services/ai/piloting-actions";
import { applyExistingTagToContact } from "@/services/tags";
import { createDeal, updateDeal } from "@/services/deals";
import { createActivity } from "@/services/activities";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { enrichTemplateComponentsForFlowSend } from "@/lib/meta-whatsapp/enrich-template-flow";
import { buildOutboundTemplateMessageContent } from "@/lib/whatsapp-outbound-template-label";
import {
  templateVariablesFromSendComponents,
  renderTemplatePreview,
} from "@/lib/meta-whatsapp/build-template-components";
import { renderMessage, defaultFormatter } from "@/lib/ai-v2/message-render";
import { recordV2KnowledgeGap } from "./onboarding";
import { buildSurveyMessage, recordSurveyResponse } from "./survey";
import { simpleHandoff } from "./handoff";
import type { V2LoadedContext } from "./context";

export type V2ActionResult = {
  action: V2Action;
  ok: boolean;
  error?: string;
  // dados extras específicos por ação
  [key: string]: unknown;
};

export interface V2ActionContext {
  organizationId: string;
  conversationId: string;
  contactId?: string;
  dealId?: string;
  agentUserId: string;
  agentId: string;
  config: V2AgentConfig;
  context: V2LoadedContext;
  llmOutput: V2LLMOutput;
  channel?: string;
  autonomyMode: "AUTONOMOUS" | "DRAFT";
  setSurveyPending?: (pending: boolean) => void;
}

async function executeHandoff(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const destination = (action.destination ?? ctx.config.handoff.defaultDestination) as V2Destination;
  try {
    await simpleHandoff({
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      dealId: ctx.dealId,
      destination,
    });
    return { action, ok: true };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeAddTag(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  if (!ctx.contactId) return { action, ok: false, error: "No contact" };
  const tagName = typeof action.tag === "string" ? action.tag : "";
  if (!tagName) return { action, ok: false, error: "Missing tag" };
  try {
    const applied = await applyExistingTagToContact({
      contactId: ctx.contactId,
      tagName,
      source: "ai-v2",
    });
    return { action, ok: applied, applied };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isFieldWritable(config: V2AgentConfig, entity: string, field: string): boolean {
  const fields = entity === "contact" ? config.contextFields.contact : config.contextFields.deal;
  const cfg = fields.find((f) => f.key === field);
  if (!cfg) return false;
  return cfg.permissions.includes("write");
}

/** Aplica os campos configurados para atualizar no encerramento (closure.fieldUpdates). Respeita a permissão "write" do campo. */
export async function applyV2ClosureFieldUpdates(
  config: V2AgentConfig,
  contactId: string | undefined,
  dealId: string | undefined,
): Promise<Array<{ entity: string; field: string; ok: boolean; error?: string }>> {
  const updates = config.closure.fieldUpdates ?? [];
  const results: Array<{ entity: string; field: string; ok: boolean; error?: string }> = [];
  for (const update of updates) {
    const { entity, key, value } = update;
    if (!isFieldWritable(config, entity, key)) {
      results.push({ entity, field: key, ok: false, error: "read-only" });
      continue;
    }
    try {
      if (entity === "deal" && dealId) {
        await updateDeal(dealId, { [key]: value } as any);
        results.push({ entity, field: key, ok: true });
      } else if (entity === "contact" && contactId) {
        await (prisma as unknown as { contact: { update: (args: unknown) => Promise<unknown> } }).contact.update({
          where: { id: contactId },
          data: { [key]: value },
        });
        results.push({ entity, field: key, ok: true });
      } else {
        results.push({ entity, field: key, ok: false, error: "target not available" });
      }
    } catch (err) {
      results.push({ entity, field: key, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

async function executeUpdateField(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const entity = typeof action.entity === "string" ? action.entity : "";
  const field = typeof action.field === "string" ? action.field : "";
  const value = action.value;
  if (!field) return { action, ok: false, error: "Missing field" };
  if (!isFieldWritable(ctx.config, entity, field)) {
    return { action, ok: false, error: `Field ${entity}.${field} is read-only` };
  }
  try {
    if (entity === "deal" && ctx.dealId) {
      await updateDeal(ctx.dealId, { [field]: value } as any);
    } else if (entity === "contact" && ctx.contactId) {
      await (prisma as unknown as { contact: { update: (args: unknown) => Promise<unknown> } }).contact.update({
        where: { id: ctx.contactId },
        data: { [field]: value },
      });
    } else {
      return { action, ok: false, error: "Entity/target not available" };
    }
    return { action, ok: true };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeCreateDeal(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  if (!ctx.contactId) return { action, ok: false, error: "No contact" };
  const title = typeof action.title === "string" ? action.title : "Novo negócio";
  const stageId = typeof action.stageId === "string" ? action.stageId : undefined;
  try {
    const deal = await createDeal({
      title,
      contactId: ctx.contactId,
      stageId,
      status: "OPEN",
    } as any);
    return { action, ok: true, dealId: (deal as { id: string }).id };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeMoveStage(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  if (!ctx.dealId) return { action, ok: false, error: "No deal" };
  const stageId = typeof action.stageId === "string" ? action.stageId : "";
  if (!stageId) return { action, ok: false, error: "Missing stageId" };
  try {
    await updateDeal(ctx.dealId, { stageId } as any);
    return { action, ok: true };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeCreateActivity(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  if (!ctx.contactId) return { action, ok: false, error: "No contact" };
  const content = typeof action.content === "string" ? action.content : "";
  const type = typeof action.activityType === "string" ? action.activityType : "NOTE";
  try {
    const act = await createActivity({
      content,
      contactId: ctx.contactId,
      dealId: ctx.dealId,
      type: type as any,
    } as any);
    return { action, ok: true, activityId: (act as { id: string }).id };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeCloseConversation(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const reason = typeof action.reason === "string" ? action.reason : "resolved";
  const tabulationId = typeof action.tabulationId === "string" ? action.tabulationId : undefined;
  try {
    await (prisma as unknown as {
      conversation: {
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
      };
    }).conversation.update({
      where: { id: ctx.conversationId },
      data: {
        status: "RESOLVED",
        tabulationId: tabulationId ?? null,
      },
    });
    return { action, ok: true, reason };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeTabulate(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const tabulationId = typeof action.tabulationId === "string" ? action.tabulationId : "";
  if (!tabulationId) return { action, ok: false, error: "Missing tabulationId" };
  try {
    await (prisma as unknown as {
      conversation: {
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
      };
    }).conversation.update({
      where: { id: ctx.conversationId },
      data: { tabulationId },
    });
    return { action, ok: true, tabulationId };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeSetTheme(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  return { action, ok: true, themeId: action.themeId };
}

async function executeSetVariable(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  return { action, ok: true, key: action.key, value: action.value };
}

async function executeRecordKnowledgeGap(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const question = typeof action.question === "string" ? action.question : "";
  if (!question) return { action, ok: false, error: "Missing question" };
  try {
    await recordV2KnowledgeGap({
      organizationId: ctx.organizationId,
      agentId: ctx.agentId,
      themeId: typeof action.themeId === "string" ? action.themeId : undefined,
      question,
    });
    return { action, ok: true };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeStartSurvey(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  if (!ctx.contactId) return { action, ok: false, error: "No contact" };
  const score = Number(action.score);
  // Sem score = iniciar pesquisa; com score = registrar resposta.
  if (Number.isNaN(score)) {
    const question = buildSurveyMessage(ctx.config);
    if (!question) return { action, ok: false, error: "Survey disabled" };
    try {
      await sendV2TextMessage({
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        agentUserId: ctx.agentUserId,
        text: renderMessage(question, messageVars(ctx), defaultFormatter()),
        channel: ctx.channel,
        autonomyMode: ctx.autonomyMode,
        humanBehavior: v2HumanBehavior(ctx.config),
      });
      ctx.setSurveyPending?.(true);
      return { action, ok: true };
    } catch (err) {
      return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const reason = typeof action.reason === "string" ? action.reason : undefined;
  try {
    await recordSurveyResponse({
      organizationId: ctx.organizationId,
      contactId: ctx.contactId,
      dealId: ctx.dealId,
      agentId: ctx.agentId,
      score,
      reason,
    });
    ctx.setSurveyPending?.(false);
    return { action, ok: true };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeSendMessage(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const text = typeof action.text === "string" ? action.text : typeof action.message === "string" ? action.message : "";
  if (!text) return { action, ok: false, error: "Missing message text" };
  try {
    const rendered = renderMessage(text, messageVars(ctx), defaultFormatter());
    await sendV2TextMessage({
      conversationId: ctx.conversationId,
      contactId: ctx.contactId!,
      agentUserId: ctx.agentUserId,
      text: rendered,
      channel: ctx.channel,
      autonomyMode: ctx.autonomyMode,
      humanBehavior: v2HumanBehavior(ctx.config),
    });
    return { action, ok: true };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeNoReply(action: V2Action, _ctx: V2ActionContext): Promise<V2ActionResult> {
  return { action, ok: true };
}

async function executeAskWithOptions(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  // Retorna opções para o engine persistir e enviar como interativo.
  const options = Array.isArray(action.options) ? action.options : [];
  return { action, ok: true, options };
}

async function executeAddNote(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const content = typeof action.content === "string" ? action.content : "";
  if (!content) return { action, ok: false, error: "Missing note content" };
  if (!ctx.contactId && !ctx.dealId) return { action, ok: false, error: "No contact or deal target" };
  try {
    const orgId = ctx.organizationId;
    await prisma.note.create({
      data: {
        organizationId: orgId,
        content,
        contactId: ctx.contactId ?? null,
        dealId: ctx.dealId ?? null,
        userId: ctx.agentUserId,
      },
    });
    return { action, ok: true };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeSendMessageModel(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const modelId = typeof action.modelId === "string" ? action.modelId : "";
  if (!modelId) return { action, ok: false, error: "Missing modelId" };
  if (!ctx.contactId || !ctx.conversationId) return { action, ok: false, error: "No contact/conversation" };
  try {
    const orgId = getOrgIdOrNull() ?? ctx.organizationId;
    const template = await prisma.messageTemplate.findFirst({
      where: { id: modelId, organizationId: orgId },
      select: { id: true, name: true, content: true, mediaUrl: true, mediaType: true },
    });
    if (!template) return { action, ok: false, error: "Message model not found" };

    const vars = { ...ctx.llmOutput?.collected, ...messageVars(ctx), ...((action.variables as Record<string, string> | undefined) ?? {}) };
    const text = renderMessage(template.content, vars, defaultFormatter());
    await sendV2TextMessage({
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      agentUserId: ctx.agentUserId,
      text,
      channel: ctx.channel,
      autonomyMode: ctx.autonomyMode,
      humanBehavior: v2HumanBehavior(ctx.config),
    });
    return { action, ok: true, modelId, text };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeSendProduct(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const productId = typeof action.productId === "string" ? action.productId : "";
  if (!productId) return { action, ok: false, error: "Missing productId" };
  if (!ctx.contactId || !ctx.conversationId) return { action, ok: false, error: "No contact/conversation" };
  try {
    const orgId = getOrgIdOrNull() ?? ctx.organizationId;
    const product = await prisma.product.findFirst({
      where: { id: productId, organizationId: orgId, isActive: true },
      select: { id: true, name: true, price: true, description: true, sku: true, unit: true, customValues: { include: { customField: { select: { label: true, name: true } } } } },
    });
    if (!product) return { action, ok: false, error: "Product not found" };
    const fmtBRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
    const priceText = product.price ? fmtBRL.format(Number(product.price)) : "";
    const cfText = product.customValues
      .filter((v) => v.value && v.value.trim())
      .map((v) => `${v.customField.label ?? v.customField.name}: ${v.value}`)
      .join("\n");
    const lines = [product.name, priceText, product.description ?? ""].filter(Boolean);
    if (cfText) lines.push(cfText);
    const text = lines.join("\n");
    await sendV2TextMessage({
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      agentUserId: ctx.agentUserId,
      text,
      channel: ctx.channel,
      autonomyMode: ctx.autonomyMode,
      humanBehavior: v2HumanBehavior(ctx.config),
    });
    return { action, ok: true, productId, text };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeSendWhatsappTemplate(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const templateName = typeof action.templateName === "string" ? action.templateName : "";
  const languageCode = typeof action.languageCode === "string" ? action.languageCode : "pt_BR";
  const bodyVariables = Array.isArray(action.bodyVariables) ? action.bodyVariables.map(String) : [];
  if (!templateName) return { action, ok: false, error: "Missing templateName" };
  if (!ctx.contactId || !ctx.conversationId) return { action, ok: false, error: "No contact/conversation" };
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      select: { organizationId: true, channelRef: { select: { config: true } } },
    });
    if (!conv) return { action, ok: false, error: "Conversation not found" };
    const channelConfig = (conv.channelRef?.config as Record<string, unknown> | null) ?? {};
    const metaClient = metaClientFromConfig(channelConfig);
    if (!metaClient.configured) return { action, ok: false, error: "Meta channel not configured" };

    const contact = await prisma.contact.findUnique({ where: { id: ctx.contactId }, select: { phone: true } });
    if (!contact?.phone) return { action, ok: false, error: "Contact without phone" };

    const tplConfig = await prisma.whatsAppTemplateConfig.findFirst({
      where: { metaTemplateName: templateName },
      select: { id: true, metaTemplateId: true, bodyPreview: true, category: true },
    });
    const templateGraphId = tplConfig?.metaTemplateId?.trim() || null;
    const tplConfigId = tplConfig?.id ?? null;
    const tplBodyPreview = tplConfig?.bodyPreview?.trim() || null;
    const tplCategory = tplConfig?.category ?? null;

    const baseComponents = bodyVariables.length > 0
      ? [{ type: "body" as const, parameters: bodyVariables.map((text) => ({ type: "text" as const, text })) }]
      : undefined;
    const renderedTplBody = tplBodyPreview
      ? renderTemplatePreview(tplBodyPreview, templateVariablesFromSendComponents(baseComponents)) || tplBodyPreview
      : null;
    const tplChatContent = buildOutboundTemplateMessageContent(templateName, "generic", tplCategory, renderedTplBody);

    const enrichSend = await enrichTemplateComponentsForFlowSend(metaClient, {
      templateName,
      languageCode,
      components: baseComponents,
      templateGraphId,
    });
    const res = await metaClient.sendTemplate(contact.phone, templateName, languageCode, enrichSend.components);
    const externalId = res?.messages?.[0]?.id ?? null;

    const saved = await prisma.message.create({
      data: withOrgFromCtx({
        conversationId: ctx.conversationId,
        content: tplChatContent,
        direction: "out",
        messageType: "template",
        senderName: "Agente IA",
        externalId,
        aiAgentUserId: ctx.agentUserId,
        ...(typeof enrichSend.flowToken === "string" && enrichSend.flowToken.trim() ? { flowToken: enrichSend.flowToken.trim() } : {}),
        ...(tplConfigId ? { templateConfigId: tplConfigId } : {}),
      }),
    });
    const { sseBus } = await import("@/lib/sse-bus");
    sseBus.publish("new_message", {
      organizationId: conv.organizationId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      direction: "out",
      content: saved.content,
      timestamp: saved.createdAt,
    });
    return { action, ok: true, templateName, externalId };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function flattenForRender(input: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenForRender(value as Record<string, unknown>, fullKey));
    } else {
      out[fullKey] = value;
    }
  }
  return out;
}

function messageVars(ctx: V2ActionContext): Record<string, unknown> {
  return flattenForRender({
    contact: ctx.context.contact ?? {},
    deal: ctx.context.selectedDeal ?? {},
    ...ctx.llmOutput?.collected,
  });
}

const EXECUTORS: Partial<Record<V2ActionType, (action: V2Action, ctx: V2ActionContext) => Promise<V2ActionResult>>> = {
  handoff: executeHandoff,
  add_tag: executeAddTag,
  update_field: executeUpdateField,
  add_note: executeAddNote,
  create_deal: executeCreateDeal,
  move_stage: executeMoveStage,
  create_activity: executeCreateActivity,
  close_conversation: executeCloseConversation,
  tabulate_conversation: executeTabulate,
  set_theme: executeSetTheme,
  set_variable: executeSetVariable,
  record_knowledge_gap: executeRecordKnowledgeGap,
  start_survey: executeStartSurvey,
  ask_with_options: executeAskWithOptions,
  send_message: executeSendMessage,
  no_reply: executeNoReply,
  send_message_model: executeSendMessageModel,
  send_product: executeSendProduct,
  send_whatsapp_template: executeSendWhatsappTemplate,
};

export async function executeV2Actions(
  actions: V2Action[],
  ctx: V2ActionContext,
): Promise<{ results: V2ActionResult[]; anyHandoff: boolean; anyClose: boolean; themeId?: string; askOptions?: unknown[] }> {
  const results: V2ActionResult[] = [];
  let anyHandoff = false;
  let anyClose = false;
  let themeId: string | undefined;
  let askOptions: unknown[] | undefined;

  for (const action of actions) {
    const executor = EXECUTORS[action.type];
    let result: V2ActionResult;
    if (!executor) {
      result = { action, ok: false, error: `Action type ${action.type} not implemented` };
    } else {
      try {
        result = await executor(action, ctx);
      } catch (err) {
        result = { action, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    results.push(result);

    if (action.type === "handoff") anyHandoff = true;
    if (action.type === "close_conversation") anyClose = true;
    if (action.type === "set_theme" && result.ok) themeId = (result as { themeId?: string }).themeId;
    if (action.type === "ask_with_options" && result.ok) askOptions = (result as { options?: unknown[] }).options;
  }

  return { results, anyHandoff, anyClose, themeId, askOptions };
}

/** Defaults iguais à pilotagem v1: digitando + leitura ligados, 25 ms/char. */
export function v2HumanBehavior(config: {
  simulateTyping?: boolean;
  typingPerCharMs?: number;
  markMessagesRead?: boolean;
}): HumanBehaviorConfig {
  const pace = config.typingPerCharMs;
  return {
    simulateTyping: config.simulateTyping !== false,
    typingPerCharMs: typeof pace === "number" && pace >= 0 ? pace : 25,
    markMessagesRead: config.markMessagesRead !== false,
  };
}

/** Envia mensagem de texto simples via sendAgentMessage. */
export async function sendV2TextMessage(args: {
  conversationId: string;
  contactId: string;
  agentUserId: string;
  text: string;
  channel?: string;
  autonomyMode: "AUTONOMOUS" | "DRAFT";
  humanBehavior?: HumanBehaviorConfig;
}): Promise<void> {
  if (!args.text.trim()) return;
  await sendAgentMessage({
    conversationId: args.conversationId,
    contactId: args.contactId,
    agentUserId: args.agentUserId,
    autonomyMode: args.autonomyMode,
    text: args.text,
    channel: args.channel === "baileys" ? "baileys" : "meta",
    bypassAssigneeCheck: false,
    humanBehavior: args.humanBehavior ?? v2HumanBehavior({}),
  });
}
