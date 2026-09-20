/**
 * Motor simples de agentes de IA (v2).
 *
 * - Reaproveita Turn Manager persistente, envio WhatsApp, Prisma, filas e chave OpenAI.
 * - Não depende do runner/tools/inbox-handler antigos.
 * - Sem termos de domínio acadêmico no código.
 */

import { prisma } from "@/lib/prisma";
import { validateSimpleConfig } from "@/lib/ai-simple/config";
import type { SimpleAction, SimpleActionType, SimpleConfig, SimpleContext, SimpleLLMOutput, SimpleResult, SimpleStage } from "@/lib/ai-simple/types";
import {
  buildSimpleConfirmationMessage,
  buildSimpleHandoffMessage,
  buildSimpleIdentificationMessage,
  buildSimpleSystemPrompt,
} from "@/lib/ai-simple/prompt";
import { generateSimpleResponse } from "@/services/ai-simple/llm";
import { executeSimpleActions } from "@/services/ai-simple/actions";
import { simpleHandoff } from "@/services/ai-simple/handoff";
import type { RunContext } from "@/services/ai/tools";
import {
  ensureSimpleState,
  getSimpleState,
  resetSimpleStateHumanActive,
  updateSimpleState,
} from "@/services/ai-simple/state";
import { createSimpleTurnLog, type CreateSimpleLogInput } from "@/services/ai-simple/log";
import { sendAgentMessage } from "@/services/ai/piloting-actions";

export type SimpleTurnInput = {
  organizationId: string;
  conversationId: string;
  contactId: string;
  channel: "meta" | "baileys";
  userMessage: string;
  turnId?: string | null;
};

export type SimpleEngineDeps = {
  generate?: typeof generateSimpleResponse;
  send?: typeof sendAgentMessage;
  handoff?: typeof simpleHandoff;
  executeActions?: typeof executeSimpleActions;
  ensureState?: (
    organizationId: string,
    conversationId: string,
    agentId: string,
  ) => Promise<{ id: string; stage: string; mode: string | null; humanActive: boolean; identificationAttempts: number }>;
  updateState?: (
    organizationId: string,
    conversationId: string,
    patch: { stage?: SimpleStage; mode?: string | null; humanActive?: boolean; identificationAttempts?: number },
  ) => Promise<void>;
  createLog?: (input: CreateSimpleLogInput) => Promise<{ id: string }>;
};

