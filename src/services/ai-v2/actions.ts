/**
 * Executor das ações estruturadas da v2.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import type { V2Action, V2ActionType, V2AgentConfig, V2CRMContext, V2Destination, V2LLMOutput } from "@/lib/ai-v2/types";
import { sendAgentMessage } from "@/services/ai/piloting-actions";
import { executeDistribution } from "@/services/distribution";
import { applyExistingTagToContact } from "@/services/tags";
import { createDeal, updateDeal } from "@/services/deals";
import { createActivity } from "@/services/activities";
import { recordV2KnowledgeGap } from "./onboarding";
import { recordSurveyResponse } from "./survey";
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
}

async function executeHandoff(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const destination = (action.destination ?? ctx.config.handoff.defaultDestination) as V2Destination;
  let departmentId: string | undefined;

  if (destination.type === "department") departmentId = destination.id;

  try {
    await executeDistribution({
      conversationId: ctx.conversationId,
      contactId: ctx.contactId ?? null,
      dealId: ctx.dealId ?? null,
      triggerSource: "AI_AGENT",
      departmentId: departmentId ?? null,
      reassign: true,
      allowOrgWideFallback: false,
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

async function executeUpdateField(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const entity = typeof action.entity === "string" ? action.entity : "";
  const field = typeof action.field === "string" ? action.field : "";
  const value = action.value;
  if (!field) return { action, ok: false, error: "Missing field" };
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
  const score = Number(action.score);
  const reason = typeof action.reason === "string" ? action.reason : undefined;
  if (Number.isNaN(score) || !ctx.contactId) return { action, ok: false, error: "Invalid survey" };
  try {
    await recordSurveyResponse({
      organizationId: ctx.organizationId,
      contactId: ctx.contactId,
      dealId: ctx.dealId,
      agentId: ctx.agentId,
      score,
      reason,
    });
    return { action, ok: true };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeAskWithOptions(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  // Retorna opções para o engine persistir e enviar como interativo.
  const options = Array.isArray(action.options) ? action.options : [];
  return { action, ok: true, options };
}

async function executeSendMessageModel(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const modelId = typeof action.modelId === "string" ? action.modelId : "";
  return { action, ok: true, modelId };
}

async function executeSendProduct(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const productId = typeof action.productId === "string" ? action.productId : "";
  return { action, ok: true, productId };
}

async function executeSendWhatsappTemplate(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const templateName = typeof action.templateName === "string" ? action.templateName : "";
  return { action, ok: true, templateName };
}

const EXECUTORS: Partial<Record<V2ActionType, (action: V2Action, ctx: V2ActionContext) => Promise<V2ActionResult>>> = {
  handoff: executeHandoff,
  add_tag: executeAddTag,
  update_field: executeUpdateField,
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

/** Envia mensagem de texto simples via sendAgentMessage. */
export async function sendV2TextMessage(args: {
  conversationId: string;
  contactId: string;
  agentUserId: string;
  text: string;
  channel?: string;
  autonomyMode: "AUTONOMOUS" | "DRAFT";
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
  });
}
