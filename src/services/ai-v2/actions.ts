/**
 * Executor das ações estruturadas da v2.
 * Nenhum domínio de cliente.
 */

import { toWhatsAppText } from "./reply-format";
import { touchConversationLastMessageAt } from "@/lib/conversation-last-message";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import type { V2Action, V2ActionType, V2AgentConfig, V2Destination, V2LLMOutput } from "@/lib/ai-v2/types";
import { sendAgentMessage, type HumanBehaviorConfig } from "@/services/ai/piloting-actions";
import type { V2InteractivePayload } from "./interactive";
import { adaptMessageModelText } from "./message-adapt";
import { MESSAGE_MODEL_REPEATED, lastV2ResetAt } from "./sent-materials";
import { applyExistingTagToContact } from "@/services/tags";
import { createDeal, updateDeal } from "@/services/deals";
import { createActivity } from "@/services/activities";
import { randomUUID } from "node:crypto";

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
import { traceStep } from "./trace";

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
  /** Mensagem do cliente no turno (para adaptar mensagem pronta). */
  userMessage?: string;
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

/**
 * Só registra a tabulação. O encerramento em si é do motor (`closeState`),
 * que roda quando esta ação vem no turno: aqui ele acontecia duas vezes e,
 * sem tabulação na ação, apagava a que a conversa já tinha.
 */
async function executeCloseConversation(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const reason = typeof action.reason === "string" ? action.reason : "resolved";
  const tabulationId = typeof action.tabulationId === "string" ? action.tabulationId : undefined;
  try {
    if (tabulationId) {
      await (prisma as unknown as {
        conversation: {
          update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
        };
      }).conversation.update({
        where: { id: ctx.conversationId },
        data: { tabulationId },
      });
    }
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
      select: { id: true, name: true, content: true, mediaUrl: true, mediaType: true, mediaName: true, attachments: true },
    });
    if (!template) return { action, ok: false, error: "Message model not found" };

    const vars = { ...ctx.llmOutput?.collected, ...messageVars(ctx), ...((action.variables as Record<string, string> | undefined) ?? {}) };
    let text = renderMessage(template.content ?? "", vars, defaultFormatter());
    // Reenvio só do anexo (o cliente disse que não recebeu): o texto já chegou.
    const mediaOnly = (action as { mediaOnly?: unknown }).mediaOnly === true;
    // Modo "só a resposta"/"combinar": da mensagem pronta só saem os arquivos.
    const filesOnly = (action as { filesOnly?: unknown }).filesOnly === true;
    const skipText = mediaOnly || filesOnly;
    // "Adaptar": só com a opção ligada na config e o modelo pedindo.
    if (!skipText && action.adapt === true && ctx.config.messageModelAdapt === true && text.trim() && ctx.userMessage?.trim()) {
      const adapted = await adaptMessageModelText({ agentId: ctx.agentId, config: ctx.config, text, clientMessage: ctx.userMessage });
      traceStep("ações", adapted.adapted
        ? `Mensagem pronta "${template.name}" adaptada à conversa`
        : `Mensagem pronta "${template.name}" enviada como está: a versão adaptada ${describeAdaptRejection(adapted.reason)}`);
      text = adapted.text;
    }
    // Mensagem pronta só com anexo (sem texto) é válida.
    if (filesOnly) traceStep("ações", `Mensagem pronta "${template.name}": só os arquivos (o texto não vai, pelo modo escolhido)`);
    if (text.trim() && !skipText) {
      const sent = await sendV2TextMessage({
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        agentUserId: ctx.agentUserId,
        text,
        channel: ctx.channel,
        autonomyMode: ctx.autonomyMode,
        humanBehavior: v2HumanBehavior(ctx.config),
      });
      // Antes o resultado era ignorado: texto barrado saía como ✓ e o
      // cliente ficava só com o "vou te enviar".
      if (!sent.sent) {
        return { action, ok: false, modelId, error: sent.reason === "near_duplicate" ? MESSAGE_MODEL_REPEATED : (sent.reason ?? "não enviada") };
      }
    }

    // Anexos (imagem, vídeo, áudio, documento): antes o v2 mandava só o
    // texto do modelo e descartava a mídia. Mesmo envio do agente v1 e do
    // inbox humano: só arquivo do armazenamento da org, até 2 por vez,
    // sem repetir o mesmo arquivo na conversa em 7 dias — contados a partir
    // do último #reset, para o teste receber o anexo de novo.
    const { mediaFromTemplateRow } = await import("@/services/ai/message-models-retrieval");
    const media = mediaFromTemplateRow(template);
    let mediaSent = 0;
    if (media.length > 0) {
      if (ctx.autonomyMode === "DRAFT") {
        traceStep("mídia", `Anexos de "${template.name}" não enviados (modo sugestão)`);
      } else {
        const { sendAgentFollowUpMedia, mediaNotSentTrace } = await import("@/services/ai/send-agent-media");
        const since = await lastV2ResetAt(ctx.conversationId).catch(() => null);
        let report: Parameters<typeof mediaNotSentTrace>[1];
        mediaSent = await sendAgentFollowUpMedia({
          conversationId: ctx.conversationId,
          contactId: ctx.contactId,
          agentUserId: ctx.agentUserId,
          attachments: media,
          ...(since ? { since } : {}),
          ...(mediaOnly ? { ignoreRecent: true } : {}),
          report: (r) => {
            report = r;
          },
        });
        const { isOrgOwnedStorageUrl } = await import("@/lib/storage/read-for-send");
        const external = media.filter((m) => !isOrgOwnedStorageUrl(m.url));
        if (mediaSent > 0) for (const m of media) sentMediaNames(ctx).add(mediaKey(m.name ?? ""));
        traceStep("mídia", mediaSent > 0
          ? `${mediaOnly ? "Reenvio a pedido do cliente: " : ""}${mediaSent} anexo(s) de "${template.name}" na fila de envio ao WhatsApp: ${media.slice(0, mediaSent).map((m) => m.name ?? "arquivo").join(", ")} — a entrega (enviada/falhou) aparece em “Entrega” no turno`
          : external.length === media.length
            ? `Anexos de "${template.name}" não enviados: são links externos, não arquivos enviados ao CRM (${external.map((m) => m.name ?? "arquivo").join(", ")})`
            : mediaNotSentTrace(`Anexos de "${template.name}"`, report));
      }
    }
    if (mediaOnly && mediaSent === 0) return { action, ok: false, modelId, error: "anexo não pôde ser reenviado" };
    return { action, ok: true, modelId, text: skipText ? "" : text, mediaSent };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Por que a versão adaptada da mensagem pronta foi descartada, em linguagem clara. */