export async function processSimpleTurn(
  input: SimpleTurnInput,
  deps: SimpleEngineDeps = {},
): Promise<SimpleResult> {
  const startedAt = Date.now();
  const gen = deps.generate ?? generateSimpleResponse;
  const send = deps.send ?? sendAgentMessage;
  const doHandoff = deps.handoff ?? simpleHandoff;
  const doActions = deps.executeActions ?? executeSimpleActions;
  const ensureState = deps.ensureState ?? ensureSimpleState;
  const updateStateFn = deps.updateState ?? updateSimpleState;
  const createLog = deps.createLog ?? createSimpleTurnLog;

  const conversation = (await (prisma as unknown as {
    conversation: { findUnique: (args: unknown) => Promise<unknown> };
  }).conversation.findUnique({
    where: { id: input.conversationId },
    select: {
      assignedToId: true,
      assignedTo: { select: { id: true, type: true, aiAgentConfig: { select: { id: true, engine: true, simpleConfig: true, model: true, temperature: true, user: { select: { id: true, name: true } } } } } },
    },
  })) as {
    assignedTo?: {
      id: string;
      type: string;
      aiAgentConfig?: {
        id: string;
        engine?: string;
        simpleConfig?: unknown;
        model: string;
        temperature: number;
        user?: { id: string; name: string } | null;
      };
    } | null;
  } | null;

  if (!conversation?.assignedTo?.aiAgentConfig) {
    throw new Error("[ai-simple] conversa não está atribuída a um agente v2");
  }

  const agent = conversation.assignedTo.aiAgentConfig;
  if (agent.engine !== "simple") {
    throw new Error(`[ai-simple] agente não usa engine=simple (engine=${agent.engine ?? "legacy"})`);
  }

  const configResult = validateSimpleConfig(agent.simpleConfig ?? {});
  if (!configResult.ok) {
    throw new Error(`[ai-simple] config inválida: ${configResult.errors.message}`);
  }
  const config = configResult.config;

  const state = await ensureState(
    input.organizationId,
    input.conversationId,
    agent.id,
  );

  if (state.humanActive) {
    const log = await createLog({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      agentId: agent.id,
      turnId: input.turnId ?? null,
      inboundText: input.userMessage,
      contextSnapshot: {},
      prompt: "",
      reply: null,
      error: "human_active: skipped",
      latencyMs: Date.now() - startedAt,
    });
    return {
      reply: null,
      handoff: false,
      actionsExecuted: [],
      actionsDiscarded: [],
      nextStage: state.stage as SimpleStage,
      nextMode: state.mode,
      logId: log.id,
    };
  }

  const contactDeal = await loadContactAndDeal(
    input.organizationId,
    input.contactId,
    config,
  );

  const history = await loadSimpleHistory(input.conversationId, config.historyLimit);

  const ctx: SimpleContext = {
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    agentId: agent.id,
    agentName: conversation.assignedTo.aiAgentConfig.user?.name ?? "Agente",
    userMessage: input.userMessage,
    turnId: input.turnId ?? null,
    history,
    state: {
      stage: state.stage as SimpleStage,
      mode: state.mode,
      humanActive: state.humanActive,
      identificationAttempts: state.identificationAttempts,
    },
    contact: contactDeal.contact,
    deal: contactDeal.deal,
  };

  const prompt = buildSimpleSystemPrompt(config, ctx);
  const contextSnapshot = {
    contact: ctx.contact,
    deal: ctx.deal,
    state: ctx.state,
    history: history.map((h) => ({ role: h.role, content: h.content })),
  };

  let stage: SimpleStage = ctx.state.stage;
  let mode: string | null = ctx.state.mode;
  let reply: string | null = null;
  let handoff = false;
  let executedActions: SimpleAction[] = [];
  let discardedActions: SimpleAction[] = [];
  let error: string | null = null;
  let tokens = { inputTokens: 0, outputTokens: 0 };
  let llmOutput: SimpleLLMOutput | null = null;

  try {
    const wasPreLlm = stage === "new" || stage === "awaiting_identification";

    if (stage === "new") {
      if (ctx.deal) {
        reply = buildSimpleConfirmationMessage(config, ctx);
        stage = "awaiting_confirmation";
      } else if (config.onDealNotFound === "ask_identification") {
        reply = buildSimpleIdentificationMessage(config, ctx);
        stage = "awaiting_identification";
      } else {
        handoff = true;
      }
    }

    if (stage === "awaiting_identification") {
      const identified = await tryIdentifyDeal(
        input.organizationId,
        input.contactId,
        input.userMessage,
      );
      if (identified) {
        ctx.deal = identified;
        reply = buildSimpleConfirmationMessage(config, ctx);
        stage = "awaiting_confirmation";
        mode = null;
      } else {
        const attempts = ctx.state.identificationAttempts + 1;
        if (attempts >= 2) {
          handoff = true;
        } else {
          reply = buildSimpleIdentificationMessage(config, ctx);
          stage = "awaiting_identification";
          mode = null;
        }
        await updateStateFn(input.organizationId, input.conversationId, {
          identificationAttempts: attempts,
        });
      }
    }

    if (!handoff && !wasPreLlm && (stage === "active" || stage === "awaiting_confirmation")) {
      const result = await runSimpleLLM(ctx, config, prompt, agent.model, agent.temperature, gen);
      tokens = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      llmOutput = result.output;
      error = result.error;

      if (llmOutput) {
        reply = llmOutput.reply || null;
        mode = llmOutput.mode ?? mode;

        if (stage === "awaiting_confirmation" && llmOutput.confirmed === false) {
          reply = buildSimpleIdentificationMessage(config, ctx);
          stage = "awaiting_identification";
          mode = null;
        } else {
          stage = "active";
        }

        if (llmOutput.handoff) {
          handoff = true;
        }

        const actionsResult = await doActions({
          actions: normalizeActions(llmOutput.actions),
          allowedActions: config.allowedActions,
          runContext: buildRunContext(
            input,
            conversation.assignedTo.id,
            input.contactId,
            contactDeal.dealId,
            agent.id,
          ),
        });
        executedActions = actionsResult.executed.map((e) => e.action);
        discardedActions = actionsResult.discarded;
      } else {
        // JSON inválido: uma nova tentativa.
        const retry = await runSimpleLLM(ctx, config, prompt + "\n\nATENÇÃO: a resposta anterior não foi um JSON válido. Envie EXATAMENTE o JSON solicitado.", agent.model, agent.temperature, gen);
        tokens = { inputTokens: retry.inputTokens, outputTokens: retry.outputTokens };
        llmOutput = retry.output;
        error = retry.error;

        if (llmOutput) {
          reply = llmOutput.reply || null;
          mode = llmOutput.mode ?? mode;
          if (llmOutput.handoff) handoff = true;
          stage = "active";
          const actionsResult = await doActions({
            actions: normalizeActions(llmOutput.actions),
            allowedActions: config.allowedActions,
            runContext: buildRunContext(
              input,
              conversation.assignedTo.id,
              input.contactId,
              contactDeal.dealId,
              agent.id,
            ),
          });
          executedActions = actionsResult.executed.map((e) => e.action);
          discardedActions = actionsResult.discarded;
        } else {
          handoff = true;
        }
      }
    }

    // Envia reply normal (não-handoff).
    if (!handoff && reply?.trim()) {
      await send({
        conversationId: input.conversationId,
        contactId: input.contactId,
        agentUserId: conversation.assignedTo.id,
        autonomyMode: "AUTONOMOUS",
          text: reply,
          channel: input.channel,
        }).catch((err) => {
        console.error("[ai-simple] send failed", err);
        error = err instanceof Error ? err.message : String(err);
      });
    }

    // Handoff.
    if (handoff) {
      const handoffText = [reply?.trim(), buildSimpleHandoffMessage(config, ctx)]
        .filter(Boolean)
        .join("\n\n");

      if (handoffText) {
        await send({
          conversationId: input.conversationId,
          contactId: input.contactId,
          agentUserId: conversation.assignedTo.id,
          autonomyMode: "AUTONOMOUS",
          text: handoffText,
          channel: input.channel,
          bypassAssigneeCheck: true,
        }).catch((err) => {
          console.error("[ai-simple] handoff send failed", err);
        });
      }

      await doHandoff({
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        contactId: input.contactId,
        dealId: contactDeal.dealId,
        agentUserId: conversation.assignedTo.id,
        queue: config.handoffQueue,
        reason: llmOutput?.reason ?? "handoff solicitado",
      });

      await updateStateFn(input.organizationId, input.conversationId, {
        humanActive: true,
        stage: "active",
        mode,
      });
    } else {
      await updateStateFn(input.organizationId, input.conversationId, {
        stage,
        mode,
      });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("[ai-simple] processSimpleTurn error", {
      conversationId: input.conversationId,
      error,
    });
  }

  const log = await createLog({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    agentId: agent.id,
    turnId: input.turnId ?? null,
    inboundText: input.userMessage,
    contextSnapshot,
    prompt,
    llmOutput,
    discardedActions,
    executedActions,
    reply,
    handoff,
    error,
    latencyMs: Date.now() - startedAt,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
  });

  return {
    reply,
    handoff,
    actionsExecuted: executedActions,
    actionsDiscarded: discardedActions,
    nextStage: stage,
    nextMode: mode,
    logId: log.id,
  };
}

async function runSimpleLLM(
  ctx: SimpleContext,
  config: SimpleConfig,
  prompt: string,
  model: string,
  temperature: number,
  generate: typeof generateSimpleResponse,
): Promise<{
  output: SimpleLLMOutput | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
}> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...ctx.history,
    { role: "user", content: ctx.userMessage },
  ];

  const result = await generate({
    agentId: ctx.agentId,
    model,
    temperature,
    system: prompt,
    messages,
  });

  if (!result.ok) {
    return {
      output: null,
      error: result.error,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  return {
    output: result.output,
    error: null,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

function normalizeActions(
  raw: Array<{
    tool: SimpleActionType;
    args?: Record<string, unknown>;
  }>,
): SimpleAction[] {
  return (raw ?? []).map((a) => {
    const args = a.args ?? {};
    switch (a.tool) {
      case "create_deal":
        return { type: "create_deal", args: { title: String(args.title ?? ""), value: Number(args.value ?? 0) || undefined, notes: args.notes ? String(args.notes) : undefined } };
      case "add_tag":
        return { type: "add_tag", args: { tagName: String(args.tagName ?? "") } };
      case "create_activity":
        return { type: "create_activity", args: { type: String(args.type ?? "NOTE"), title: String(args.title ?? ""), description: args.description ? String(args.description) : undefined, scheduledAt: args.scheduledAt ? String(args.scheduledAt) : undefined } };
      case "search_products":
        return { type: "search_products", args: { query: String(args.query ?? ""), type: args.type === "PRODUCT" || args.type === "SERVICE" ? args.type : undefined, limit: Number(args.limit ?? 5) } };
      case "move_stage":
        return { type: "move_stage", args: { stageName: String(args.stageName ?? ""), pipelineName: args.pipelineName ? String(args.pipelineName) : undefined, reason: args.reason ? String(args.reason) : undefined } };
      case "send_whatsapp_template":
        return { type: "send_whatsapp_template", args: { templateName: String(args.templateName ?? ""), languageCode: args.languageCode ? String(args.languageCode) : undefined, bodyVariables: Array.isArray(args.bodyVariables) ? args.bodyVariables.map(String) : undefined } };
      default:
        return { type: "add_tag", args: { tagName: "" } };
    }
  });
}

function buildRunContext(
  input: SimpleTurnInput,
  assignedToUserId: string,
  contactId: string,
  dealId: string | null,
  agentConfigId: string,
): RunContext {
  return {
    agentUserId: assignedToUserId,
    agentId: agentConfigId,
    conversationId: input.conversationId,
    contactId,
    dealId,
    userMessage: input.userMessage,
    priorUserMessages: [],
    verticalPack: null,
    inboxPolicy: null,
  };
}

type ContactDealResult = {
  contact: Record<string, unknown> | null;
  deal: Record<string, unknown> | null;
  dealId: string | null;
};

export async function loadContactAndDeal(
  organizationId: string,
  contactId: string,
  config: SimpleConfig,
): Promise<ContactDealResult> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    include: {
      tags: { include: { tag: { select: { name: true } } } },
    },
  });

  if (!contact) {
    return { contact: null, deal: null, dealId: null };
  }

  const deal = await prisma.deal.findFirst({
    where: { contactId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    include: {
      stage: { include: { pipeline: { select: { name: true } } } },
    },
  });

  return {
    contact: buildEntitySnapshot(contact, config.contextFields.contact),
    deal: deal ? buildEntitySnapshot(deal, config.contextFields.deal) : null,
    dealId: deal?.id ?? null,
  };
}

function buildEntitySnapshot(
  entity: Record<string, unknown>,
  requestedFields: string[],
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const field of requestedFields) {
    const value = getPath(entity, field);
    if (value !== undefined && value !== null) {
      snapshot[field] = value;
    }
  }
  return snapshot;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export async function loadSimpleHistory(
  conversationId: string,
  limit: number,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      direction: { in: ["in", "out"] },
      isPrivate: false,
      messageType: { not: "note" },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { direction: true, content: true, authorType: true },
  });

  return rows
    .reverse()
    .map((m) => ({
      role: (m.direction === "out" ? "assistant" : "user") as "user" | "assistant",
      content: m.content ?? "",
    }))
    .filter((m) => m.content.trim());
}

async function tryIdentifyDeal(
  organizationId: string,
  contactId: string,
  message: string,
): Promise<Record<string, unknown> | null> {
  const email = extractEmail(message);
  const phone = extractPhone(message);

  if (!email && !phone) return null;

  let targetContact = null;

  if (email) {
    targetContact = await prisma.contact.findFirst({
      where: { organizationId, email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
  }

  if (!targetContact && phone) {
    targetContact = await prisma.contact.findFirst({
      where: { organizationId, phone: { contains: phone } },
      select: { id: true },
    });
  }

  const searchContactId = targetContact?.id ?? contactId;

  const deal = await prisma.deal.findFirst({
    where: { contactId: searchContactId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    include: {
      stage: { include: { pipeline: { select: { name: true } } } },
    },
  });

  return deal ? buildEntitySnapshot(deal, ["title", "value", "stage.name"]) : null;
}

function extractEmail(text: string): string | null {
  const match = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.exec(text);
  return match?.[0].toLowerCase() ?? null;
}

function extractPhone(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-11);
  return null;
}

export async function releaseSimpleConversationToBot(
  organizationId: string,
  conversationId: string,
): Promise<void> {
  const state = await getSimpleState(organizationId, conversationId);
  if (!state) return;
  await resetSimpleStateHumanActive(organizationId, conversationId);
}