function describeAdaptRejection(reason: string | undefined): string {
  const r = reason ?? "";
  let m = r.match(/^perdeu o link (.+)$/);
  if (m) return `tinha deixado de fora o link ${m[1]} do texto original`;
  m = r.match(/^link novo (.+)$/);
  if (m) return `trazia um link que não está no texto original (${m[1]})`;
  m = r.match(/^perdeu "(.+)"$/);
  if (m) return `tinha deixado de fora o número "${m[1]}" do texto original`;
  m = r.match(/^número novo "(.+)"$/);
  if (m) return `trazia um número que não está no texto original ("${m[1]}")`;
  if (r === "vazia") return "veio vazia";
  if (r === "muito maior que a original") return "ficou muito maior que o texto original";
  return r ? `não passou na conferência (${r})` : "não passou na conferência";
}

/** Nome do arquivo sem extensão nem acento, para reconhecer o mesmo anexo. */
function mediaKey(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\.[a-z0-9]{2,5}$/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Arquivos enviados neste turno (mensagem pronta), para o anexo do material não repetir. */
const SENT_MEDIA = new WeakMap<object, Set<string>>();
function sentMediaNames(ctx: V2ActionContext): Set<string> {
  let set = SENT_MEDIA.get(ctx);
  if (!set) SENT_MEDIA.set(ctx, (set = new Set()));
  return set;
}

/** Anexos dos materiais (vídeo, imagem, áudio, PDF), pelo mesmo envio das mensagens prontas. */
async function executeSendMaterialAttachment(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const raw = (action as { attachmentIds?: unknown }).attachmentIds;
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return { action, ok: false, error: "Missing attachmentIds" };
  if (!ctx.contactId || !ctx.conversationId) return { action, ok: false, error: "No contact/conversation" };
  try {
    const { attachmentsByIds } = await import("./material-attachments");
    const found = await attachmentsByIds(ctx.agentId, ids);
    if (found.length === 0) return { action, ok: false, error: "Attachment not found" };
    // O mesmo arquivo já foi com a mensagem pronta deste turno (mesmo nome).
    const already = sentMediaNames(ctx);
    const list = found.filter((a) => !already.has(mediaKey(a.name)));
    if (list.length < found.length) traceStep("mídia", `Não repetido (já foi com a mensagem pronta): ${found.filter((a) => already.has(mediaKey(a.name))).map((a) => a.name).join(", ")}`);
    if (list.length === 0) return { action, ok: true, mediaSent: 0, text: "" };
    const text = list.map((a) => a.description || a.name).join("\n");
    if (ctx.autonomyMode === "DRAFT") {
      traceStep("mídia", `Anexos do material não enviados (modo sugestão): ${list.map((a) => a.name).join(", ")}`);
      return { action, ok: true, mediaSent: 0, text };
    }
    const { sendAgentFollowUpMedia, mediaNotSentTrace } = await import("@/services/ai/send-agent-media");
    const { resendSince } = await import("./material-attachments");
    const reports: Array<{ otherOrg: string[]; alreadySent: string[] }> = [];
    const lastReset = await lastV2ResetAt(ctx.conversationId).catch(() => null);
    // A trava de repetição é de cada anexo ("7d" padrão; "always" sai sempre).
    let mediaSent = 0;
    for (const window of [...new Set(list.map((a) => a.resendWindow))]) {
      const group = list.filter((a) => a.resendWindow === window);
      mediaSent += await sendAgentFollowUpMedia({
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        agentUserId: ctx.agentUserId,
        attachments: group.map((a) => ({ url: a.url, mimeType: a.mimeType, name: a.name })),
        since: resendSince(window, lastReset),
        report: (r) => reports.push(r),
      });
    }
    traceStep("mídia", mediaSent > 0
      ? `${mediaSent} anexo(s) do material na fila de envio ao WhatsApp: ${list.slice(0, mediaSent).map((a) => a.name).join(", ")} — a entrega (enviada/falhou) aparece em “Entrega” no turno`
      : mediaNotSentTrace("Anexos do material", { otherOrg: reports.flatMap((r) => r.otherOrg), alreadySent: reports.flatMap((r) => r.alreadySent) }));
    return { action, ok: true, mediaSent, text };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeSendWhatsappFlow(action: V2Action, ctx: V2ActionContext): Promise<V2ActionResult> {
  const flowId = typeof action.flowId === "string" ? action.flowId.trim() : "";
  if (!flowId) return { action, ok: false, error: "Missing flowId" };
  if (!ctx.contactId || !ctx.conversationId) return { action, ok: false, error: "No contact/conversation" };
  if (ctx.autonomyMode !== "AUTONOMOUS") {
    return { action, ok: false, error: "Modo sugestão: o flow só sai quando o agente responde sozinho." };
  }
  const allowed = ctx.config.allowedFlowIds ?? [];
  if (!allowed.includes(flowId)) return { action, ok: false, error: "Flow não liberado para este agente." };
  try {
    const { getPublishedFlowForSend } = await import("@/services/whatsapp-flow-definitions");
    const { getContactWhatsAppTargets } = await import("@/lib/contact-whatsapp-target");
    const flow = await getPublishedFlowForSend(flowId);
    if (!flow) return { action, ok: false, error: "Flow não encontrado ou ainda não publicado." };

    const conv = await prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      select: {
        organizationId: true,
        channel: true,
        contactId: true,
        channelRef: { select: { config: true, provider: true } },
      },
    });
    if (!conv) return { action, ok: false, error: "Conversation not found" };
    if (conv.channel !== "whatsapp") return { action, ok: false, error: "Flow só sai em conversa de WhatsApp." };
    if (conv.channelRef?.provider === "BAILEYS_MD") {
      return { action, ok: false, error: "Flow não sai em WhatsApp QR. Use um canal da API oficial." };
    }

    const channelConfig = (conv.channelRef?.config as Record<string, unknown> | null) ?? {};
    const metaClient = metaClientFromConfig(channelConfig);
    if (!metaClient.configured) return { action, ok: false, error: "Meta channel not configured" };

    const target = await getContactWhatsAppTargets(ctx.contactId);
    if (!target) return { action, ok: false, error: "Contact without phone" };

    const body = `Preencha o formulário: ${flow.name}`.slice(0, 1024);
    const flowCta = "Abrir formulário";
    const flowToken = randomUUID();
    const displayContent = `${body}\n[Flow: ${flowCta}]`;

    const saved = await prisma.message.create({
      data: withOrgFromCtx({
        conversationId: ctx.conversationId,
        content: displayContent,
        direction: "out",
        messageType: "interactive",
        senderName: "Agente IA",
        flowToken,
        aiAgentUserId: ctx.agentUserId,
      }),
    });

    let externalId: string | null = null;
    try {
      const res = await metaClient.sendInteractiveFlow(
        target.to,
        body,
        { flowId: flow.metaFlowId, flowCta, flowToken, flowAction: "navigate" },
        undefined,
        undefined,
        target.recipient,
      );
      externalId = res?.messages?.[0]?.id ?? null;
      if (externalId) {
        await prisma.message.update({ where: { id: saved.id }, data: { externalId, sendStatus: "sent" } }).catch(() => {});
      }
    } catch (err) {
      await prisma.message.update({ where: { id: saved.id }, data: { sendStatus: "failed" } }).catch(() => {});
      return { action, ok: false, error: err instanceof Error ? err.message : String(err), flowId };
    }

    const { publishNewMessage } = await import("@/lib/realtime-events");
    publishNewMessage({
      organizationId: conv.organizationId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      direction: "out",
      content: saved.content,
      timestamp: saved.createdAt,
    });
    return { action, ok: true, flowId, externalId };
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
    // Sem update da conversa neste caminho: grava só a ordem da lista.
    await touchConversationLastMessageAt({
      conversationId: ctx.conversationId,
      at: saved.createdAt,
    }).catch(() => {});
    const { publishNewMessage } = await import("@/lib/realtime-events");
    publishNewMessage({
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
  send_whatsapp_flow: executeSendWhatsappFlow,
  send_material_attachment: executeSendMaterialAttachment,
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
    maxTypingMs: V2_MAX_TYPING_MS,
  };
}

/**
 * Teto do "digitando…" no v2. A fórmula chegava a 25 s por mensagem e o
 * turno com resposta + mensagem pronta + fecho pagava três vezes.
 */
export const V2_MAX_TYPING_MS = 8000;


export { toWhatsAppText };

/** Envia mensagem de texto simples via sendAgentMessage. */
export async function sendV2TextMessage(args: {
  conversationId: string;
  contactId: string;
  agentUserId: string;
  text: string;
  channel?: string;
  autonomyMode: "AUTONOMOUS" | "DRAFT";
  humanBehavior?: HumanBehaviorConfig;
  /** Botões/lista; `text` é a versão com as opções numeradas. */
  interactive?: V2InteractivePayload | null;
  /** Quem chama já escolheu um texto que não repete o anterior (aviso de fila). */
  bypassDuplicateGuard?: boolean;
}): Promise<{ sent: boolean; reason?: string }> {
  if (!args.text.trim()) return { sent: false, reason: "empty" };
  const text = toWhatsAppText(args.text);
  const iv = args.interactive;
  const interactive = iv
    ? {
        ...iv,
        body: toWhatsAppText(iv.body),
        ...(iv.leadText ? { leadText: toWhatsAppText(iv.leadText) } : {}),
      }
    : undefined;
  const result = (await sendAgentMessage({
    conversationId: args.conversationId,
    contactId: args.contactId,
    agentUserId: args.agentUserId,
    autonomyMode: args.autonomyMode,
    text,
    channel: args.channel === "baileys" ? "baileys" : "meta",
    bypassAssigneeCheck: false,
    humanBehavior: args.humanBehavior ?? v2HumanBehavior({}),
    ...(interactive ? { interactive } : {}),
    ...(args.bypassDuplicateGuard ? { bypassDuplicateGuard: true } : {}),
  })) as { status?: string; reason?: string } | undefined;
  const preview = text.length > 90 ? `${text.slice(0, 90)}…` : text;
  if (result?.status === "skipped" && result.reason === "superseded") {
    traceStep("resposta", `Não enviada: o cliente mandou outra mensagem enquanto ele digitava — a próxima resposta cobre: "${preview}"`);
    return { sent: false, reason: "superseded" };
  }
  if (result?.status === "skipped") {
    // Antes o motor não sabia que o envio foi barrado — o turno parecia ter
    // respondido e o cliente não recebia nada.
    traceStep("resposta", `NÃO enviada (${result.reason ?? "motivo desconhecido"}): "${preview}"`);
    return { sent: false, reason: result.reason };
  }
  traceStep("resposta", `${result?.status === "draft" ? "Salva como rascunho (modo sugestão)" : "Enviada"}: "${preview}"`);
  return { sent: true };
}
