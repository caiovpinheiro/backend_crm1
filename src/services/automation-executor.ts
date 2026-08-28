import { randomUUID } from "node:crypto";
import {
  Prisma,
  type ActivityType,
  type Contact,
  type Deal,
  type DealStatus,
  type LifecycleStage,
} from "@prisma/client";

import { normalizeConditionConfig } from "@/lib/automation-condition";
import {
  runWithAutomationOrigin,
  type AutomationOrigin,
} from "@/lib/automation-origin";
import {
  normalizeRoundRobinConfig,
  roundRobinOptionsSignature,
} from "@/lib/automation-round-robin";
import { readStepAllowedChannelIds, triggerTypeLabel } from "@/lib/automation-workflow";
import { defaultDealTitleForContact } from "@/lib/display-name";
import { getLogger } from "@/lib/logger";
import {
  metaWhatsApp,
  metaClientFromConfig,
  formatMetaSendError,
  isMetaGraphError,
  type MetaWhatsAppClient,
} from "@/lib/meta-whatsapp/client";
import {
  renderTemplatePreview,
  templateVariablesFromSendComponents,
} from "@/lib/meta-whatsapp/build-template-components";
import {
  enrichTemplateComponentsForFlowSend,
  resolveTemplateHeaderMediaFormat,
} from "@/lib/meta-whatsapp/enrich-template-flow";
import {
  buildOutboundTemplateMessageContent,
  buttonLabelsFromConfig,
} from "@/lib/whatsapp-outbound-template-label";
import { isMetaFlowEnrichError } from "@/lib/meta-whatsapp/meta-flow-enrich-error";
import { toAbsolutePublicMediaUrl } from "@/lib/meta-whatsapp/to-absolute-public-media-url";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull, runWithActor } from "@/lib/request-context";
import { botOutboundReplyMark } from "@/lib/conversation-reply-marking";
import type { AutomationJobPayload } from "@/lib/queue";
import { assertSafeOutboundUrl } from "@/lib/safe-outbound-url";
import { sseBus } from "@/lib/sse-bus";
import {
  assignDealOwner,
  createDealEvent,
  markDealLost,
  markDealWon,
  nextDealNumber,
  propagateOwnerToContactAndChat,
} from "@/services/deals";
import { triggerAgentOpeningForContact } from "@/services/ai/piloting-actions";
import { fireTrigger, notifyDealStageChanged } from "@/services/automation-triggers";
import { updateContactScore } from "@/services/lead-scoring";
import { executeDistribution } from "@/services/distribution";
import { logEvent } from "@/services/activity-log";
import { tabulationLogMeta } from "@/services/tabulations";
import {
  createContext,
  advanceContext,
  closeStrandedContext,
  getActiveContext,
  interpolateVariables,
  markPausedTtl,
  pausedStepTimeoutMs,
  shouldPersistDelay,
  AWAITING_FLOW_VAR,
  readStepRef,
} from "@/services/automation-context";
import { getPublishedFlowForSend } from "@/services/whatsapp-flow-definitions";
import {
  ensureWhatsAppConversationForContact,
  maybeResolveUnansweredOutboundTicket,
} from "@/services/whatsapp-conversation";

const log = getLogger("automation");

/** Passos Meta com saída síncrona "Falha ao enviar" (`failureAction` / `failureGotoStepId`). */
const META_SEND_FAILURE_STEP_TYPES = new Set([
  "send_whatsapp_message",
  "send_whatsapp_template",
  "send_whatsapp_media",
  "send_whatsapp_interactive",
  "send_whatsapp_list",
  "send_whatsapp_flow",
  "question",
]);

/**
 * Falha classificada de tentativa de envio Meta.
 * Somente esta classe entra no fallback `failureGotoStepId`.
 * Erros internos inesperados continuam como `Error` genérico e abortam.
 */
export class MetaSendFailureError extends Error {
  readonly name = "MetaSendFailureError";
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

function isMetaSendFailureError(err: unknown): err is MetaSendFailureError {
  return err instanceof MetaSendFailureError;
}

/** Converte rejeição Graph / enrich / timeout / canal em falha classificada. */
function toMetaSendFailure(err: unknown): MetaSendFailureError {
  if (isMetaSendFailureError(err)) return err;
  return new MetaSendFailureError(formatMetaSendError(err), err);
}

/**
 * Classifica erros já lançados como falha de envio (Graph, enrich, timeout,
 * canal/destino, header/template recusado). Retorna null para erros internos.
 */
function metaGraphCodeOf(err: unknown): number | null {
  if (isMetaGraphError(err)) return err.code;
  if (isMetaSendFailureError(err)) return metaGraphCodeOf(err.cause);
  return null;
}

function formatOutboundChannelLabel(
  ch: { name: string | null; phoneNumber: string | null } | null,
): string {
  if (!ch) return "este WhatsApp";
  const name = ch.name?.trim() || "WhatsApp";
  const phone = ch.phoneNumber?.trim();
  return phone ? `${name} (${phone})` : name;
}

function classifyMetaSendFailure(err: unknown): MetaSendFailureError | null {
  if (isMetaSendFailureError(err)) return err;
  if (isMetaGraphError(err) || isMetaFlowEnrichError(err)) return toMetaSendFailure(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /nenhum canal META_CLOUD_API/i.test(msg) ||
    /sem destino/i.test(msg) ||
    /telefone inválido/i.test(msg) ||
    /Tempo limite ao comunicar com a Meta/i.test(msg) ||
    /headerMediaUrl inválida/i.test(msg) ||
    /exige header\b/i.test(msg) ||
    /arquivo do header não encontrado/i.test(msg) ||
    /arquivo nao encontrado em storage/i.test(msg) ||
    /toAbsolutePublicMediaUrl:/i.test(msg) ||
    /^Meta WhatsApp:/i.test(msg)
  ) {
    return toMetaSendFailure(err);
  }
  return null;
}

/** Destino do fallback síncrono; `null` = stop (comportamento legado). */
function resolveFailureGotoStepId(cfg: Record<string, unknown>): string | null {
  const action = typeof cfg.failureAction === "string" ? cfg.failureAction : "stop";
  if (action !== "goto") return null;
  const id =
    typeof cfg.failureGotoStepId === "string" ? cfg.failureGotoStepId.trim() : "";
  if (!id || id === "__none__") return null;
  return id;
}

/** Aresta "Sem resposta" desenhada no canvas (`timeoutGotoStepId`). */
function resolveTimeoutGotoStepId(cfg: Record<string, unknown>): string | null {
  const id =
    typeof cfg.timeoutGotoStepId === "string" ? cfg.timeoutGotoStepId.trim() : "";
  if (!id || id === "__none__") return null;
  return id;
}

/** Aresta "Enviado" / saída padrão (`nextStepId`). */
function resolveNextStepId(cfg: Record<string, unknown>): string | null {
  const id = typeof cfg.nextStepId === "string" ? cfg.nextStepId.trim() : "";
  if (!id || id === "__none__") return null;
  return id;
}

/**
 * Pausa pós-envio só faz sentido se "Sem resposta" leva a um destino
 * diferente de "Enviado". Quando as duas arestas apontam pro mesmo
 * passo (ex.: Finalizar), esperar resposta só prende o contexto em
 * RODANDO sem mudar o resultado — segue imediatamente.
 */
function shouldPauseAfterSendForTimeout(cfg: Record<string, unknown>): boolean {
  const timeoutGoto = resolveTimeoutGotoStepId(cfg);
  if (!timeoutGoto) return false;
  const nextGoto = resolveNextStepId(cfg);
  return !nextGoto || nextGoto !== timeoutGoto;
}

const DEFAULT_WAIT_TIMEOUT_MS = 86_400_000;

/**
 * Pausa o fluxo no step atual aguardando resposta (ou timeout).
 * Usado por message/template quando a aresta "Sem resposta" está conectada,
 * e por template com botões roteados.
 */
async function pauseAwaitingReply(
  cfg: Record<string, unknown>,
  rt: ChannelBindSource & { automationId: string; contactId?: string | null },
  timeoutMs: number | undefined,
): Promise<StepResult> {
  const stepId = cfg.__stepId as string | undefined;
  if (stepId && rt.contactId) {
    await persistPausedContext(rt, stepId, timeoutMs);
  }
  return { skipRemaining: true };
}

/** Persiste tentativa falha no inbox + marca conversa com erro. */
async function persistFailedAutomationOutbound(opts: {
  conversationId: string | undefined | null;
  content: string;
  messageType: string;
  senderName: string;
  triggeredByName?: string | null;
  error: unknown;
  mediaUrl?: string | null;
  /** Canal (WhatsApp/e-mail) resolvido para este envio — ver `resolveOutboundChannelId`. */
  channelId?: string | null;
}): Promise<void> {
  if (!opts.conversationId) return;
  const sendError = formatMetaSendError(opts.error).slice(0, 500);
  await prisma.message
    .create({
      data: withOrgFromCtx({
        conversationId: opts.conversationId,
        content: opts.content,
        direction: "out",
        messageType: opts.messageType,
        senderName: opts.senderName,
        authorType: "bot",
        ...(opts.triggeredByName ? { triggeredByName: opts.triggeredByName } : {}),
        sendStatus: "failed",
        sendError,
        ...(opts.mediaUrl ? { mediaUrl: opts.mediaUrl } : {}),
        ...(opts.channelId ? { channelId: opts.channelId } : {}),
      }),
    })
    .catch((e) => log.warn("Falha ao persistir mensagem de erro:", e));

  const { markConversationHasError } = await import(
    "@/services/conversation-error-flag"
  );
  await markConversationHasError(opts.conversationId);
}

/**
 * Janela máxima de espera pelo veredito de entrega da Meta, e intervalo de
 * consulta. Configuráveis por env para ajuste em produção sem redeploy de
 * código (`AUTOMATION_META_DELIVERY_WAIT_MS`).
 */
const META_DELIVERY_WAIT_MS = Math.max(
  0,
  Number(process.env.AUTOMATION_META_DELIVERY_WAIT_MS ?? 15_000),
);
const META_DELIVERY_POLL_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A Meta pode aceitar o envio (devolve wamid) e só depois reportar falha pelo
 * webhook — cód. 131042 (conta sem método de pagamento), número bloqueado,
 * etc. Sem esperar esse veredito, o passo retornaria sucesso e o fluxo seguiria
 * pelo ramo "Enviado" mesmo com a mensagem não entregue.
 *
 * Roda apenas quando o nó tem a saída "Falha ao enviar" conectada: quem não
 * configurou o desvio não paga a espera. Encerra no primeiro status terminal;
 * a janela é só o teto para quando nenhum status chega.
 *
 * Lança `MetaSendFailureError` no veredito `failed` — o `catch` do loop de
 * execução cuida do desvio. NÃO persiste mensagem de erro: o webhook já gravou
 * `sendError` na mensagem original e marcou a conversa com `hasError`.
 */
async function awaitMetaDeliveryVerdict(
  messageId: string,
  label: string,
): Promise<void> {
  if (META_DELIVERY_WAIT_MS <= 0) return;
  const deadline = Date.now() + META_DELIVERY_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(META_DELIVERY_POLL_MS);
    const row = await prisma.message
      .findUnique({
        where: { id: messageId },
        select: { sendStatus: true, sendError: true },
      })
      .catch(() => null);
    if (!row) return;
    const status = (row.sendStatus ?? "").toLowerCase();
    if (status === "failed") {
      throw new MetaSendFailureError(
        row.sendError?.trim() || "Falha no envio reportada pela Meta",
      );
    }
    // `sent` NÃO encerra a espera: é o default do schema, gravado na criação
    // da mensagem, e o webhook nem chega a reescrevê-lo (mesma prioridade).
    // Sair nele faria a espera terminar sempre no primeiro poll. Confirmação
    // real de entrega é `delivered`/`read`.
    if (status === "delivered" || status === "read") return;
  }
  log.info(
    `${label}: sem confirmação da Meta em ${META_DELIVERY_WAIT_MS}ms — seguindo pelo caminho de sucesso`,
  );
}

/**
 * Resolve a conversa WhatsApp de DESTINO para um envio de automação (robô).
 *
 * Modelo de ticket (decisão do operador 17/jul/26): quando o robô envia uma
 * mensagem e a última conversa do contato está ENCERRADA (RESOLVED), a
 * conversa é REABERTA como um NOVO ticket (#N+1) — assim o card nunca fica
 * "resolvido com robô ativo". `ensureWhatsAppConversationForContact` já faz
 * isso: reusa a conversa não-RESOLVED ou cria um ticket novo (com tratamento
 * de corrida e disparo de `conversation_created`).
 *
 * Em `campaign_trigger`, o ticket novo NÃO herda `contact.assignedToId` —
 * senão a aba Entrada enche com disparos em massa (assignee HUMAN +
 * hasHumanReply=false ignora o filtro de contexto RUNNING).
 *
 * Retorna `{ id } | null` de propósito, para manter compatível o uso
 * downstream (`conv?.id`, `conv.id`, `if (conv)`) dos sites de envio.
 * Fallback best-effort (sem canal/telefone): usa a conversa mais recente,
 * preservando o comportamento antigo.
 */
async function resolveAutomationSendConv(
  contactId: string | null | undefined,
  opts?: {
    inheritAssignee?: boolean;
    conversationId?: string | null;
    channelId?: string | null;
  },
): Promise<{ id: string } | null> {
  if (!contactId) return null;
  const preferredId =
    typeof opts?.conversationId === "string" ? opts.conversationId.trim() : "";
  if (preferredId) {
    const pinned = await prisma.conversation.findFirst({
      where: { id: preferredId, contactId },
      select: { id: true },
    });
    if (pinned) return { id: pinned.id };
  }
  try {
    const ensured = await ensureWhatsAppConversationForContact(contactId, {
      inheritAssignee: opts?.inheritAssignee,
      channelId: opts?.channelId,
    });
    if ("conversationId" in ensured) return { id: ensured.conversationId };
  } catch (err) {
    log.warn(`resolveAutomationSendConv: ensure falhou p/ contato ${contactId}:`, err);
  }
  // Fallback: só chega aqui quando o `ensure` acima NÃO resolveu (contato sem
  // telefone/BSUID, org sem canal Meta CONNECTED — caso Baileys —, ou erro).
  // Preferir o ticket ATIVO evita gravar o outbound num ticket encerrado
  // enquanto a resposta do cliente entra no aberto (outbound e inbound em
  // tickets diferentes: o envio some da timeline do ticket que o cliente usa).
  const active = await prisma.conversation.findFirst({
    where: { contactId, channel: "whatsapp", status: { not: "RESOLVED" } },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  if (active) return { id: active.id };
  // Sem ticket ativo, usa o encerrado mais recente em vez de abortar: deixar
  // de enviar a mensagem é pior que o split de ticket que estamos corrigindo.
  const resolved = await prisma.conversation.findFirst({
    where: { contactId, channel: "whatsapp" },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  if (resolved) {
    log.warn(
      `resolveAutomationSendConv: contato ${contactId} sem conversa ativa; ` +
        `gravando envio na conversa encerrada ${resolved.id}`,
    );
    return { id: resolved.id };
  }
  return null;
}

/** Campanha AUTOMATION: não herdar dono do contato no ticket novo (ver ensure opts). */
function sendConvOptsForRuntime(rt: { event?: string | null }): {
  inheritAssignee?: boolean;
} {
  return rt.event === "campaign_trigger" ? { inheritAssignee: false } : {};
}

/**
 * Melhor esforço para herdar o canal ativo através de uma pausa
 * (question/wait_for_reply): `continueFromStep` monta um `RuntimeContext`
 * novo, sem o `activeChannelId` acumulado na execução original. Como o
 * canal de cada envio fica gravado em `Message.channelId`, recuperamos o
 * último aqui — mesma fonte que já alimenta o "via {canal}" do inbox.
 */
async function loadLastAutomationChannelId(
  contactId: string,
  opts?: { conversationId?: string | null; channelId?: string | null },
): Promise<string | null> {
  const explicit = opts?.channelId?.trim();
  if (explicit) return explicit;

  const preferredId = opts?.conversationId?.trim();
  const conv = preferredId
    ? await prisma.conversation.findFirst({
        where: { id: preferredId, contactId },
        select: { id: true, channelId: true },
      })
    : await prisma.conversation.findFirst({
        where: { contactId, channel: "whatsapp" },
        orderBy: { updatedAt: "desc" },
        select: { id: true, channelId: true },
      });
  if (!conv) return null;
  // Canal do ticket (último inbound) — não o último outbound, que pode
  // ter sido um disparo antigo em outra conexão da mesma conversa.
  if (conv.channelId) return conv.channelId;
  const lastMsg = await prisma.message.findFirst({
    where: { conversationId: conv.id, direction: "out", channelId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { channelId: true },
  });
  return lastMsg?.channelId ?? null;
}

/**
 * Quem assina o outbound da automação no inbox.
 * - `bot` (padrão): authorType bot — não marca hasHumanReply (fica em Entrada).
 * - `assignee`: se a conversa tem consultor HUMAN, grava como resposta dele
 *   (hasHumanReply=true → Respondidas). Sem responsável humano → fallback bot.
 */
async function resolveOutboundAuthor(
  conversationId: string | undefined,
  sendAsRaw: string | undefined,
  fallbackSenderName: string,
): Promise<{
  authorType: "bot" | "human";
  senderName: string;
  asHuman: boolean;
}> {
  const sendAs = sendAsRaw === "assignee" ? "assignee" : "bot";
  if (sendAs !== "assignee" || !conversationId) {
    return { authorType: "bot", senderName: fallbackSenderName, asHuman: false };
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      assignedTo: { select: { id: true, name: true, type: true } },
    },
  });
  const assignee = conv?.assignedTo;
  if (assignee?.type === "HUMAN" && assignee.id) {
    return {
      authorType: "human",
      senderName: assignee.name?.trim() || fallbackSenderName,
      asHuman: true,
    };
  }

  log.warn(
    `sendAs=assignee sem consultor humano na conversa ${conversationId} — fallback bot`,
  );
  return { authorType: "bot", senderName: fallbackSenderName, asHuman: false };
}

/** Tabulação já resolvida/validada, pronta pra gravar. */
type ResolvedTabulation = {
  tabulationId: string;
  ancestorIds: string[];
  departmentId: string;
  name: string;
  number: number;
};

/**
 * Loga `CONVERSATION_TABULATED` — a fonte do dashboard de motivos de
 * encerramento. `departmentId` é o da própria tabulação (não o da conversa),
 * pra o registro cair na árvore a que a opção pertence mesmo quando a conversa
 * está sem departamento.
 */
function logTabulated(
  conv: { id: string; externalId: string | null },
  contactId: string,
  tab: Omit<ResolvedTabulation, "departmentId"> & {
    departmentId: string | null;
  },
  extraMeta: Record<string, unknown>,
): void {
  void logEvent({
    type: "CONVERSATION_TABULATED",
    entityType: "CONVERSATION",
    entityId: conv.id,
    entityLabel: conv.externalId ?? null,
    conversationId: conv.id,
    contactId,
    meta: tabulationLogMeta(tab, { source: "automation", ...extraMeta }),
  });
}

/**
 * Encerra as conversas abertas do contato. Compartilhado por
 * `finish_conversation` e por `tabulate_conversation` com encerramento junto —
 * neste caso a tabulação escolhida no passo entra na MESMA operação do
 * fechamento, o que importa porque encerrar limpa o departamento da conversa
 * (salvo `conversation.keepDepartmentOnEnd`).
 *
 * Sem `chosen`, mantém o comportamento antigo: cai na tabulação de
 * encerramento automático do departamento, se houver.
 */
async function finishConversationsForContact(
  rt: RuntimeContext,
  chosen?: ResolvedTabulation | null,
): Promise<void> {
  if (!rt.contactId) return;
  const { getOrgSettingBool } = await import("@/lib/org-settings");
  const { updateConversationStatusInDb } = await import("@/services/conversations");

  const [keepAgent, keepDepartment] = await Promise.all([
    getOrgSettingBool("conversation.keepAgentOnEnd", false),
    getOrgSettingBool("conversation.keepDepartmentOnEnd", false),
  ]);
  const clearAssignedTo = !keepAgent;
  const clearDepartment = !keepDepartment;

  const convs = await prisma.conversation.findMany({
    where: { contactId: rt.contactId, status: { not: "RESOLVED" } },
    select: {
      id: true,
      status: true,
      externalId: true,
      organizationId: true,
      departmentId: true,
    },
  });

  const orgId = getOrgIdOrNull();
  const { resolveAutoCloseTabulation } = await import("@/services/tabulations");
  for (const c of convs) {
    const rowOrg = c.organizationId ?? orgId;
    // A escolha do passo vence a tabulação padrão do departamento. Ausentes as
    // duas => encerra sem tabular (comportamento anterior).
    const autoTab =
      chosen ??
      (rowOrg
        ? await resolveAutoCloseTabulation({
            organizationId: rowOrg,
            departmentId: c.departmentId,
          }).catch(() => null)
        : null);

    const updated = await updateConversationStatusInDb(c.id, "RESOLVED", {
      ...(autoTab ? { tabulationId: autoTab.tabulationId } : {}),
      clearAssignedTo,
      clearDepartment,
    });

    if (autoTab) {
      logTabulated(
        c,
        rt.contactId,
        {
          tabulationId: autoTab.tabulationId,
          ancestorIds: autoTab.ancestorIds,
          name: autoTab.name,
          number: autoTab.number,
          // Sem escolha explícita, `autoTab` veio da árvore do próprio
          // departamento da conversa — os dois valores coincidem.
          departmentId: chosen ? chosen.departmentId : c.departmentId,
        },
        chosen ? { step: "tabulate_conversation" } : { auto: true },
      );
    }

    void logEvent({
      type: "CONVERSATION_CLOSED",
      entityType: "CONVERSATION",
      entityId: c.id,
      entityLabel: c.externalId ?? null,
      conversationId: c.id,
      contactId: rt.contactId,
      field: "status",
      oldValue: c.status,
      newValue: updated.status,
      meta: { from: c.status, to: "RESOLVED", source: "automation" },
    });

    try {
      if (rowOrg) {
        sseBus.publish("conversation_updated", {
          organizationId: rowOrg,
          conversationId: c.id,
          contactId: rt.contactId,
          status: "RESOLVED",
        });
        sseBus.publish("conversation_timeline_updated", {
          organizationId: rowOrg,
          conversationId: c.id,
          type: "CONVERSATION_CLOSED",
        });
      }
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Resolve o cliente Meta WhatsApp correto para uma automação multi-tenant.
 *
 * Estrategia:
 *   1. Se ja temos um `conversationId`, puxa `channelRef.config` da
 *      conversa — este eh o caminho preferencial pq garante 100% que o
 *      envio sai pelo canal certo da org corrente.
 *   2. Caso contrario (sem conv pra esse contato), procura o primeiro
 *      canal META_CLOUD_API ativo da org (via getOrgIdOrNull) — fallback
 *      pra triggers que disparam ANTES de existir conversa.
 *   3. Como ultimo recurso, usa o singleton global `metaWhatsApp` (env).
 *      Isso so deveria acontecer em ambientes legados sem canal cadastrado;
 *      logamos um warning para detectar.
 *
 * Antes (24/abr/26) o executor SEMPRE usava o singleton — automacoes da
 * org B saiam pelo numero da Eduit (env vars de uma org especifica). Bug
 * critico de multi-tenancy fixado aqui junto com o resto da Fase 1.
 */
async function resolveAutomationMetaClient(opts: {
  automationId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  /** Quando o passo escolhe um canal Cloud API explícito (ex.: template por WABA). */
  channelId?: string | null;
}): Promise<MetaWhatsAppClient> {
  let resolvedOrgId: string | null = null;

  const preferredChannelId =
    typeof opts.channelId === "string" ? opts.channelId.trim() : "";
  if (preferredChannelId) {
    const preferred = await prisma.channel.findFirst({
      where: {
        id: preferredChannelId,
        provider: "META_CLOUD_API",
      },
      select: { config: true, organizationId: true },
    });
    if (preferred?.config) {
      resolvedOrgId = preferred.organizationId;
      const client = metaClientFromConfig(
        preferred.config as Record<string, unknown>,
      );
      if (client.configured) return client;
    }
  }

  if (opts.conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: opts.conversationId },
      select: {
        organizationId: true,
        channelRef: { select: { config: true, provider: true } },
      },
    });
    resolvedOrgId = conv?.organizationId ?? null;
    const provider = conv?.channelRef?.provider;
    if (provider === "META_CLOUD_API") {
      const cfg = conv?.channelRef?.config as
        | Record<string, unknown>
        | null
        | undefined;
      const client = metaClientFromConfig(cfg);
      if (client.configured) return client;
    }
  }

  // Ordem de resolução do tenant quando não há RequestContext:
  // 1) ALS atual (rotas HTTP)
  // 2) deal -> org
  // 3) contact -> org
  // 4) automation -> org
  if (!resolvedOrgId) {
    resolvedOrgId = getOrgIdOrNull();
  }
  if (!resolvedOrgId && opts.dealId) {
    const deal = await prisma.deal.findUnique({
      where: { id: opts.dealId },
      select: { organizationId: true },
    });
    resolvedOrgId = deal?.organizationId ?? null;
  }
  if (!resolvedOrgId && opts.contactId) {
    const contact = await prisma.contact.findUnique({
      where: { id: opts.contactId },
      select: { organizationId: true },
    });
    resolvedOrgId = contact?.organizationId ?? null;
  }
  if (!resolvedOrgId && opts.automationId) {
    const automation = await prisma.automation.findUnique({
      where: { id: opts.automationId },
      select: { organizationId: true },
    });
    resolvedOrgId = automation?.organizationId ?? null;
  }

  if (resolvedOrgId) {
    const channel = await prisma.channel.findFirst({
      where: {
        organizationId: resolvedOrgId,
        provider: "META_CLOUD_API",
        status: "CONNECTED",
      },
      select: { config: true },
      orderBy: { createdAt: "asc" },
    });
    if (channel?.config) {
      const client = metaClientFromConfig(
        channel.config as Record<string, unknown>,
      );
      if (client.configured) return client;
    }
  }

  log.warn(
    `Nenhum canal META_CLOUD_API encontrado (automation=${opts.automationId ?? "—"}, conv=${opts.conversationId ?? "—"}, org=${resolvedOrgId ?? "—"}) — caindo para singleton (env vars). MULTI-TENANCY EM RISCO!`,
  );
  return metaWhatsApp;
}

/**
 * Gatilhos em que o envio deve sair pelo mesmo número do inbound.
 * `config.channelId` do 1º passo (obrigatório na UI com 2+ canais) NÃO
 * pode sobrescrever — senão a Meta devolve 131047 na sessão do outro número.
 */
const INBOUND_BOUND_EVENTS = new Set([
  "message_received",
  "message_sent",
  "continue",
]);

type ChannelBindSource = {
  event?: string | null;
  data?: Record<string, unknown>;
  conversation?: { id?: string; channelId?: string | null } | null;
  activeChannelId?: string | null;
};

function resolveBoundChannelId(rt: ChannelBindSource): string | null {
  const data = rt.data ?? {};
  const fromData = readString(data, "channelId")?.trim();
  if (fromData) return fromData;
  const fromConv = rt.conversation?.channelId?.trim();
  if (fromConv) return fromConv;
  const fromActive = rt.activeChannelId?.trim();
  return fromActive || null;
}

function channelBindVars(rt: ChannelBindSource): Record<string, unknown> {
  const data = rt.data ?? {};
  const channelId = resolveBoundChannelId(rt);
  const conversationId =
    readString(data, "conversationId")?.trim() || rt.conversation?.id || "";
  return {
    ...(channelId ? { channelId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

async function persistPausedContext(
  rt: ChannelBindSource & { automationId: string; contactId?: string | null },
  stepId: string,
  timeoutMs: number | undefined,
  extraVars?: Record<string, unknown>,
): Promise<void> {
  if (!rt.contactId) return;
  const existingCtx = await getActiveContext(rt.automationId, rt.contactId);
  // Sem `timeoutMs` do canvas o contexto ficava RUNNING pra sempre (o sweeper
  // só varre `timeoutAt` preenchido), travando o re-disparo da automação e o
  // 1º atendimento da IA. `pausedStepTimeoutMs` arma o TTL de segurança e o
  // marcador diz ao `processTimeout` para apenas encerrar, sem seguir ramo.
  const effectiveTimeoutMs = pausedStepTimeoutMs(timeoutMs);
  const vars = markPausedTtl(
    {
      ...((existingCtx?.variables as Record<string, unknown>) ?? {}),
      ...channelBindVars(rt),
      ...(extraVars ?? {}),
    },
    stepId,
    timeoutMs,
  );
  if (existingCtx) {
    await advanceContext(existingCtx.id, stepId, vars, effectiveTimeoutMs);
  } else {
    await createContext(
      rt.automationId,
      rt.contactId,
      stepId,
      effectiveTimeoutMs,
      vars,
    );
  }
}

function sendConvOptsFromRt(
  rt: RuntimeContext,
  channelId?: string | null,
): {
  inheritAssignee?: boolean;
  conversationId?: string | null;
  channelId?: string | null;
} {
  return {
    ...sendConvOptsForRuntime(rt),
    conversationId:
      rt.conversation?.id ?? readString(rt.data, "conversationId") ?? null,
    channelId: channelId ?? resolveBoundChannelId(rt),
  };
}

/**
 * Resolve o canal usado num passo de envio.
 *
 * Em gatilho de inbound (`message_received` etc.) o canal da conversa
 * ganha de `config.channelId` do passo — o picker do 1º passo era
 * obrigatório e gerava envio no número errado (sessão 24h fechada).
 * Campanha / stage_changed / demais: passo explícito, depois o canal
 * herdado do payload (`rt.activeChannelId` / conversa).
 */
function resolveOutboundChannelId(
  cfg: Record<string, unknown>,
  rt: RuntimeContext,
): string | null {
  const cfgChannelId = readString(cfg, "channelId")?.trim() || null;
  const bound = resolveBoundChannelId(rt);
  const allowed = readStepAllowedChannelIds(cfg);
  if (rt.event && INBOUND_BOUND_EVENTS.has(rt.event) && bound) {
    if (allowed && !allowed.includes(bound)) {
      throw new MetaSendFailureError(
        "Canal da conversa não está entre os canais selecionados neste passo.",
      );
    }
    if (cfgChannelId && cfgChannelId !== bound) {
      log.info(
        `Envio no canal da conversa ${bound} (passo pedia ${cfgChannelId}; event=${rt.event})`,
      );
    }
    return bound;
  }
  if (allowed?.length === 1) return allowed[0] ?? null;
  if (allowed && allowed.length > 1) {
    if (bound && allowed.includes(bound)) return bound;
    return allowed[0] ?? null;
  }
  return cfgChannelId || bound || null;
}

const ACTIVITY_TYPES: ActivityType[] = ["CALL", "EMAIL", "MEETING", "TASK", "NOTE", "WHATSAPP", "OTHER"];
const LIFECYCLE_STAGES: LifecycleStage[] = ["SUBSCRIBER", "LEAD", "MQL", "SQL", "OPPORTUNITY", "CUSTOMER", "EVANGELIST", "OTHER"];

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Injeta o componente `header` de mídia (IMAGE/VIDEO/DOCUMENT) exigido pela
 * Meta ao enviar templates cujo HEADER não é texto (erro `132012: header
 * component parameter should not be empty` quando o parâmetro falta).
 *
 * Fluxo (opção "link" + fallback id para uploads internos):
 *  1. Descobre o `headerFormat` na Graph (fonte da verdade); `headerMediaType`
 *     do passo só entra se a Graph não responder.
 *  2. Se não for mídia (TEXT/NONE/null), não faz nada — comportamento atual.
 *  3. Se for mídia, exige `headerMediaUrl` (falha cedo, antes de chamar a Meta).
 *  4. URL HTTPS pública → `{ link }`. Upload interno (`/api/storage/...` ou
 *     `/uploads/...`) → sobe o arquivo na Meta e usa `{ id }` (storage exige
 *     sessão; a Meta não consegue baixar o link).
 *  5. Monta `{ type: "header", parameters: [...] }`, substituindo qualquer
 *     header já presente em `components` (nunca duplica).
 */
async function injectTemplateHeaderMediaComponent(
  client: MetaWhatsAppClient,
  args: {
    templateName: string;
    languageCode: string;
    templateGraphId: string | null;
    components: unknown[] | undefined;
    headerMediaUrl: string | null;
    headerMediaType: "image" | "video" | "document" | null;
  },
): Promise<unknown[] | undefined> {
  const fromGraph = await resolveTemplateHeaderMediaFormat(client, {
    templateName: args.templateName,
    languageCode: args.languageCode,
    templateGraphId: args.templateGraphId,
  });
  const headerFormat = fromGraph ?? args.headerMediaType?.toUpperCase() ?? null;

  if (headerFormat !== "IMAGE" && headerFormat !== "VIDEO" && headerFormat !== "DOCUMENT") {
    return args.components;
  }

  if (!args.headerMediaUrl) {
    throw new Error(
      `send_whatsapp_template: template "${args.templateName}" exige header ${headerFormat}; configure headerMediaUrl no passo.`,
    );
  }

  const mediaType = headerFormat.toLowerCase() as "image" | "video" | "document";
  const mediaParam = await resolveTemplateHeaderMediaParam(client, args.headerMediaUrl, mediaType);
  const headerComponent: Record<string, unknown> = {
    type: "header",
    parameters: [{ type: mediaType, [mediaType]: mediaParam }],
  };

  const withoutExistingHeader = (args.components ?? []).filter((c) => {
    const o = asRecord(c);
    return String(o?.type ?? "").toLowerCase() !== "header";
  });

  return [headerComponent, ...withoutExistingHeader];
}

/** Resolve `{ link }` (URL pública) ou `{ id }` (upload interno → Meta media). */
async function resolveTemplateHeaderMediaParam(
  client: MetaWhatsAppClient,
  mediaUrl: string,
  mediaType: "image" | "video" | "document",
): Promise<{ link: string } | { id: string }> {
  const trimmed = mediaUrl.trim();
  const { parseStoragePath, readStoredFile, mimeFromFilename } = await import(
    "@/lib/storage/local"
  );
  const parsedStorage = parseStoragePath(trimmed);
  const isLegacyLocal = !parsedStorage && trimmed.startsWith("/uploads/");

  if (parsedStorage || isLegacyLocal) {
    let buffer: Buffer;
    let resolvedFileName: string;
    let mimeType: string;

    if (parsedStorage) {
      const stored = await readStoredFile(
        parsedStorage.orgId,
        parsedStorage.bucket,
        parsedStorage.fileName,
      );
      if (!stored) {
        throw new MetaSendFailureError(
          `send_whatsapp_template: arquivo do header não encontrado em storage (${trimmed})`,
        );
      }
      buffer = stored.buffer;
      mimeType = stored.mimeType;
      resolvedFileName = parsedStorage.fileName;
    } else {
      const { readFile } = await import("fs/promises");
      const { join, basename } = await import("path");
      const filePath = join(process.cwd(), "public", trimmed);
      try {
        buffer = await readFile(filePath);
      } catch (fsErr) {
        const code =
          fsErr && typeof fsErr === "object" && "code" in fsErr
            ? String((fsErr as { code: unknown }).code)
            : "";
        if (code === "ENOENT") {
          throw new MetaSendFailureError(
            `send_whatsapp_template: arquivo do header não encontrado em storage (${trimmed})`,
          );
        }
        throw fsErr;
      }
      resolvedFileName = basename(trimmed);
      mimeType = mimeFromFilename(resolvedFileName);
    }

    const metaMediaId = await client.uploadMedia(buffer, mimeType, resolvedFileName);
    return { id: metaMediaId };
  }

  // URL pública HTTPS — opção 1 pura. Relativa sem storage: expandir base.
  if (trimmed.startsWith("https://") || trimmed.startsWith("/")) {
    return { link: toAbsolutePublicMediaUrl(trimmed) };
  }

  throw new MetaSendFailureError(
    `send_whatsapp_template: headerMediaUrl inválida para ${mediaType} (use HTTPS público ou upload interno): ${trimmed}`,
  );
}

// ─────────────────────────────────────────────────────────────────
// Webhook — interpolação de variáveis dotted-path no body/headers
//
// O step `webhook` aceita um `body` (string JSON) e `headers` custom com
// tokens `{{caminho.pontilhado}}` (ex.: `{{contact.name}}`,
// `{{contact.adCtwaClid}}`, `{{deal.id}}`, `{{event}}`, `{{timestamp}}`).
// Resolvemos cada token contra um root montado a partir do RuntimeContext
// e substituímos pelo valor escapado para JSON (sem aspas externas — o
// template já as fornece em `"{{...}}"`). Token ausente vira string vazia.
//
// Backward-compat: se `body` não for configurado, mantemos o payload
// legado `{ event, contactId, dealId, data }`.
// ─────────────────────────────────────────────────────────────────

function resolveDottedPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function webhookValueToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function jsonEscapeFragment(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

const WEBHOOK_TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

function interpolateWebhookString(template: string, root: Record<string, unknown>): string {
  return template.replace(WEBHOOK_TOKEN_RE, (_m, path: string) => {
    const val = resolveDottedPath(root, path);
    return jsonEscapeFragment(webhookValueToString(val));
  });
}

function buildWebhookRoot(rt: RuntimeContext): Record<string, unknown> {
  // 03/jun/26 — root expandido pra cobrir o que o construtor visual de
  // body do step `webhook` lista no catálogo (ver
  // `automation-webhook-variables.ts` no front). Antes só tinha
  // `contact`/`deal`/`event`/`data`, então tokens como `{{contactTagNames}}`,
  // `{{conversation.id}}` e `{{contactCustomFields.<nome>}}` apareciam na
  // UI mas resolviam pra string vazia. Mantemos os campos existentes
  // intactos pra não quebrar bodies salvos.
  return {
    event: rt.event,
    automationId: rt.automationId,
    timestamp: new Date().toISOString(),
    contactId: rt.contactId ?? null,
    dealId: rt.dealId ?? null,
    contact: rt.contact ?? null,
    deal: rt.deal ?? null,
    conversation: rt.conversation ?? null,
    data: rt.data ?? {},
    contactTagIds: rt.contactTagIds ?? [],
    contactTagNames: rt.contactTagNames ?? [],
    dealTagIds: rt.dealTagIds ?? [],
    dealTagNames: rt.dealTagNames ?? [],
    contactCustomFields: rt.contactCustomFields ?? {},
    dealCustomFields: rt.dealCustomFields ?? {},
  };
}

/**
 * Interpola tokens `{{...}}` de uma MENSAGEM de texto livre enviada ao
 * cliente (send_whatsapp_message, question, interactive).
 *
 * Diferente do `interpolateVariables` legado (que só aceita chaves planas
 * `[a-zA-Z0-9_]+` e mantém o literal `{{x}}` quando a variável não existe),
 * aqui usamos o MESMO root do Webhook (`buildWebhookRoot`) + as flow
 * variables, resolvendo caminhos com ponto (`contact.name`,
 * `contactCustomFields.cpf`, `conversation.id`, ...). Assim o atalho `[`
 * lista exatamente os mesmos campos do Webhook. Token ausente vira string
 * VAZIA — comportamento pedido pelo operador: "se o cliente não tem o
 * campo, envia vazio". Suporta o filtro `|first_name`.
 */
function interpolateContextVariables(
  template: string,
  rt: RuntimeContext,
  flowVars: Record<string, unknown> | undefined,
): string {
  const root: Record<string, unknown> = {
    ...buildWebhookRoot(rt),
    ...(flowVars ?? {}),
  };
  return template.replace(
    /\{\{\s*([\w.]+)(?:\s*\|\s*([a-zA-Z0-9_]+))?\s*\}\}/g,
    (_m, path: string, transform?: string) => {
      const value = webhookValueToString(resolveDottedPath(root, path));
      if (!transform) return value;
      const t = transform.trim().toLowerCase();
      if (t === "first" || t === "first_name" || t === "primeiro_nome") {
        return value.trim().split(/\s+/)[0] ?? "";
      }
      return value;
    },
  );
}

/**
 * Responsável da conversa atual — sem fallback para dono do negócio.
 * Se o runtime já tem snapshot, usa `assignedToId` dele (null = sem dono).
 * Sem snapshot (gatilho de deal/contato), busca a conversa aberta mais recente.
 */
async function resolveConversationAssigneeId(
  rt: RuntimeContext,
): Promise<string | null> {
  if (rt.conversation) return rt.conversation.assignedToId ?? null;
  if (!rt.contactId) return null;
  const conv = await prisma.conversation.findFirst({
    where: {
      contactId: rt.contactId,
      status: { not: "RESOLVED" },
      assignedToId: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    select: { assignedToId: true },
  });
  return conv?.assignedToId ?? null;
}

/**
 * Responsável do lead para os tokens `{{assignee.*}}` / `{{responsavel.*}}`.
 * Prioridade: consultor da conversa (quem está atendendo) → dono do negócio.
 * Sem responsável, os tokens resolvem para string vazia como qualquer outro.
 */
async function resolveLeadAssigneeVars(
  rt: RuntimeContext,
): Promise<Record<string, unknown>> {
  let userId = rt.conversation?.assignedToId ?? null;

  // Gatilhos de deal/contato não carregam snapshot de conversa — busca a
  // conversa aberta mais recente do contato antes de cair no dono do deal.
  if (!userId && rt.contactId) {
    const conv = await prisma.conversation.findFirst({
      where: {
        contactId: rt.contactId,
        status: { not: "RESOLVED" },
        assignedToId: { not: null },
      },
      orderBy: { updatedAt: "desc" },
      select: { assignedToId: true },
    });
    userId = conv?.assignedToId ?? null;
  }
  if (!userId) userId = rt.deal?.ownerId ?? null;
  if (!userId) return {};

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });
  if (!user) return {};

  const name = user.name?.trim() ?? "";
  const firstName = name.split(/\s+/)[0] ?? "";
  return {
    assignee: { id: user.id, name, firstName, email: user.email ?? "" },
    // Alias pt-BR para quem digita o token na mão.
    responsavel: { nome: name, primeiroNome: firstName, email: user.email ?? "" },
  };
}

const ASSIGNEE_TOKEN_RE = /\{\{\s*(assignee|responsavel)\s*\./i;

/**
 * `interpolateContextVariables` + responsável do lead. Só consulta o banco
 * quando o texto realmente usa `{{assignee.*}}`/`{{responsavel.*}}`, então o
 * caminho comum de envio continua sem query extra.
 */
async function interpolateMessageVariables(
  template: string,
  rt: RuntimeContext,
  flowVars: Record<string, unknown> | undefined,
): Promise<string> {
  if (!ASSIGNEE_TOKEN_RE.test(template)) {
    return interpolateContextVariables(template, rt, flowVars);
  }
  const assigneeVars = await resolveLeadAssigneeVars(rt);
  return interpolateContextVariables(template, rt, {
    ...(flowVars ?? {}),
    ...assigneeVars,
  });
}

/**
 * A Cloud API rejeita parâmetro de template com quebra de linha, tab ou
 * corrida longa de espaços (132000/132012). Campo customizado preenchido
 * por formulário costuma trazer justamente isso, então achatamos antes de
 * enviar em vez de deixar a Meta recusar a mensagem inteira.
 */
function sanitizeTemplateParameterText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
}

/**
 * Resolve tokens `{{...}}` nos parâmetros de texto que vão para a Meta no
 * `send_whatsapp_template`.
 *
 * Este era o único passo de envio que NÃO passava pelo interpolador: o
 * operador escrevia `{{dealCustomFields.titulovaga1}}` (grafia que o próprio
 * atalho de variáveis do editor sugere) e o aluno recebia a expressão
 * literal. Usa o mesmo `interpolateMessageVariables` dos passos de texto,
 * então caminho com ponto (`contact.name`, `dealCustomFields.<campo>`,
 * `conversation.id`), filtro `|first_name` e token ausente virando string
 * vazia se comportam igual em todo o motor.
 */
async function interpolateTemplateComponents(
  components: unknown[] | undefined,
  rt: RuntimeContext,
  flowVars: Record<string, unknown> | undefined,
): Promise<unknown[] | undefined> {
  if (!Array.isArray(components) || components.length === 0) return components;

  const out: unknown[] = [];
  for (const component of components) {
    const comp = asRecord(component);
    if (!comp || !Array.isArray(comp.parameters)) {
      out.push(component);
      continue;
    }
    const parameters: unknown[] = [];
    for (const parameter of comp.parameters) {
      const param = asRecord(parameter);
      if (!param || typeof param.text !== "string" || !param.text.includes("{{")) {
        parameters.push(parameter);
        continue;
      }
      const resolved = await interpolateMessageVariables(param.text, rt, flowVars);
      parameters.push({ ...param, text: sanitizeTemplateParameterText(resolved) });
    }
    out.push({ ...comp, parameters });
  }
  return out;
}

function readBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (typeof v === "boolean") return v;
  return undefined;
}

function isDealStatus(v: string): v is DealStatus {
  return v === "OPEN" || v === "WON" || v === "LOST";
}
function isActivityType(v: string): v is ActivityType {
  return ACTIVITY_TYPES.includes(v as ActivityType);
}
function isLifecycleStage(v: string): v is LifecycleStage {
  return LIFECYCLE_STAGES.includes(v as LifecycleStage);
}

function inboundEventPayload(
  event: string,
  data: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const channelId =
    typeof data.channelId === "string" && data.channelId.trim()
      ? data.channelId.trim()
      : undefined;
  const content =
    typeof data.content === "string" && data.content.trim()
      ? data.content.slice(0, 200)
      : undefined;
  return {
    evento: event,
    event,
    ...(content ? { mensagem: content } : {}),
    ...(data.channel ? { canal: data.channel } : {}),
    ...(channelId ? { channelId } : {}),
    ...extra,
  };
}

async function logStep(args: {
  automationId: string;
  contactId?: string | null;
  dealId?: string | null;
  stepId?: string | null;
  stepType?: string | null;
  status: string;
  message: string;
  payload?: Record<string, unknown> | null;
  metaWebhookEventId?: string | null;
}) {
  const base = {
    automationId: args.automationId,
    contactId: args.contactId ?? null,
    dealId: args.dealId ?? null,
    status: args.status,
    message: args.message,
  };

  const payloadJson = args.payload ? (args.payload as Prisma.InputJsonValue) : undefined;
  const metaWebhookEventId = args.metaWebhookEventId ?? null;

  try {
    await prisma.automationLog.create({
      data: withOrgFromCtx({
        ...base,
        stepId: (args.stepId as string) ?? null,
        stepType: (args.stepType as string) ?? null,
        ...(payloadJson !== undefined ? { payload: payloadJson } : {}),
        ...(metaWebhookEventId ? { metaWebhookEventId } : {}),
      }),
    });
  } catch (firstErr) {
    try {
      await prisma.automationLog.create({
        data: withOrgFromCtx({
          ...base,
          ...(payloadJson !== undefined ? { payload: payloadJson } : {}),
          ...(metaWebhookEventId ? { metaWebhookEventId } : {}),
        }),
      });
    } catch (secondErr) {
      try {
        // Apos a migration multi-tenancy, "organizationId" e NOT NULL em
        // automation_logs. O fallback de fallback precisa injetar o orgId
        // do ctx; se nao houver ctx, melhor desistir e logar do que estourar
        // erro 500 numa rota que ja estava degradada.
        const orgId = getOrgIdOrNull();
        if (!orgId) {
          throw new Error(
            "logStep raw fallback sem organizationId no contexto",
          );
        }
        await prisma.$executeRawUnsafe(
          `INSERT INTO "automation_logs" ("id", "organizationId", "automationId", "contactId", "dealId", "status", "message", "executedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
          orgId,
          args.automationId,
          args.contactId ?? null,
          args.dealId ?? null,
          args.status,
          args.message,
        );
      } catch (rawErr) {
        log.error(
          `Falha ao gravar log no banco — primeira=${firstErr instanceof Error ? firstErr.message : firstErr} segunda=${secondErr instanceof Error ? secondErr.message : secondErr} raw=${rawErr instanceof Error ? rawErr.message : rawErr}`,
        );
      }
    }
  }
}

/**
 * Snapshot da conversa usada em conditions. Capturamos o snapshot aqui
 * pra o avaliador do `condition` poder comparar contra `conversation.status`,
 * `conversation.channel`, `conversation.isClosed` etc. — sem precisar
 * reconsultar o banco a cada regra.
 *
 * Atenção: `status` segue o enum `ConversationStatus` do Prisma (`OPEN`,
 * `RESOLVED`, `PENDING`, `SNOOZED`). O alias `isClosed` é `true` quando
 * `status === "RESOLVED"` — é o que o operador entende por "conversa
 * fechada" no produto.
 */
type ConversationSnapshot = {
  id: string;
  status: string;
  channel: string;
  channelId: string | null;
  isClosed: boolean;
  hasAgentReply: boolean;
  hasError: boolean;
  unreadCount: number;
  assignedToId: string | null;
  departmentId: string | null;
};

/**
 * Deal + campos derivados (nome do estágio e do pipeline) — usamos nome
 * em vez de ID nas conditions por dois motivos: (1) evita que o operador
 * precise copiar/colar cuids no form, (2) sobrevive a recriação de
 * estágio/pipeline quando o nome é preservado. O ID continua disponível
 * (`deal.stageId`, `deal.pipelineId`) para quem preferir.
 */
type DealWithNames = Deal & {
  contactId: string | null;
  stageName: string;
  pipelineId: string;
  pipelineName: string;
};

type RuntimeContext = {
  automationId: string;
  /** Nome da automação em execução — usado como `senderName` nas
      mensagens postadas pelos steps, pra que a UI exiba a badge
      "AUTOMAÇÃO — <nome>" e o operador identifique qual regra
      disparou. `null`/undefined mantém fallback "Automação" no front. */
  automationName?: string | null;
  /** Nome do agente que disparou a automação MANUALMENTE (via /run). Quando
      presente, as mensagens enviadas pelos steps são tagueadas com
      `triggeredByName` — o inbox exibe o selo "Manual" + avatar do agente
      (colab) na própria mensagem enviada, sem card de status separado. */
  triggeredByName?: string | null;
  contactId?: string;
  dealId?: string;
  event: string;
  data: Record<string, unknown>;
  contact: Contact | null;
  deal: DealWithNames | null;
  conversation: ConversationSnapshot | null;
  // 27/mai/26 — Tags carregadas junto com contact/deal pra avaliação
  // de `has_tag`/`not_has_tag` nas conditions. Mantemos id e nome em
  // arrays paralelos pra suportar match por qualquer um dos dois (o
  // operador escolhe um nome no picker da UI; salvar por id continua
  // disponível pra retrocompat e robustez a renomes).
  contactTagIds: string[];
  contactTagNames: string[];
  dealTagIds: string[];
  dealTagNames: string[];
  // 03/jun/26 — Snapshot de custom fields do contato/negócio. Usado
  // pelo construtor visual do step `webhook` pra emitir tokens como
  // `{{contactCustomFields.<nome>}}`. Chave é o `name` (slug) do
  // CustomField; valor é o `String` armazenado em
  // `*_custom_field_values.value` (todos os tipos serializam pra
  // string no banco).
  contactCustomFields: Record<string, string>;
  dealCustomFields: Record<string, string>;
  /**
   * Profundidade de encadeamento herdada do job (anti-loop). Passos que
   * disparam gatilhos como efeito (mover etapa) propagam `depth+1` via
   * `notifyDealStageChanged`. Ver `AutomationJobContext.depth`.
   */
  depth: number;
  /**
   * Canal (WhatsApp/e-mail) usado pelo ÚLTIMO passo de mensagem no
   * caminho de execução atual. Setado por `resolveOutboundChannelId`
   * após cada envio — passos de mensagem seguintes SEM `channelId`
   * próprio herdam este valor. `null`/undefined = nenhum envio ainda
   * (ou canal não identificado).
   */
  activeChannelId?: string | null;
};

/**
 * Carrega tags do contato e do deal em arrays paralelos (ids + nomes).
 *
 * Usado por `resolveRuntimeContext` (primeira execução) e por
 * `continueFromStep` (continuação após `wait_for_reply`/`question`),
 * além de ser invocado dentro do loop após cada `add_tag`/`remove_tag`
 * pra que a próxima `condition` enxergue o estado atualizado das tags.
 */
/**
 * Snapshot dos custom fields do contato e do negócio (chave = `name` do
 * CustomField, valor = string armazenada). Usado tanto na execução
 * inicial quanto em `continueFromStep` pra que o webhook tenha a versão
 * mais atual quando o operador montou um body que referencia
 * `{{contactCustomFields.celular_55}}`, `{{dealCustomFields.observacao}}`
 * etc. via construtor visual.
 *
 * Recarregamos depois de `update_field` (no loop principal) pra evitar
 * que um webhook subsequente envie a versão antiga.
 */
async function loadAutomationCustomFieldsSnapshot(
  contactId: string | undefined,
  dealId: string | undefined,
): Promise<{
  contactCustomFields: Record<string, string>;
  dealCustomFields: Record<string, string>;
}> {
  const contactCustomFields: Record<string, string> = {};
  const dealCustomFields: Record<string, string> = {};

  if (contactId) {
    const rows = await prisma.contactCustomFieldValue.findMany({
      where: { contactId },
      select: { value: true, customField: { select: { name: true } } },
    });
    for (const r of rows) {
      const name = r.customField?.name;
      if (name) contactCustomFields[name] = r.value ?? "";
    }
  }

  if (dealId) {
    const rows = await prisma.dealCustomFieldValue.findMany({
      where: { dealId },
      select: { value: true, customField: { select: { name: true } } },
    });
    for (const r of rows) {
      const name = r.customField?.name;
      if (name) dealCustomFields[name] = r.value ?? "";
    }
  }

  return { contactCustomFields, dealCustomFields };
}

async function loadAutomationTagSnapshot(
  contactId: string | undefined,
  dealId: string | undefined,
): Promise<{
  contactTagIds: string[];
  contactTagNames: string[];
  dealTagIds: string[];
  dealTagNames: string[];
}> {
  let contactTagIds: string[] = [];
  let contactTagNames: string[] = [];
  let dealTagIds: string[] = [];
  let dealTagNames: string[] = [];

  if (contactId) {
    const rows = await prisma.tagOnContact.findMany({
      where: { contactId },
      select: { tagId: true, tag: { select: { name: true } } },
    });
    contactTagIds = rows.map((r) => r.tagId);
    contactTagNames = rows
      .map((r) => r.tag?.name)
      .filter((n): n is string => typeof n === "string");
  }

  if (dealId) {
    const rows = await prisma.tagOnDeal.findMany({
      where: { dealId },
      select: { tagId: true, tag: { select: { name: true } } },
    });
    dealTagIds = rows.map((r) => r.tagId);
    dealTagNames = rows
      .map((r) => r.tag?.name)
      .filter((n): n is string => typeof n === "string");
  }

  return { contactTagIds, contactTagNames, dealTagIds, dealTagNames };
}

async function loadConversationSnapshot(
  contactId: string,
  payloadData: Record<string, unknown>,
): Promise<ConversationSnapshot | null> {
  // Quando o evento carrega um conversationId explícito (webhook da Meta,
  // SSE, etc.) preferimos essa conversa específica. Senão, pegamos a mais
  // recente do contato — é a que o operador vê como "atual" na inbox.
  const explicitId =
    typeof payloadData.conversationId === "string" ? payloadData.conversationId : null;

  const conv = explicitId
    ? await prisma.conversation.findUnique({
        where: { id: explicitId },
        select: {
          id: true,
          status: true,
          channel: true,
          channelId: true,
          hasAgentReply: true,
          hasError: true,
          unreadCount: true,
          assignedToId: true,
          departmentId: true,
          contactId: true,
        },
      })
    : await prisma.conversation.findFirst({
        where: { contactId },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          id: true,
          status: true,
          channel: true,
          channelId: true,
          hasAgentReply: true,
          hasError: true,
          unreadCount: true,
          assignedToId: true,
          departmentId: true,
        },
      });

  if (!conv) return null;

  const statusStr = String(conv.status);
  return {
    id: conv.id,
    status: statusStr,
    channel: conv.channel,
    channelId: conv.channelId ?? null,
    isClosed: statusStr === "RESOLVED",
    hasAgentReply: conv.hasAgentReply,
    hasError: conv.hasError,
    unreadCount: conv.unreadCount,
    assignedToId: conv.assignedToId,
    departmentId: conv.departmentId,
  };
}

// Cache do check da coluna `messages.triggeredByName`. Em ambientes onde a
// migração ainda não rodou, tentar gravar a coluna faria o insert dos steps
// de envio quebrar (P2022). Só tagueamos o disparo manual quando a coluna
// existe — degradação graciosa (mensagem ainda é enviada, apenas sem o selo
// "Manual"/avatar do agente até a migração aplicar).
let _msgTriggeredByNameColumn: boolean | null = null;
async function messageSupportsTriggeredBy(): Promise<boolean> {
  if (_msgTriggeredByNameColumn !== null) return _msgTriggeredByNameColumn;
  try {
    const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'triggeredByName'
      ) AS "exists"`;
    _msgTriggeredByNameColumn = Boolean(rows?.[0]?.exists);
  } catch {
    _msgTriggeredByNameColumn = false;
  }
  return _msgTriggeredByNameColumn;
}

async function resolveRuntimeContext(
  automationId: string,
  payload: AutomationJobPayload,
  automationName?: string | null,
): Promise<RuntimeContext | null> {
  const ctx = payload.context;
  const data = asRecord(ctx.data) ?? {};
  let contactId = ctx.contactId;
  let dealId = ctx.dealId;

  // Sem dealId explícito mas com contato (ex.: execução manual disparada
  // pela conversa, ou gatilhos de contato): resolve o negócio ABERTO mais
  // recente do contato pra que `{{deal.*}}` e os passos de negócio tenham
  // contexto. Mesmo padrão já usado por `consume_stock`/distribuição.
  if (!dealId && contactId) {
    const openDeal = await prisma.deal.findFirst({
      where: { contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (openDeal) {
      dealId = openDeal.id;
    } else if (ctx.event === "manual") {
      // 03/ago/26 — Execução manual é ação explícita do operador sobre a
      // conversa que ele está vendo (negócio visível no painel). Sem
      // fallback, `update_field` em deal abortava com "dealId ausente"
      // quando o único negócio do contato estava LOST/WON. Escopo só
      // `manual`: em gatilhos automáticos, cair no fechado faria
      // `move_stage` reabrir LOST — o que não queremos.
      const anyDeal = await prisma.deal.findFirst({
        where: { contactId },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      if (anyDeal) dealId = anyDeal.id;
    }
  }

  let deal: DealWithNames | null = null;
  let dealTagIds: string[] = [];
  let dealTagNames: string[] = [];
  if (dealId) {
    const rawDeal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: {
        stage: { select: { name: true, pipelineId: true, pipeline: { select: { name: true } } } },
        // 27/mai/26 — Carrega tags do deal junto pra avaliação de
        // `has_tag` em conditions. Selecionamos só id+name pra não
        // inflar payload com color etc.
        tags: { select: { tagId: true, tag: { select: { name: true } } } },
      },
    });
    if (!rawDeal) {
      await logStep({ automationId, contactId, dealId, status: "FAILED", message: "Negócio não encontrado." });
      return null;
    }
    if (!contactId && rawDeal.contactId) contactId = rawDeal.contactId;
    const { stage, tags, ...dealOnly } = rawDeal;
    deal = {
      ...(dealOnly as Deal & { contactId: string | null }),
      stageName: stage?.name ?? "",
      pipelineId: stage?.pipelineId ?? "",
      pipelineName: stage?.pipeline?.name ?? "",
    };
    dealTagIds = tags.map((t) => t.tagId);
    dealTagNames = tags
      .map((t) => t.tag?.name)
      .filter((n): n is string => typeof n === "string");
  }

  let contact: Contact | null = null;
  let contactTagIds: string[] = [];
  let contactTagNames: string[] = [];
  if (contactId) {
    // Em vez de uma findUnique + uma segunda query pras tags, fazemos
    // uma única query com include — `Contact` no `rt` continua sendo
    // o tipo base do Prisma (tags são desestruturadas em campos
    // separados no RuntimeContext pra não vazar pro evalRoot quem não
    // quer).
    const rawContact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        tags: { select: { tagId: true, tag: { select: { name: true } } } },
      },
    });
    if (rawContact) {
      const { tags, ...contactOnly } = rawContact;
      contact = contactOnly as Contact;
      contactTagIds = tags.map((t) => t.tagId);
      contactTagNames = tags
        .map((t) => t.tag?.name)
        .filter((n): n is string => typeof n === "string");
    }
  }

  const conversation = contactId ? await loadConversationSnapshot(contactId, data) : null;

  const customFieldsSnapshot = await loadAutomationCustomFieldsSnapshot(
    contactId,
    dealId,
  );

  const rawTriggeredByName =
    typeof data.triggeredByName === "string" && data.triggeredByName.trim()
      ? data.triggeredByName.trim()
      : null;
  // Só propaga (e, portanto, grava nas mensagens) se a coluna existir.
  const triggeredByName =
    rawTriggeredByName && (await messageSupportsTriggeredBy())
      ? rawTriggeredByName
      : null;

  return {
    automationId,
    automationName: automationName ?? null,
    triggeredByName,
    contactId,
    dealId,
    event: ctx.event,
    data,
    contact,
    deal,
    conversation,
    contactTagIds,
    contactTagNames,
    dealTagIds,
    dealTagNames,
    contactCustomFields: customFieldsSnapshot.contactCustomFields,
    dealCustomFields: customFieldsSnapshot.dealCustomFields,
    depth: typeof ctx.depth === "number" ? ctx.depth : 0,
    // Campanha: wizard em `data.channelId`. Inbound: canal da mensagem.
    // Sem payload, herda o canal do ticket — nunca o 1º CONNECTED da org.
    activeChannelId:
      typeof data.channelId === "string" && data.channelId.trim()
        ? data.channelId.trim()
        : conversation?.channelId ?? null,
  };
}

function getByPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[p];
  }
  return cur;
}

function coerceForCompare(
  left: unknown,
  right: unknown
): { l: unknown; r: unknown } {
  // `right` quase sempre vem do form como string. Se o `left` for
  // number e o `right` parecer número, converte pros dois serem number
  // — evita falsos negativos tipo "5" === 5.
  if (typeof left === "number" && typeof right === "string" && right.trim() !== "") {
    const n = Number(right);
    if (!Number.isNaN(n)) return { l: left, r: n };
  }
  if (typeof right === "number" && typeof left === "string" && left.trim() !== "") {
    const n = Number(left);
    if (!Number.isNaN(n)) return { l: n, r: right };
  }
  // Boolean vs string "true"/"false" — a UI salva o valor do `SelectNative`
  // como string, mas o runtime produz boolean real (ex. `conversation.isClosed`,
  // `conversation.hasError`). Normaliza para boolean dos dois lados.
  if (typeof left === "boolean" && typeof right === "string") {
    const s = right.trim().toLowerCase();
    if (s === "true" || s === "false") return { l: left, r: s === "true" };
  }
  if (typeof right === "boolean" && typeof left === "string") {
    const s = left.trim().toLowerCase();
    if (s === "true" || s === "false") return { l: s === "true", r: right };
  }
  // Strings → comparação case-insensitive pra `eq`/`ne`/`includes` é
  // tratada no switch; aqui só normalizo whitespace nas duas pontas.
  if (typeof left === "string" && typeof right === "string") {
    return { l: left.trim(), r: right.trim() };
  }
  return { l: left, r: right };
}

/**
 * Avalia se `now` (default: agora) cai dentro de alguma faixa da schedule.
 * Aceita schedule como array direto OU envelopado em { schedule, timezone }.
 * Usado pelo step `business_hours` e pela regra `in_business_hours` do
 * bloco Condição.
 */
function evaluateBusinessHoursValue(raw: unknown, now: Date = new Date()): boolean {
  let schedule: Array<{ days?: number[]; from?: string; to?: string }> = [];
  let tz = "America/Sao_Paulo";

  // Aceita: array direto, objeto { schedule, timezone }, ou JSON string.
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  if (Array.isArray(parsed)) {
    schedule = parsed as typeof schedule;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.schedule)) schedule = obj.schedule as typeof schedule;
    if (typeof obj.timezone === "string" && obj.timezone.trim()) tz = obj.timezone.trim();
  }
  if (schedule.length === 0) return false;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const parts = formatter.formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const dayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[dayName] ?? now.getDay();
  const nowMinutes = hh * 60 + mm;

  for (const slot of schedule) {
    if (!slot.days?.includes(dayOfWeek)) continue;
    const [fh, fm] = (slot.from ?? "00:00").split(":").map(Number);
    const [th, tm] = (slot.to ?? "23:59").split(":").map(Number);
    const fromMin = fh * 60 + fm;
    const toMin = th * 60 + tm;
    if (nowMinutes >= fromMin && nowMinutes <= toMin) return true;
  }
  return false;
}

function evalCondition(leftRaw: unknown, op: string, rightRaw: unknown): boolean {
  const { l: left, r: right } = coerceForCompare(leftRaw, rightRaw);
  const lStr = typeof left === "string" ? left.toLowerCase() : left;
  const rStr = typeof right === "string" ? right.toLowerCase() : right;

  switch (op) {
    case "eq":
      if (typeof lStr === "string" && typeof rStr === "string") return lStr === rStr;
      return left === right;
    case "ne":
      if (typeof lStr === "string" && typeof rStr === "string") return lStr !== rStr;
      return left !== right;
    case "gt":
      return typeof left === "number" && typeof right === "number" && left > right;
    case "gte":
      return typeof left === "number" && typeof right === "number" && left >= right;
    case "lt":
      return typeof left === "number" && typeof right === "number" && left < right;
    case "lte":
      return typeof left === "number" && typeof right === "number" && left <= right;
    case "includes":
      if (typeof left === "string" && typeof right === "string")
        return left.toLowerCase().includes(right.toLowerCase());
      if (Array.isArray(left)) return left.includes(right);
      return false;
    case "starts_with":
      return typeof left === "string" && typeof right === "string"
        && left.toLowerCase().startsWith(right.toLowerCase());
    case "ends_with":
      return typeof left === "string" && typeof right === "string"
        && left.toLowerCase().endsWith(right.toLowerCase());
    case "empty":
      if (left == null) return true;
      if (typeof left === "string") return left.trim() === "";
      if (Array.isArray(left)) return left.length === 0;
      return false;
    case "not_empty":
      if (left == null) return false;
      if (typeof left === "string") return left.trim() !== "";
      if (Array.isArray(left)) return left.length > 0;
      return true;
    case "has_tag":
    case "not_has_tag": {
      // `left` é sempre um array (`contact.tags`, `contact.tagIds`,
      // `deal.tags`, `deal.tagIds`) — o evalRoot garante isso. `right`
      // pode ser nome OU id (a UI escolhe via picker, mas a checagem
      // case-insensitive contra ambos é resiliente). Se o lado esquerdo
      // não for array, devolvemos `false` (configuração inválida).
      if (!Array.isArray(left)) return op === "not_has_tag";
      const needle = typeof right === "string" ? right.trim().toLowerCase() : String(right ?? "").trim().toLowerCase();
      if (!needle) return op === "not_has_tag"; // value vazio = "sem tag escolhida" → trata como "nenhuma match"
      const haystack = left.map((v) => String(v ?? "").trim().toLowerCase());
      const hit = haystack.includes(needle);
      return op === "has_tag" ? hit : !hit;
    }
    default:
      return false;
  }
}

type StepResult = {
  skipRemaining?: boolean;
  gotoStepId?: string;
  setVariable?: { name: string; value: unknown };
  /** Quando presente, substitui o "OK" na mensagem de SUCCESS do log. */
  note?: string;
};

/**
 * Monta a origem gravada em `meta.automationOrigin` dos eventos de
 * timeline produzidos pelo passo.
 *
 * `stepNumber` é o índice 1-based na lista ordenada por `position` — o
 * MESMO número que o editor de automações mostra no badge do card
 * (`workflow-canvas.tsx`, `stepIndex: index + 1`), então o operador
 * consegue ir direto ao card citado na timeline.
 */
function buildStepOrigin(
  rt: RuntimeContext,
  automationName: string | null | undefined,
  step: { id: string; type: string },
  orderedSteps: { id: string }[],
): AutomationOrigin {
  const idx = orderedSteps.findIndex((s) => s.id === step.id);
  return {
    automationId: rt.automationId,
    automationName: automationName ?? rt.automationName ?? null,
    stepId: step.id,
    stepType: step.type,
    stepNumber: idx >= 0 ? idx + 1 : null,
    stepLabel: STEP_TYPE_LABELS[step.type] ?? step.type,
  };
}

async function executeStep(
  stepType: string,
  rawConfig: Prisma.JsonValue | Record<string, unknown>,
  rt: RuntimeContext
): Promise<StepResult> {
  const cfg = asRecord(rawConfig as Prisma.JsonValue) ?? {};

  switch (stepType) {
    case "send_email": {
      const to = readString(cfg, "to") ?? rt.contact?.email ?? "";
      const subject = readString(cfg, "subject") ?? "(sem assunto)";
      log.warn(`send_email: envio de e-mail não implementado (to=${to}, assunto="${subject}") — step ignorado`);
      return {};
    }

    case "move_stage":
    case "move_to_stage": {
      const stageId = readString(cfg, "stageId") ?? readString(cfg, "value");
      if (!stageId) throw new Error("move_stage: stageId obrigatório");
      let targetDealId = rt.dealId ?? readString(cfg, "dealId");
      if (!targetDealId && rt.contactId) {
        const openDeal = await prisma.deal.findFirst({
          where: { contactId: rt.contactId, status: "OPEN" },
          select: { id: true },
        });
        targetDealId = openDeal?.id;
      }
      if (!targetDealId) {
        // Opt-in: sem negócio aberto, seguir o fluxo em vez de abortar.
        // Padrão continua sendo throw (ex.: Dna Work não pode mudar).
        if (cfg.continueIfNoDeal === true) {
          return { note: "ignorado (contato sem negócio aberto)" };
        }
        throw new Error("move_stage: dealId ausente no contexto");
      }
      // Estágios terminais fixos (Ganho/Perdido) sincronizam Deal.status
      // — mesma regra do moveDeal manual no Kanban.
      const targetStage = await prisma.stage.findUnique({
        where: { id: stageId },
        select: { isWon: true, isLost: true, name: true },
      });
      const currentDeal = await prisma.deal.findUnique({
        where: { id: targetDealId },
        select: {
          status: true,
          stageId: true,
          contactId: true,
          stage: { select: { name: true } },
        },
      });
      const statusPatch = targetStage?.isWon
        ? currentDeal?.status === "WON"
          ? {}
          : { status: "WON" as const, closedAt: new Date(), lostReason: null }
        : targetStage?.isLost
          ? currentDeal?.status === "LOST"
            ? {}
            : { status: "LOST" as const, closedAt: new Date() }
          : currentDeal?.status === "OPEN" || !currentDeal
            ? {}
            : { status: "OPEN" as const, closedAt: null, lostReason: null };
      await prisma.deal.update({ where: { id: targetDealId }, data: { stageId, ...statusPatch } });
      // Só sincroniza Deal.status. NÃO encerrar conversa: fila ≠ funil.
      // Loga STAGE_CHANGED na timeline do negócio (paridade com o move
      // manual/kanban/bulk). Antes o move por automação não registrava o
      // evento — só disparava o trigger encadeado abaixo.
      //
      // O `actorOverride` faz a timeline exibir "por Automação: <nome>"
      // em vez de "por Sistema" — sem isso o operador não distingue
      // movimentação automática de intervenção manual (ver incidente
      // Dna Work 2026-08-05: deals sumindo em "Formalização feita" sem
      // rastro visível). `automationId`/`automationName` também vão no
      // meta pra permitir filtros/consultas.
      if (currentDeal?.stageId && currentDeal.stageId !== stageId) {
        createDealEvent(
          targetDealId,
          null,
          "STAGE_CHANGED",
          {
            from: { id: currentDeal.stageId, name: currentDeal.stage?.name ?? currentDeal.stageId },
            to: { id: stageId, name: targetStage?.name ?? stageId },
            automationId: rt.automationId,
            ...(rt.automationName ? { automationName: rt.automationName } : {}),
          },
          {
            type: "AUTOMATION",
            label: rt.automationName ? `Automação: ${rt.automationName}` : "Automação",
            ref: rt.automationId,
          },
        ).catch(() => {});
      }
      // Dispara "mudança de fase" (encadeado, com guarda anti-loop) pra que
      // automações "quando entra na fase X" também rodem quando OUTRA
      // automação move o negócio. Antes esse caminho não disparava nada.
      if (currentDeal?.stageId && currentDeal.stageId !== stageId) {
        void notifyDealStageChanged(targetDealId, currentDeal.stageId, stageId, {
          contactId: rt.contactId ?? currentDeal.contactId ?? undefined,
          depth: (rt.depth ?? 0) + 1,
        });
      }
      return {};
    }

    case "mark_deal_won":
    case "mark_deal_lost": {
      const isLost = stepType === "mark_deal_lost";
      const pipelineId = readString(cfg, "pipelineId");
      if (!pipelineId) {
        throw new Error(`${stepType}: pipelineId obrigatório`);
      }
      const lostReason = isLost ? readString(cfg, "lostReason") : undefined;
      if (isLost && !lostReason?.trim()) {
        throw new Error("mark_deal_lost: lostReason obrigatório");
      }

      let targetDealId = rt.dealId ?? readString(cfg, "dealId");
      if (!targetDealId && rt.contactId) {
        const openDeal = await prisma.deal.findFirst({
          where: { contactId: rt.contactId, status: "OPEN" },
          select: { id: true },
        });
        targetDealId = openDeal?.id;
      }
      if (!targetDealId) {
        if (cfg.continueIfNoDeal === true) {
          return { note: "ignorado (contato sem negócio aberto)" };
        }
        throw new Error(`${stepType}: dealId ausente no contexto`);
      }

      const before = await prisma.deal.findUnique({
        where: { id: targetDealId },
        select: { status: true, stageId: true, contactId: true },
      });
      if (!before) throw new Error(`${stepType}: negócio não encontrado`);

      const updated = isLost
        ? await markDealLost(targetDealId, lostReason, { pipelineId })
        : await markDealWon(targetDealId, { pipelineId });

      const contactIdForEvents = rt.contactId ?? before.contactId ?? undefined;

      createDealEvent(
        targetDealId,
        null,
        "STATUS_CHANGED",
        {
          from: before.status,
          to: isLost ? "LOST" : "WON",
          ...(isLost ? { lostReason } : {}),
          automationId: rt.automationId,
          ...(rt.automationName ? { automationName: rt.automationName } : {}),
        },
        {
          type: "AUTOMATION",
          label: rt.automationName ? `Automação: ${rt.automationName}` : "Automação",
          ref: rt.automationId,
        },
      ).catch(() => {});

      if (before.stageId !== updated.stageId) {
        createDealEvent(
          targetDealId,
          null,
          "STAGE_CHANGED",
          {
            from: { id: before.stageId },
            to: { id: updated.stageId },
            automationId: rt.automationId,
            ...(rt.automationName ? { automationName: rt.automationName } : {}),
          },
          {
            type: "AUTOMATION",
            label: rt.automationName ? `Automação: ${rt.automationName}` : "Automação",
            ref: rt.automationId,
          },
        ).catch(() => {});
      }

      fireTrigger(isLost ? "deal_lost" : "deal_won", {
        dealId: targetDealId,
        contactId: contactIdForEvents,
        data: { fromStatus: before.status, ...(isLost ? { lostReason } : {}) },
      }).catch(() => {});

      if (before.stageId !== updated.stageId) {
        void notifyDealStageChanged(targetDealId, before.stageId, updated.stageId, {
          contactId: contactIdForEvents,
          depth: (rt.depth ?? 0) + 1,
        });
      }

      return {};
    }

    case "assign_owner": {
      // userId vazio/whitespace = desatribuir (ownerId null), não erro.
      const rawUserId = readString(cfg, "userId");
      const ownerId = rawUserId?.trim() ? rawUserId.trim() : null;
      const target = readString(cfg, "target") ?? (rt.dealId ? "deal" : "contact");
      const targetDealId = rt.dealId ?? readString(cfg, "dealId");
      const targetContactId = rt.contactId ?? readString(cfg, "contactId");

      // Snapshot do responsável ANTES da troca — vira `meta.from` do
      // OWNER_CHANGED. Sem isso a timeline não explicava atribuições
      // feitas por automação (o passo não registrava nenhum evento).
      const dealIdForEvent =
        target === "deal" || target === "both" ? targetDealId : null;
      const ownerBefore = dealIdForEvent
        ? (
            await prisma.deal.findUnique({
              where: { id: dealIdForEvent },
              select: { owner: { select: { id: true, name: true } } },
            })
          )?.owner ?? null
        : null;

      if (target === "deal") {
        if (!targetDealId) throw new Error("assign_owner: dealId ausente");
        // Responsável único: muda o owner do deal e propaga para o
        // contato + conversas do contato (helper no service).
        await assignDealOwner(targetDealId, ownerId);
      } else if (target === "contact") {
        if (!targetContactId) throw new Error("assign_owner: contactId ausente");
        // Mesma regra de herança do deal: ao atribuir pelo contato,
        // propagamos pras conversas abertas — isso é o que faz o agente
        // de IA assumir automaticamente quando o `userId` aponta pra um
        // User type=AI (`maybeReplyAsAIAgent` lê `conversation.assignedToId`).
        await prisma.$transaction((tx) =>
          propagateOwnerToContactAndChat(tx, targetContactId, ownerId),
        );
      } else if (target === "both") {
        if (!targetDealId && !targetContactId) {
          throw new Error("assign_owner: nem dealId nem contactId disponíveis");
        }
        if (targetDealId) {
          // assignDealOwner já cobre deal + contato do deal + chats. Se o
          // rt.contactId vier de outra origem (ex.: divergente do contato
          // do deal), propagamos também — idempotente se for o mesmo contato.
          await assignDealOwner(targetDealId, ownerId);
          if (rt.contactId) {
            await prisma.$transaction((tx) =>
              propagateOwnerToContactAndChat(tx, rt.contactId, ownerId),
            );
          }
        } else if (targetContactId) {
          await prisma.$transaction((tx) =>
            propagateOwnerToContactAndChat(tx, targetContactId, ownerId),
          );
        }
      } else {
        throw new Error(`assign_owner: target inválido "${target}"`);
      }

      if (dealIdForEvent && (ownerBefore?.id ?? null) !== ownerId) {
        const ownerAfter = ownerId
          ? await prisma.user.findUnique({
              where: { id: ownerId },
              select: { id: true, name: true },
            })
          : null;
        // O `automationOrigin` (automação + nº do card) entra no meta
        // automaticamente via `withAutomationOriginMeta`.
        createDealEvent(
          dealIdForEvent,
          null,
          "OWNER_CHANGED",
          {
            from: ownerBefore
              ? { id: ownerBefore.id, name: ownerBefore.name ?? ownerBefore.id }
              : null,
            to: ownerId
              ? { id: ownerId, name: ownerAfter?.name ?? ownerId }
              : null,
          },
          {
            type: "AUTOMATION",
            label: rt.automationName ? `Automação: ${rt.automationName}` : "Automação",
            ref: rt.automationId,
          },
        ).catch(() => {});
      }

      return {};
    }

    case "transfer_department": {
      // Transfere a conversa para um departamento (seta conversation.departmentId).
      // Alvo: a conversa do evento (rt.conversation) ou, na ausência, a mais
      // recente do contato. No-op se não houver conversa resolvível.
      const departmentId = readString(cfg, "departmentId");
      if (!departmentId) throw new Error("transfer_department: departmentId obrigatório");

      const convId =
        (rt.conversation && typeof rt.conversation === "object"
          ? (rt.conversation as { id?: string }).id
          : undefined) ??
        (rt.contactId
          ? (
              await prisma.conversation.findFirst({
                where: { contactId: rt.contactId },
                orderBy: [{ updatedAt: "desc" }],
                select: { id: true },
              })
            )?.id
          : undefined);

      if (!convId) return {};
      await prisma.conversation.update({
        where: { id: convId },
        data: { departmentId },
      });
      return {};
    }

    case "execute_distribution": {
      // Distribuição Inteligente como ação de automação. Funciona como um IF
      // (estilo n8n) de DUAS saídas, baseado em "havia agente disponível?":
      //   • SIM  → distribuiu com sucesso → segue o fluxo linear (nextStepId).
      //   • NÃO  → nenhum responsável elegível (ou módulo desabilitado) →
      //            roteia pro ramo `elseStepId` (handle "false" no canvas).
      // Usa SOMENTE o motor único (`executeDistribution`) — mesma regra da
      // tela/simulação. Quando NÃO há elegível, o motor já enfileira o lead
      // em `distribution_pending` (rede de segurança p/ redistribuir depois);
      // aqui só decidimos qual ramo do fluxo seguir. Não lançamos erro: a
      // ausência de agente é um resultado de negócio esperado, não falha.
      const distributionType = readString(cfg, "distributionType") ?? null;
      const departmentIdsRaw = Array.isArray(cfg.departmentIds)
        ? cfg.departmentIds
        : [];
      const departmentIds = departmentIdsRaw
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v) => v.trim());
      // Retrocompat: config antiga com departmentId singular.
      const legacyDept = readString(cfg, "departmentId");
      if (legacyDept && !departmentIds.includes(legacyDept)) {
        departmentIds.push(legacyDept);
      }
      const conversationId =
        rt.conversation && typeof rt.conversation === "object"
          ? ((rt.conversation as { id?: string }).id ?? null)
          : null;

      const result = await executeDistribution({
        dealId: rt.dealId ?? null,
        contactId: rt.contactId ?? null,
        conversationId,
        triggerSource: "AUTOMATION",
        distributionType,
        departmentIds: departmentIds.length > 0 ? departmentIds : null,
      });

      if (result.success) {
        // Saída SIM = fluxo linear (próximo passo).
        return {};
      }

      // Saída NÃO = sem agente elegível / módulo off. Roteia pro ramo "false".
      const elseStepId = readString(cfg, "elseStepId");
      if (elseStepId) {
        return { skipRemaining: true, gotoStepId: elseStepId };
      }
      // Sem ramo "Não" conectado: encerra este ramo (lead já foi enfileirado
      // pelo motor quando o motivo foi NO_ELIGIBLE_RESPONSIBLE).
      return { skipRemaining: true };
    }

    case "transfer_to_ai_agent": {
      // Passo dedicado de handoff: transfere a conversa/contato/deal para
      // um agente de IA. Debaixo do capô é um assign_owner apontando pra
      // User.type=AI, mas a UI do passo mostra só agentes IA ativos e
      // explica a mecânica. O runner `maybeReplyAsAIAgent` assume na
      // próxima mensagem inbound.
      const agentUserId = readString(cfg, "agentUserId");
      if (!agentUserId) {
        throw new Error("transfer_to_ai_agent: agentUserId obrigatório");
      }
      // Validação defensiva: confirmar que o alvo é mesmo um agente IA
      // ativo. Se o agente foi desativado ou deletado, logamos e
      // seguimos sem atribuir (melhor que estourar o fluxo).
      const agentUser = await prisma.user.findUnique({
        where: { id: agentUserId },
        select: {
          id: true,
          type: true,
          aiAgentConfig: { select: { active: true } },
        },
      });
      if (!agentUser || agentUser.type !== "AI") {
        log.warn(
          `transfer_to_ai_agent: usuário ${agentUserId} não é um agente IA — ignorando passo`,
        );
        return {};
      }
      if (!agentUser.aiAgentConfig?.active) {
        log.warn(
          `transfer_to_ai_agent: agente IA ${agentUserId} está inativo — ignorando passo`,
        );
        return {};
      }

      const target = readString(cfg, "target") ?? (rt.dealId ? "deal" : "contact");
      let contactForOpening: string | null = null;
      if (target === "deal") {
        const targetDealId = rt.dealId ?? readString(cfg, "dealId");
        if (!targetDealId) {
          throw new Error("transfer_to_ai_agent: dealId ausente");
        }
        await assignDealOwner(targetDealId, agentUserId);
        // Resolve o contact do deal pra poder disparar a saudação
        // proativa (precisa do contactId, não do dealId).
        const deal = await prisma.deal.findUnique({
          where: { id: targetDealId },
          select: { contactId: true },
        });
        contactForOpening = deal?.contactId ?? null;
      } else {
        const targetContactId = rt.contactId ?? readString(cfg, "contactId");
        if (!targetContactId) {
          throw new Error("transfer_to_ai_agent: contactId ausente");
        }
        await prisma.$transaction((tx) =>
          propagateOwnerToContactAndChat(tx, targetContactId, agentUserId),
        );
        contactForOpening = targetContactId;
      }

      // Saudação proativa: dispara imediatamente após a atribuição,
      // sem esperar o cliente mandar mensagem. Isso resolve o caso de
      // automações cujo trigger é "Negócio criado" / etc. — antes, o
      // agente ficava mudo porque `maybeReplyAsAIAgent` só roda em
      // inbound. Idempotente via `Conversation.aiGreetedAt`, então
      // se o cliente mandar algo depois, a saudação não repete.
      //
      // Falhas aqui não podem derrubar o passo da automação: o log do
      // passo já registrou "transfer_to_ai_agent OK". A saudação é
      // efeito colateral; se falhar, o agente ainda responderá ao
      // próximo inbound normalmente.
      if (contactForOpening) {
        try {
          const opening = await triggerAgentOpeningForContact({
            contactId: contactForOpening,
            agentUserId,
            channel: "meta",
          });
          if (opening.status === "skipped") {
            log.info(
              `transfer_to_ai_agent: saudação proativa pulada (${opening.reason})`,
            );
          } else {
            log.info(
              `transfer_to_ai_agent: saudação proativa ${opening.status} (conv=${opening.conversationId})`,
            );
          }
        } catch (err) {
          log.warn("transfer_to_ai_agent: falha na saudação proativa:", err);
        }
      }
      return {};
    }

    case "add_tag": {
      const targetContactId = rt.contactId ?? readString(cfg, "contactId");
      if (!targetContactId) throw new Error("add_tag: contactId ausente");
      const tagId = readString(cfg, "tagId");
      const tagName = readString(cfg, "tagName");
      let resolvedTagId = tagId;
      if (!resolvedTagId && tagName) {
        const orgId = getOrgIdOrNull();
        if (!orgId) throw new Error("add_tag: organizationId ausente do contexto");
        const tag = await prisma.tag.upsert({
          where: { organizationId_name: { organizationId: orgId, name: tagName } },
          create: withOrgFromCtx({ name: tagName }),
          update: {},
        });
        resolvedTagId = tag.id;
      }
      if (!resolvedTagId) throw new Error("add_tag: tagId ou tagName obrigatório");
      await prisma.tagOnContact.upsert({
        where: { contactId_tagId: { contactId: targetContactId, tagId: resolvedTagId } },
        create: { contactId: targetContactId, tagId: resolvedTagId },
        update: {},
      });

      // 27/mai/26 — Espelha a tag no deal aberto do contato (TagOnDeal)
      // pra que kanban e inbox mostrem a mesma tag. Antes, `add_tag` só
      // gravava `TagOnContact`: inbox exibia a tag (renderiza tags do
      // contato) mas o card do kanban não (renderiza tags do deal).
      // Operador relatou "no inbox aparece a TAG CLT, mas no kanban não".
      // Buscamos o deal aberto via `rt.dealId` quando presente, ou caímos
      // pro deal mais recente do contato — ambos best-effort.
      const targetDealId =
        rt.dealId ??
        (await prisma.deal
          .findFirst({
            where: { contactId: targetContactId, status: "OPEN" },
            select: { id: true },
            orderBy: { updatedAt: "desc" },
          })
          .then((d) => d?.id));
      if (targetDealId) {
        await prisma.tagOnDeal.upsert({
          where: { dealId_tagId: { dealId: targetDealId, tagId: resolvedTagId } },
          create: { dealId: targetDealId, tagId: resolvedTagId },
          update: {},
        });
      }
      return {};
    }

    case "remove_tag": {
      const targetContactId = rt.contactId ?? readString(cfg, "contactId");
      if (!targetContactId) throw new Error("remove_tag: contactId ausente");
      const tagId = readString(cfg, "tagId");
      const tagName = readString(cfg, "tagName");
      let resolvedTagId = tagId;
      if (!resolvedTagId && tagName) {
        const orgId = getOrgIdOrNull();
        if (orgId) {
          const tag = await prisma.tag.findUnique({
            where: { organizationId_name: { organizationId: orgId, name: tagName } },
          });
          if (tag) resolvedTagId = tag.id;
        }
      }
      if (resolvedTagId) {
        await prisma.tagOnContact.deleteMany({
          where: { contactId: targetContactId, tagId: resolvedTagId },
        });
        // Simétrico ao `add_tag`: remove também do deal aberto do
        // contato. Mantém inbox e kanban sincronizados.
        const targetDealId =
          rt.dealId ??
          (await prisma.deal
            .findFirst({
              where: { contactId: targetContactId, status: "OPEN" },
              select: { id: true },
              orderBy: { updatedAt: "desc" },
            })
            .then((d) => d?.id));
        if (targetDealId) {
          await prisma.tagOnDeal.deleteMany({
            where: { dealId: targetDealId, tagId: resolvedTagId },
          });
        }
      }
      return {};
    }

    case "update_field": {
      const entity = readString(cfg, "entity") ?? "contact";
      const field = readString(cfg, "field");
      if (!field) throw new Error("update_field: field obrigatório");
      const value = cfg["value"];

      if (entity === "deal") {
        const targetDealId = rt.dealId ?? readString(cfg, "dealId");
        if (!targetDealId) throw new Error("update_field: dealId ausente");
        const data: Prisma.DealUncheckedUpdateInput = {};
        if (field === "title" && typeof value === "string") data.title = value;
        else if (field === "value" && (typeof value === "number" || typeof value === "string")) {
          data.value = typeof value === "number" ? value : new Prisma.Decimal(String(value));
        } else if (field === "status" && typeof value === "string" && isDealStatus(value)) data.status = value;
        else if (field === "stageId" && typeof value === "string") data.stageId = value;
        if (Object.keys(data).length > 0) {
          // Se o update for de etapa, captura a etapa anterior ANTES pra
          // disparar "mudança de fase" depois (mesmo caminho do move_stage).
          const isStageMove = field === "stageId" && typeof value === "string";
          let prevStageId: string | null = null;
          let moveContactId: string | null = null;
          if (isStageMove) {
            const cur = await prisma.deal.findUnique({
              where: { id: targetDealId },
              select: { stageId: true, contactId: true },
            });
            prevStageId = cur?.stageId ?? null;
            moveContactId = cur?.contactId ?? null;
          }
          await prisma.deal.update({ where: { id: targetDealId }, data });
          if (isStageMove && prevStageId && prevStageId !== value) {
            void notifyDealStageChanged(targetDealId, prevStageId, value as string, {
              contactId: rt.contactId ?? moveContactId ?? undefined,
              depth: (rt.depth ?? 0) + 1,
            });
          }
        } else {
          const customField = await prisma.customField.findFirst({
            where: { entity: "deal", OR: [{ name: field }, { id: field }] },
            select: { id: true },
          });
          if (!customField) {
            throw new Error(`update_field: campo de negócio não suportado: ${field}`);
          }
          await prisma.dealCustomFieldValue.upsert({
            where: {
              dealId_customFieldId: {
                dealId: targetDealId,
                customFieldId: customField.id,
              },
            },
            update: { value: value == null ? "" : String(value) },
            create: withOrgFromCtx({
              dealId: targetDealId,
              customFieldId: customField.id,
              value: value == null ? "" : String(value),
            }),
          });
        }
      } else {
        const targetContactId = rt.contactId ?? readString(cfg, "contactId");
        if (!targetContactId) throw new Error("update_field: contactId ausente");
        const data: Prisma.ContactUncheckedUpdateInput = {};
        if (field === "name" && typeof value === "string") data.name = value;
        else if (field === "email" && (typeof value === "string" || value === null)) data.email = value as string | null;
        else if (field === "phone" && (typeof value === "string" || value === null)) data.phone = value as string | null;
        else if (field === "source" && (typeof value === "string" || value === null)) data.source = value as string | null;
        else if (field === "lifecycleStage" && typeof value === "string" && isLifecycleStage(value)) data.lifecycleStage = value;
        else if (field === "assignedToId" && (typeof value === "string" || value === null)) data.assignedToId = value as string | null;
        if (Object.keys(data).length > 0) {
          await prisma.contact.update({ where: { id: targetContactId }, data });
        } else {
          const customField = await prisma.customField.findFirst({
            where: { entity: "contact", OR: [{ name: field }, { id: field }] },
            select: { id: true },
          });
          if (!customField) {
            throw new Error(`update_field: campo de contato não suportado: ${field}`);
          }
          await prisma.contactCustomFieldValue.upsert({
            where: {
              contactId_customFieldId: {
                contactId: targetContactId,
                customFieldId: customField.id,
              },
            },
            update: { value: value == null ? "" : String(value) },
            create: withOrgFromCtx({
              contactId: targetContactId,
              customFieldId: customField.id,
              value: value == null ? "" : String(value),
            }),
          });
        }
      }
      return {};
    }

    case "create_activity": {
      const userId = readString(cfg, "userId") ??
        (await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
      if (!userId) throw new Error("create_activity: nenhum usuário disponível");
      const typeRaw = readString(cfg, "type") ?? "TASK";
      if (!isActivityType(typeRaw)) throw new Error("create_activity: tipo de atividade inválido");
      const title = readString(cfg, "title");
      if (!title) throw new Error("create_activity: title obrigatório");
      await prisma.activity.create({
        data: withOrgFromCtx({
          type: typeRaw,
          title,
          description: readString(cfg, "description") ?? null,
          userId,
          contactId: rt.contactId ?? null,
          dealId: rt.dealId ?? null,
          completed: readBoolean(cfg, "completed") ?? false,
        }),
      });
      return {};
    }

    case "send_whatsapp_message": {
      const cfgPhone = readString(cfg, "phone")?.trim() || "";
      const phoneRaw = cfgPhone || rt.contact?.phone || "";
      const digits = phoneRaw.replace(/\D/g, "");
      const to = digits.length >= 8 ? digits : undefined;
      const cfgRecipient = readString(cfg, "recipient")?.trim() || "";
      const recipient =
        cfgRecipient || rt.contact?.whatsappBsuid?.trim() || undefined;
      const contentRaw = readString(cfg, "content");
      const vars = (cfg as Record<string, unknown>)["__variables"] as Record<string, unknown> | undefined;
      const content = contentRaw
        ? await interpolateMessageVariables(contentRaw, rt, vars)
        : contentRaw;

      log.debug(`Enviando WhatsApp: contato=${rt.contactId ?? "—"} destino=${to ?? recipient ?? "—"} texto="${content?.slice(0, 60) ?? "(vazio)"}"`);

      if (!content) {
        throw new Error("send_whatsapp_message: content obrigatório (mensagem vazia)");
      }
      if (!to && !recipient) {
        throw new MetaSendFailureError(
          `send_whatsapp_message: sem destino — contato não tem telefone nem BSUID. phone="${phoneRaw}" contactPhone="${rt.contact?.phone ?? "(null)"}"`
        );
      }

      const resolvedChannelId = resolveOutboundChannelId(cfg, rt);
      let conversationId: string | undefined;
      if (rt.contactId) {
        const conv = await resolveAutomationSendConv(
          rt.contactId,
          sendConvOptsFromRt(rt, resolvedChannelId),
        );
        conversationId = conv?.id;
        if (!conv) log.warn(`Nenhuma conversa WhatsApp encontrada para o contato ${rt.contactId}`);
      }
      const metaClient = await resolveAutomationMetaClient({
        automationId: rt.automationId,
        conversationId,
        contactId: rt.contactId ?? null,
        dealId: rt.dealId ?? null,
        channelId: resolvedChannelId,
      });
      rt.activeChannelId = resolvedChannelId;
      if (!metaClient.configured) {
        throw new MetaSendFailureError(
          "send_whatsapp_message: nenhum canal META_CLOUD_API configurado para esta organização."
        );
      }

      let externalId: string | null = null;
      let sentContent = content;
      let msgType = "text";
      let outFlowToken: string | null = null;

      let hardFailure: Error | null = null;
      try {
        const result = await metaClient.sendText(to, content, recipient);
        externalId = result.messages?.[0]?.id ?? null;
      } catch (sendErr) {
        const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        const isSessionError = /131047|re-engage|session|window/i.test(errMsg);
        const fallbackTemplate = readString(cfg, "fallbackTemplateName");

        if (isSessionError && fallbackTemplate) {
          log.info(`Sessão de 24h expirada — caindo para template "${fallbackTemplate}"`);
          const langCode = readString(cfg, "fallbackLanguageCode") ?? "pt_BR";
          try {
            let fbGid: string | null = null;
            try {
              const r = await prisma.whatsAppTemplateConfig.findFirst({
                where: { metaTemplateName: fallbackTemplate },
                select: { metaTemplateId: true },
              });
              fbGid = r?.metaTemplateId?.trim() || null;
            } catch {
              /* ignore */
            }
            const fbEnrich = await enrichTemplateComponentsForFlowSend(metaClient, {
              templateName: fallbackTemplate,
              languageCode: langCode,
              components: undefined,
              templateGraphId: fbGid,
            });
            outFlowToken = fbEnrich.flowToken;
            const tplResult = await metaClient.sendTemplate(
              to,
              fallbackTemplate,
              langCode,
              fbEnrich.components,
              recipient,
            );
            externalId = tplResult?.messages?.[0]?.id ?? null;
            sentContent = `[Template fallback: ${fallbackTemplate}]`;
            msgType = "template";
          } catch (tplErr) {
            hardFailure = tplErr instanceof Error ? tplErr : new Error(String(tplErr));
          }
        } else {
          hardFailure = sendErr instanceof Error ? sendErr : new Error(String(sendErr));
        }
      }

      if (hardFailure) {
        log.error(`Envio WhatsApp falhou (contato=${rt.contactId ?? "—"}): ${hardFailure.message}`);
        const classified = toMetaSendFailure(hardFailure);
        await persistFailedAutomationOutbound({
          conversationId,
          content,
          messageType: "text",
          senderName: rt.automationName ?? "Automação",
          triggeredByName: rt.triggeredByName,
          error: classified,
          channelId: resolvedChannelId,
        });
        throw classified;
      }

      if (conversationId) {
        const author = await resolveOutboundAuthor(
          conversationId,
          readString(cfg, "sendAs"),
          rt.automationName ?? "Automação",
        );

        const saved = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId,
            content: sentContent,
            direction: "out",
            messageType: msgType,
            senderName: author.senderName,
            authorType: author.authorType,
            // Assinando como o consultor, não marca `triggeredByName`: o inbox
            // usa esse campo pra desenhar o avatar de robô + selo "Manual",
            // o que denunciaria a automação na bolha do consultor.
            ...(rt.triggeredByName && !author.asHuman
              ? { triggeredByName: rt.triggeredByName }
              : {}),
            externalId,
            ...(typeof outFlowToken === "string" && outFlowToken.trim()
              ? { flowToken: outFlowToken.trim() }
              : {}),
            ...(resolvedChannelId ? { channelId: resolvedChannelId } : {}),
          }),
        });

        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            updatedAt: new Date(),
            ...(author.asHuman
              ? {
                  lastMessageDirection: "out" as const,
                  hasAgentReply: true,
                  hasHumanReply: true,
                }
              : await botOutboundReplyMark()),
          },
        }).catch(() => {});

        // Resposta "como responsável" libera vaga na fila (sai de Entrada
        // no volume do consultor) — igual ao POST manual do inbox.
        // NÃO chama stopAutomationsAfterHumanReply: o fluxo deve continuar.
        if (author.asHuman) {
          void import("@/services/distribution/pending")
            .then((m) =>
              m.scheduleProcessPendingDistributionQueue({
                trigger: "capacity_released",
                delayMs: 400,
              }),
            )
            .catch(() => {});
        }

        sseBus.publish("new_message", {
          organizationId: getOrgIdOrNull(),
          conversationId,
          contactId: rt.contactId,
          direction: "out",
          content: sentContent,
          timestamp: saved.createdAt,
        });

        if (resolveFailureGotoStepId(cfg)) {
          await awaitMetaDeliveryVerdict(saved.id, "send_whatsapp_message");
        }
      }

      // "Sem resposta": pausa só se o destino for distinto de "Enviado"
      // (mesmo destino = Finalizar em ambos → segue e encerra).
      if (shouldPauseAfterSendForTimeout(cfg)) {
        const rawTimeout = readNumber(cfg, "timeoutMs");
        const timeoutMs =
          rawTimeout && rawTimeout > 0 ? rawTimeout : DEFAULT_WAIT_TIMEOUT_MS;
        return pauseAwaitingReply(cfg, rt, timeoutMs);
      }

      return {};
    }

    case "send_product": {
      const productId = readString(cfg, "productId")?.trim();
      if (!productId) throw new Error("send_product: productId obrigatório");

      // findFirst (não findUnique) para respeitar o escopo de org do
      // Prisma extension — evita vazar produto de outra organização.
      const product = await prisma.product.findFirst({
        where: { id: productId },
        select: { id: true, name: true, description: true, sku: true, price: true, unit: true },
      });
      if (!product) throw new Error(`send_product: produto ${productId} não encontrado`);

      // Preço/canal escolhidos na config (curso multi-preço). Sem isso, usa product.price.
      const basePrice = readNumber(cfg, "unitPrice") ?? Number(product.price ?? 0);
      const discountPct = Math.min(
        100,
        Math.max(0, readNumber(cfg, "discountPercent") ?? 0),
      );
      const priceNumber = basePrice * (1 - discountPct / 100);
      const priceLabel = `R$ ${priceNumber.toFixed(2).replace(".", ",")}`;
      const channel = readString(cfg, "channel")?.trim() || "";
      const produtoVars = {
        produto: {
          nome: product.name ?? "",
          preco: priceLabel,
          preco_numero: priceNumber,
          preco_base: basePrice,
          desconto: discountPct,
          canal: channel,
          sku: product.sku ?? "",
          descricao: product.description ?? "",
          unidade: product.unit ?? "",
        },
      };

      // Texto vazio → resumo padrão do produto. Texto preenchido → o operador
      // controla 100% do conteúdo, usando {{produto.*}} e variáveis de contexto.
      const contentRaw = readString(cfg, "content")?.trim();
      const content =
        contentRaw && contentRaw.length > 0
          ? contentRaw
          : [
              `*${product.name ?? "Produto"}*`,
              product.description ? product.description : null,
              channel ? `Canal: ${channel}` : null,
              `Valor: ${priceLabel}`,
            ]
              .filter(Boolean)
              .join("\n");

      const existingVars = asRecord((cfg as Record<string, unknown>)["__variables"]) ?? {};

      // Reaproveita TODO o fluxo de send_whatsapp_message (resolução de
      // conexão, envio Meta, fallback de template, persistência + SSE).
      return executeStep(
        "send_whatsapp_message",
        {
          ...cfg,
          content,
          __variables: { ...existingVars, ...produtoVars },
        },
        rt,
      );
    }

    case "send_whatsapp_template": {
      const cfgPhone = readString(cfg, "phone")?.trim() || "";
      const phoneRaw = cfgPhone || rt.contact?.phone || "";
      const digits = phoneRaw.replace(/\D/g, "");
      const to = digits.length >= 8 ? digits : undefined;
      const cfgRecipient = readString(cfg, "recipient")?.trim() || "";
      const recipient =
        cfgRecipient || rt.contact?.whatsappBsuid?.trim() || undefined;
      const templateName = readString(cfg, "templateName");
      const langCode = readString(cfg, "languageCode") ?? "pt_BR";
      log.debug(`Enviando template "${templateName}" (${langCode}) → ${to ?? recipient ?? "—"}`);
      if (!templateName) {
        throw new Error(
          `send_whatsapp_template: templateName obrigatório; to=${to ?? "—"} bsuid=${recipient ?? "—"} templateName=(vazio)`,
        );
      }
      if (!to && !recipient) {
        throw new MetaSendFailureError(
          `send_whatsapp_template: sem destino — to=— bsuid=— templateName=${templateName}`,
        );
      }

      const tplChannelId = resolveOutboundChannelId(cfg, rt);
      let tplConversationId: string | undefined;
      if (rt.contactId) {
        const conv = await resolveAutomationSendConv(
          rt.contactId,
          sendConvOptsFromRt(rt, tplChannelId),
        );
        tplConversationId = conv?.id;
      }
      const tplMetaClient = await resolveAutomationMetaClient({
        automationId: rt.automationId,
        conversationId: tplConversationId,
        contactId: rt.contactId ?? null,
        dealId: rt.dealId ?? null,
        channelId: tplChannelId,
      });
      rt.activeChannelId = tplChannelId;
      if (!tplMetaClient.configured) {
        throw new MetaSendFailureError(
          "send_whatsapp_template: nenhum canal META_CLOUD_API configurado para esta organização."
        );
      }

      const tplChannelRow = tplChannelId
        ? await prisma.channel.findUnique({
            where: { id: tplChannelId },
            select: { name: true, phoneNumber: true },
          })
        : null;
      const tplChannelLabel = formatOutboundChannelLabel(tplChannelRow);

      let enrichFlowToken: string | null = null;
      let tplExternalId: string | null = null;
      let tplSavedMessageId: string | null = null;
      let tplConfigId: string | null = null;
      let tplCategory: string | null = null;
      let tplBodyFromDb: string | null = null;
      let templateGraphId: string | null = null;

      const tplFlowVars = asRecord(cfg["__variables"]) ?? undefined;
      const rawComponents = await interpolateTemplateComponents(
        Array.isArray(cfg["components"]) ? (cfg["components"] as unknown[]) : undefined,
        rt,
        tplFlowVars,
      );

      try {
        const gidRow = await prisma.whatsAppTemplateConfig.findFirst({
          where: { metaTemplateName: templateName },
          select: { id: true, metaTemplateId: true, bodyPreview: true, category: true },
        });
        templateGraphId = gidRow?.metaTemplateId?.trim() || null;
        tplConfigId = gidRow?.id ?? null;
        tplCategory = gidRow?.category ?? null;
        tplBodyFromDb = gidRow?.bodyPreview?.trim() || null;
      } catch {
        /* ignore */
      }

      const cfgBody = readString(cfg, "bodyPreview")?.trim() || null;
      const rawBody = cfgBody || tplBodyFromDb;
      const renderedBody = rawBody
        ? renderTemplatePreview(rawBody, templateVariablesFromSendComponents(rawComponents)) || rawBody
        : null;
      const resolvedBody =
        renderedBody && tplFlowVars
          ? interpolateVariables(renderedBody, tplFlowVars)
          : renderedBody;

      // Token que sobrou no corpo APROVADO do template não é variável da
      // Meta — ela manda o texto do jeito que está cadastrado e o aluno
      // recebe `{{dealCustomFields.x}}` cru. Nada que o CRM interpole aqui
      // muda isso; o template precisa ser recadastrado com `{{1}}`/`{{2}}`.
      const leftoverTplTokens = resolvedBody
        ? [...new Set(resolvedBody.match(/\{\{[^}]+\}\}/g) ?? [])]
        : [];
      if (leftoverTplTokens.length > 0) {
        log.warn(
          `send_whatsapp_template "${templateName}": o corpo aprovado na Meta contém ${leftoverTplTokens.join(", ")} como TEXTO FIXO (sem parâmetro correspondente). O aluno vai receber o token literal — recadastre o template usando {{1}}, {{2}}… e preencha os valores no passo.`,
        );
      }
      const tplContent = buildOutboundTemplateMessageContent(
        templateName,
        "generic",
        tplCategory,
        resolvedBody,
        {
          bodyText: resolvedBody,
          buttons: buttonLabelsFromConfig(cfg.buttons),
        },
      );

      try {
        const flowToken = readString(cfg, "flowToken") ?? null;
        const fad = cfg["flowActionData"];
        const flowActionData =
          fad && typeof fad === "object" && !Array.isArray(fad)
            ? (fad as Record<string, unknown>)
            : null;
        const enrichTpl = await enrichTemplateComponentsForFlowSend(tplMetaClient, {
          templateName,
          languageCode: langCode,
          components: rawComponents,
          flowToken,
          flowActionData,
          templateGraphId,
        });
        enrichFlowToken =
          typeof enrichTpl.flowToken === "string" && enrichTpl.flowToken.trim()
            ? enrichTpl.flowToken.trim()
            : null;

        const headerMediaUrlCfg = readString(cfg, "headerMediaUrl")?.trim() || null;
        const headerMediaTypeCfg = readString(cfg, "headerMediaType")?.trim().toLowerCase();
        const finalTplComponents = await injectTemplateHeaderMediaComponent(tplMetaClient, {
          templateName,
          languageCode: langCode,
          templateGraphId,
          components: enrichTpl.components,
          headerMediaUrl: headerMediaUrlCfg,
          headerMediaType:
            headerMediaTypeCfg === "image" || headerMediaTypeCfg === "video" || headerMediaTypeCfg === "document"
              ? headerMediaTypeCfg
              : null,
        });

        const tplResult = await tplMetaClient.sendTemplate(
          to,
          templateName,
          langCode,
          finalTplComponents,
          recipient,
        );
        tplExternalId = tplResult?.messages?.[0]?.id ?? null;
      } catch (sendErr) {
        const classified = classifyMetaSendFailure(sendErr);
        if (!classified) throw sendErr;
        const code = metaGraphCodeOf(sendErr) ?? metaGraphCodeOf(classified);
        const outboundErr =
          code === 132001
            ? new MetaSendFailureError(
                `O template "${templateName}" não está aprovado na WABA do canal ${tplChannelLabel}. O envio não usa outro número.`,
                sendErr,
              )
            : classified;
        log.error(`Envio template falhou (contato=${rt.contactId ?? "—"}): ${outboundErr.message}`);
        await persistFailedAutomationOutbound({
          conversationId: tplConversationId,
          content: tplContent,
          messageType: "template",
          senderName: rt.automationName ?? "Automação",
          triggeredByName: rt.triggeredByName,
          error: outboundErr,
          channelId: tplChannelId,
        });
        throw outboundErr;
      }

      if (tplConversationId) {
        const saved = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId: tplConversationId,
            content: tplContent,
            direction: "out",
            messageType: "template",
            senderName: rt.automationName ?? "Automação", authorType: "bot", ...(rt.triggeredByName ? { triggeredByName: rt.triggeredByName } : {}),
            externalId: tplExternalId,
            ...(enrichFlowToken ? { flowToken: enrichFlowToken } : {}),
            ...(tplConfigId ? { templateConfigId: tplConfigId } : {}),
            ...(tplChannelId ? { channelId: tplChannelId } : {}),
          }),
        });

        await prisma.conversation.update({
          where: { id: tplConversationId },
          data: {
            updatedAt: new Date(),
            ...(await botOutboundReplyMark()),
          },
        }).catch(() => {});

        sseBus.publish("new_message", {
          organizationId: getOrgIdOrNull(),
          conversationId: tplConversationId,
          contactId: rt.contactId,
          direction: "out",
          content: tplContent,
          timestamp: saved.createdAt,
        });
        tplSavedMessageId = saved.id;
      }

      if (tplSavedMessageId && resolveFailureGotoStepId(cfg)) {
        await awaitMetaDeliveryVerdict(tplSavedMessageId, "send_whatsapp_template");
      }

      // Pausa quando:
      //  1) há botões com `gotoStepId` (clique volta pelo webhook), ou
      //  2) "Sem resposta" aponta pra destino ≠ "Enviado".
      // Sem nenhum dos dois, segue linear (comportamento antigo).
      const tplButtons = Array.isArray(cfg.buttons)
        ? (cfg.buttons as { gotoStepId?: string }[])
        : [];
      const tplHasRouting = tplButtons.some(
        (b) => typeof b?.gotoStepId === "string" && b.gotoStepId.trim() !== "",
      );
      const tplHasTimeout = shouldPauseAfterSendForTimeout(cfg);
      if (tplHasRouting || tplHasTimeout) {
        const rawTimeout = readNumber(cfg, "timeoutMs");
        const tplTimeoutMs =
          tplHasTimeout
            ? rawTimeout && rawTimeout > 0
              ? rawTimeout
              : DEFAULT_WAIT_TIMEOUT_MS
            : rawTimeout;
        return pauseAwaitingReply(cfg, rt, tplTimeoutMs);
      }

      // Campanha AUTOMATION sem pausa (sem botão/timeout): fecha ticket se o
      // aluno não respondeu — mesmo modelo do campaign-worker TEMPLATE/TEXT.
      // Com pausa, o contexto PAUSED mantém a conversa na aba Automação.
      if (rt.event === "campaign_trigger" && tplConversationId) {
        await maybeResolveUnansweredOutboundTicket(tplConversationId).catch(
          () => {},
        );
      }

      return {};
    }

    case "send_whatsapp_media": {
      const phoneRaw = readString(cfg, "phone")?.trim() || rt.contact?.phone || "";
      const digits = phoneRaw.replace(/\D/g, "");
      const to = digits.length >= 8 ? digits : undefined;
      const recipient = readString(cfg, "recipient")?.trim() || rt.contact?.whatsappBsuid?.trim() || undefined;
      if (!to && !recipient) {
        throw new MetaSendFailureError("send_whatsapp_media: sem destino");
      }

      const mediaType = readString(cfg, "mediaType") ?? "image";
      const mediaUrl = readString(cfg, "mediaUrl");
      if (!mediaUrl) throw new Error("send_whatsapp_media: mediaUrl obrigatória");
      const caption = readString(cfg, "caption") ?? "";
      const filename = readString(cfg, "filename") ?? "";

      const mediaChannelId = resolveOutboundChannelId(cfg, rt);
      let mediaConversationId: string | undefined;
      if (rt.contactId) {
        const conv = await resolveAutomationSendConv(
          rt.contactId,
          sendConvOptsFromRt(rt, mediaChannelId),
        );
        mediaConversationId = conv?.id;
      }
      const mediaMetaClient = await resolveAutomationMetaClient({
        automationId: rt.automationId,
        conversationId: mediaConversationId,
        contactId: rt.contactId ?? null,
        dealId: rt.dealId ?? null,
        channelId: mediaChannelId,
      });
      rt.activeChannelId = mediaChannelId;
      if (!mediaMetaClient.configured) {
        throw new MetaSendFailureError(
          "send_whatsapp_media: nenhum canal META_CLOUD_API configurado para esta organização."
        );
      }

      let sendResult: { messages: Array<{ id: string }> };
      let displayContent: string;

      try {
        // PR 1.3: aceita tanto URLs novas (`/api/storage/...` tenant-scoped)
        // quanto legacy (`/uploads/...`). Se conseguirmos resolver localmente,
        // fazemos upload pra Meta via media id (evita expor URL pública).
        const { parseStoragePath, readStoredFile, mimeFromFilename } = await import(
          "@/lib/storage/local"
        );
        const parsedStorage = parseStoragePath(mediaUrl);
        const isLegacyLocal = !parsedStorage && mediaUrl.startsWith("/uploads/");
        const isLocalFile = Boolean(parsedStorage) || isLegacyLocal;

        if (isLocalFile) {
          let buffer: Buffer | null = null;
          let resolvedFileName: string;
          let mimeType: string;

          if (parsedStorage) {
            const stored = await readStoredFile(
              parsedStorage.orgId,
              parsedStorage.bucket,
              parsedStorage.fileName,
            );
            if (!stored) {
              throw new MetaSendFailureError(
                `send_whatsapp_media: arquivo nao encontrado em storage (${mediaUrl})`,
              );
            }
            buffer = stored.buffer;
            mimeType = stored.mimeType;
            resolvedFileName = parsedStorage.fileName;
          } else {
            const { readFile } = await import("fs/promises");
            const { join, basename } = await import("path");
            const filePath = join(process.cwd(), "public", mediaUrl);
            try {
              buffer = await readFile(filePath);
            } catch (fsErr) {
              const code =
                fsErr && typeof fsErr === "object" && "code" in fsErr
                  ? String((fsErr as { code: unknown }).code)
                  : "";
              // Arquivo configurado inexistente = impossibilidade de envio.
              // Demais erros de FS (permissão, I/O) seguem genéricos.
              if (code === "ENOENT") {
                throw new MetaSendFailureError(
                  `send_whatsapp_media: arquivo nao encontrado em storage (${mediaUrl})`,
                );
              }
              throw fsErr;
            }
            resolvedFileName = basename(mediaUrl);
            mimeType = mimeFromFilename(resolvedFileName);
          }

          const fName = filename || resolvedFileName;
          let mType = mediaType as "image" | "audio" | "video" | "document";
          let uploadBuffer = buffer;
          let uploadMime = mimeType;
          let uploadName = fName;
          let sendAsVoice = false;

          if (mType === "audio") {
            const { prepareWhatsAppAudio, guessInputExt } = await import("@/lib/audio-convert");
            const prepared = await prepareWhatsAppAudio(
              buffer,
              guessInputExt(mimeType),
              fName,
            );
            if (!prepared.ok) {
              throw new MetaSendFailureError(
                `send_whatsapp_media: falha ao preparar áudio — ${prepared.reason}`,
              );
            }
            uploadBuffer = prepared.payload.buffer;
            uploadMime = prepared.payload.mime;
            uploadName = prepared.payload.fileName;
            sendAsVoice = prepared.payload.voice;
            if (prepared.payload.delivery === "document") mType = "document";
          }

          const metaMediaId = await mediaMetaClient.uploadMedia(uploadBuffer, uploadMime, uploadName);
          // filename só para document — image/video/audio a Meta rejeita (#100).
          const sendFileName = mType === "document" ? uploadName : undefined;
          sendResult = await mediaMetaClient.sendMediaById(
            to,
            metaMediaId,
            mType,
            caption || undefined,
            sendFileName,
            sendAsVoice,
            recipient,
          );
          displayContent = caption || fName || `[${mediaType}]`;
        } else {
          switch (mediaType) {
            case "video":
              sendResult = await mediaMetaClient.sendVideo(to, mediaUrl, caption || undefined, recipient);
              displayContent = caption || "[Vídeo]";
              break;
            case "audio":
              sendResult = await mediaMetaClient.sendAudio(to, mediaUrl, recipient);
              displayContent = "[Áudio]";
              break;
            case "document":
              sendResult = await mediaMetaClient.sendDocument(to, mediaUrl, filename || "documento", caption || undefined, recipient);
              displayContent = caption || filename || "[Documento]";
              break;
            default:
              sendResult = await mediaMetaClient.sendImage(to, mediaUrl, caption || undefined, recipient);
              displayContent = caption || "[Imagem]";
              break;
          }
        }
      } catch (sendErr) {
        const classified = classifyMetaSendFailure(sendErr);
        if (!classified) throw sendErr;
        log.error(`Envio mídia falhou (contato=${rt.contactId ?? "—"}): ${classified.message}`);
        await persistFailedAutomationOutbound({
          conversationId: mediaConversationId,
          content: caption || filename || `[${mediaType}]`,
          messageType: mediaType,
          senderName: rt.automationName ?? "Automação",
          triggeredByName: rt.triggeredByName,
          error: classified,
          mediaUrl,
          channelId: mediaChannelId,
        });
        throw classified;
      }

      const mediaExternalId = sendResult.messages?.[0]?.id ?? null;

      if (mediaConversationId) {
        const saved = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId: mediaConversationId,
            content: displayContent,
            direction: "out",
            messageType: mediaType,
            senderName: rt.automationName ?? "Automação", authorType: "bot", ...(rt.triggeredByName ? { triggeredByName: rt.triggeredByName } : {}),
            externalId: mediaExternalId,
            mediaUrl,
            ...(mediaChannelId ? { channelId: mediaChannelId } : {}),
          }),
        });
        sseBus.publish("new_message", {
          organizationId: getOrgIdOrNull(),
          conversationId: mediaConversationId,
          contactId: rt.contactId,
          direction: "out",
          content: displayContent,
        });

        if (resolveFailureGotoStepId(cfg)) {
          await awaitMetaDeliveryVerdict(saved.id, "send_whatsapp_media");
        }
      }

      return {};
    }

    case "send_whatsapp_interactive": {
      const phoneRaw = readString(cfg, "phone")?.trim() || rt.contact?.phone || "";
      const digits = phoneRaw.replace(/\D/g, "");
      const to = digits.length >= 8 ? digits : undefined;
      const recipient = readString(cfg, "recipient")?.trim() || rt.contact?.whatsappBsuid?.trim() || undefined;
      if (!to && !recipient) {
        throw new MetaSendFailureError("send_whatsapp_interactive: sem destino");
      }

      const interactiveVars = (cfg as Record<string, unknown>)["__variables"] as Record<string, unknown> | undefined;
      const bodyRaw = readString(cfg, "body");
      if (!bodyRaw) throw new Error("send_whatsapp_interactive: body obrigatório");
      const body = await interpolateMessageVariables(bodyRaw, rt, interactiveVars);

      const rawButtons = Array.isArray(cfg.buttons) ? cfg.buttons as { id?: string; title?: string; text?: string; gotoStepId?: string }[] : [];
      if (rawButtons.length === 0) throw new Error("send_whatsapp_interactive: pelo menos 1 botão obrigatório");
      const asList = rawButtons.length > 3;
      const buttons = rawButtons.slice(0, asList ? 10 : 3).map((b, i) => ({
        id: b.id || `btn_${i}`,
        title: (b.title || b.text || `Opção ${i + 1}`).slice(0, asList ? 24 : 20),
      }));

      const headerRaw = readString(cfg, "header");
      const footerRaw = readString(cfg, "footer");
      const header = headerRaw ? await interpolateMessageVariables(headerRaw, rt, interactiveVars) : headerRaw;
      const footer = footerRaw ? await interpolateMessageVariables(footerRaw, rt, interactiveVars) : footerRaw;

      const btnLabels = buttons.map((b) => b.title).join(", ");
      const displayContent = asList
        ? `${body}\n[Lista: ${btnLabels}]`
        : `${body}\n[Botões: ${btnLabels}]`;

      const interactiveChannelId = resolveOutboundChannelId(cfg, rt);
      let conversationId: string | undefined;
      if (rt.contactId) {
        const conv = await resolveAutomationSendConv(
          rt.contactId,
          sendConvOptsFromRt(rt, interactiveChannelId),
        );
        conversationId = conv?.id;
      }
      const interactiveMetaClient = await resolveAutomationMetaClient({
        automationId: rt.automationId,
        conversationId,
        contactId: rt.contactId ?? null,
        dealId: rt.dealId ?? null,
        channelId: interactiveChannelId,
      });
      rt.activeChannelId = interactiveChannelId;
      if (!interactiveMetaClient.configured) {
        throw new MetaSendFailureError(
          "send_whatsapp_interactive: nenhum canal META_CLOUD_API configurado para esta organização."
        );
      }

      let externalId: string | null = null;
      try {
        const sendResult = asList
          ? await interactiveMetaClient.sendInteractiveList(
              to,
              body,
              (
                (readString(cfg, "button")
                  ? await interpolateMessageVariables(readString(cfg, "button")!, rt, interactiveVars)
                  : "Ver opções")
              ).slice(0, 20),
              [
                {
                  title: readString(cfg, "sectionTitle")?.trim()
                    ? (await interpolateMessageVariables(readString(cfg, "sectionTitle")!, rt, interactiveVars)).trim() || null
                    : null,
                  rows: buttons.map((b) => ({ id: b.id, title: b.title })),
                },
              ],
              header,
              footer,
              recipient,
            )
          : await interactiveMetaClient.sendInteractiveButtons(to, body, buttons, header, footer, recipient);
        externalId = sendResult.messages?.[0]?.id ?? null;
      } catch (sendErr) {
        const classified = classifyMetaSendFailure(sendErr) ?? toMetaSendFailure(sendErr);
        log.error(`Envio WhatsApp interativo falhou (contato=${rt.contactId ?? "—"}): ${classified.message}`);
        await persistFailedAutomationOutbound({
          conversationId,
          content: displayContent,
          messageType: "interactive",
          senderName: rt.automationName ?? "Automação",
          triggeredByName: rt.triggeredByName,
          error: classified,
          channelId: interactiveChannelId,
        });
        throw classified;
      }

      if (conversationId) {
        const saved = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId,
            content: displayContent,
            direction: "out",
            messageType: "interactive",
            senderName: rt.automationName ?? "Automação", authorType: "bot", ...(rt.triggeredByName ? { triggeredByName: rt.triggeredByName } : {}),
            externalId,
            sendStatus: "sent",
            ...(interactiveChannelId ? { channelId: interactiveChannelId } : {}),
          }),
        });
        sseBus.publish("new_message", {
          organizationId: getOrgIdOrNull(),
          conversationId,
          contactId: rt.contactId ?? undefined,
          direction: "out",
          content: displayContent,
        });

        if (resolveFailureGotoStepId(cfg)) {
          await awaitMetaDeliveryVerdict(saved.id, "send_whatsapp_interactive");
        }
      }

      const stepId = (cfg as Record<string, unknown>).__stepId as string | undefined;
      // Safety fallback: steps antigos criados antes do campo timeoutMs
      // existir no editor não pausam para sempre — se ninguém responder em
      // 24h o contexto é liberado pela varredura de timeout.
      const INTERACTIVE_DEFAULT_TIMEOUT_MS = 86_400_000;
      const rawTimeout = readNumber(cfg, "timeoutMs");
      const interactiveTimeoutMs = rawTimeout && rawTimeout > 0 ? rawTimeout : INTERACTIVE_DEFAULT_TIMEOUT_MS;
      if (stepId && rt.contactId) {
        await persistPausedContext(rt, stepId, interactiveTimeoutMs);
      }

      return { skipRemaining: true };
    }

    case "send_whatsapp_list": {
      const phoneRaw = readString(cfg, "phone")?.trim() || rt.contact?.phone || "";
      const digits = phoneRaw.replace(/\D/g, "");
      const to = digits.length >= 8 ? digits : undefined;
      const recipient =
        readString(cfg, "recipient")?.trim() || rt.contact?.whatsappBsuid?.trim() || undefined;
      if (!to && !recipient) {
        throw new MetaSendFailureError("send_whatsapp_list: sem destino");
      }

      const listVars = (cfg as Record<string, unknown>)["__variables"] as
        | Record<string, unknown>
        | undefined;
      const bodyRaw = readString(cfg, "body");
      if (!bodyRaw) throw new Error("send_whatsapp_list: body obrigatório");
      const body = await interpolateMessageVariables(bodyRaw, rt, listVars);

      const buttonRaw = readString(cfg, "button") || "";
      const buttonInterpolated = await interpolateMessageVariables(buttonRaw, rt, listVars);
      const buttonLabel = (buttonInterpolated.trim() || "Ver opções").slice(0, 20);

      const sectionTitleRaw = readString(cfg, "sectionTitle");
      const sectionTitle = sectionTitleRaw?.trim()
        ? (await interpolateMessageVariables(sectionTitleRaw, rt, listVars)).trim() || null
        : null;

      const rawRows = Array.isArray(cfg.rows)
        ? (cfg.rows as {
            id?: string;
            title?: string;
            description?: string;
            gotoStepId?: string;
          }[])
        : [];
      const rows = await Promise.all(
        rawRows.slice(0, 10).map(async (r, i) => {
          const titleRaw = r.title || `Opção ${i + 1}`;
          const title = (await interpolateMessageVariables(titleRaw, rt, listVars)).slice(0, 24);
          const descRaw = r.description?.trim();
          const description = descRaw
            ? (await interpolateMessageVariables(descRaw, rt, listVars)).trim().slice(0, 72) || null
            : null;
          return {
            id: (r.id || `row_${i}`).slice(0, 200),
            title,
            description,
          };
        }),
      );
      if (rows.length === 0) {
        throw new Error("send_whatsapp_list: pelo menos 1 item obrigatório");
      }

      const headerRaw = readString(cfg, "header");
      const footerRaw = readString(cfg, "footer");
      const header = headerRaw
        ? await interpolateMessageVariables(headerRaw, rt, listVars)
        : headerRaw;
      const footer = footerRaw
        ? await interpolateMessageVariables(footerRaw, rt, listVars)
        : footerRaw;

      const rowLabels = rows.map((r) => r.title).join(", ");
      const displayContent = `${body}\n[Lista: ${rowLabels}]`;

      const listChannelId = resolveOutboundChannelId(cfg, rt);
      let conversationId: string | undefined;
      if (rt.contactId) {
        const conv = await resolveAutomationSendConv(
          rt.contactId,
          sendConvOptsFromRt(rt, listChannelId),
        );
        conversationId = conv?.id;
      }
      const listMetaClient = await resolveAutomationMetaClient({
        automationId: rt.automationId,
        conversationId,
        contactId: rt.contactId ?? null,
        dealId: rt.dealId ?? null,
        channelId: listChannelId,
      });
      rt.activeChannelId = listChannelId;
      if (!listMetaClient.configured) {
        throw new MetaSendFailureError(
          "send_whatsapp_list: nenhum canal META_CLOUD_API configurado para esta organização.",
        );
      }

      const sections = [
        {
          title: sectionTitle,
          rows,
        },
      ];

      let externalId: string | null = null;
      try {
        const sendResult = await listMetaClient.sendInteractiveList(
          to,
          body,
          buttonLabel,
          sections,
          header,
          footer,
          recipient,
        );
        externalId = sendResult.messages?.[0]?.id ?? null;
      } catch (sendErr) {
        const classified = classifyMetaSendFailure(sendErr) ?? toMetaSendFailure(sendErr);
        log.error(
          `Envio WhatsApp lista falhou (contato=${rt.contactId ?? "—"}): ${classified.message}`,
        );
        await persistFailedAutomationOutbound({
          conversationId,
          content: displayContent,
          messageType: "interactive",
          senderName: rt.automationName ?? "Automação",
          triggeredByName: rt.triggeredByName,
          error: classified,
          channelId: listChannelId,
        });
        throw classified;
      }

      if (conversationId) {
        const saved = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId,
            content: displayContent,
            direction: "out",
            messageType: "interactive",
            senderName: rt.automationName ?? "Automação",
            authorType: "bot",
            ...(rt.triggeredByName ? { triggeredByName: rt.triggeredByName } : {}),
            externalId,
            sendStatus: "sent",
            ...(listChannelId ? { channelId: listChannelId } : {}),
          }),
        });
        sseBus.publish("new_message", {
          organizationId: getOrgIdOrNull(),
          conversationId,
          contactId: rt.contactId ?? undefined,
          direction: "out",
          content: displayContent,
        });

        if (resolveFailureGotoStepId(cfg)) {
          await awaitMetaDeliveryVerdict(saved.id, "send_whatsapp_list");
        }
      }

      const stepId = (cfg as Record<string, unknown>).__stepId as string | undefined;
      const LIST_DEFAULT_TIMEOUT_MS = 86_400_000;
      const rawTimeout = readNumber(cfg, "timeoutMs");
      const listTimeoutMs =
        rawTimeout && rawTimeout > 0 ? rawTimeout : LIST_DEFAULT_TIMEOUT_MS;
      if (stepId && rt.contactId) {
        await persistPausedContext(rt, stepId, listTimeoutMs);
      }

      return { skipRemaining: true };
    }

    case "send_whatsapp_flow": {
      const phoneRaw = readString(cfg, "phone")?.trim() || rt.contact?.phone || "";
      const digits = phoneRaw.replace(/\D/g, "");
      const to = digits.length >= 8 ? digits : undefined;
      const recipient =
        readString(cfg, "recipient")?.trim() || rt.contact?.whatsappBsuid?.trim() || undefined;
      if (!to && !recipient) {
        throw new MetaSendFailureError("send_whatsapp_flow: sem destino");
      }

      const flowDefId = readString(cfg, "flowDefinitionId")?.trim();
      if (!flowDefId) throw new Error("send_whatsapp_flow: formulário obrigatório");
      const flow = await getPublishedFlowForSend(flowDefId);
      if (!flow) {
        throw new MetaSendFailureError(
          "send_whatsapp_flow: formulário não encontrado ou ainda não publicado na Meta",
        );
      }

      const flowVars = (cfg as Record<string, unknown>)["__variables"] as
        | Record<string, unknown>
        | undefined;
      const bodyRaw = readString(cfg, "body")?.trim() || `Preencha o formulário: ${flow.name}`;
      const body = await interpolateMessageVariables(bodyRaw, rt, flowVars);
      const ctaRaw = readString(cfg, "flowCta")?.trim() || "Abrir formulário";
      const flowCta = await interpolateMessageVariables(ctaRaw, rt, flowVars);

      const headerRaw = readString(cfg, "header");
      const footerRaw = readString(cfg, "footer");
      const header = headerRaw
        ? await interpolateMessageVariables(headerRaw, rt, flowVars)
        : headerRaw;
      const footer = footerRaw
        ? await interpolateMessageVariables(footerRaw, rt, flowVars)
        : footerRaw;

      const displayContent = `${body}\n[Flow: ${flowCta}]`;
      const flowChannelId = resolveOutboundChannelId(cfg, rt);
      let conversationId: string | undefined;
      if (rt.contactId) {
        const conv = await resolveAutomationSendConv(
          rt.contactId,
          sendConvOptsFromRt(rt, flowChannelId),
        );
        conversationId = conv?.id;
      }
      const flowMetaClient = await resolveAutomationMetaClient({
        automationId: rt.automationId,
        conversationId,
        contactId: rt.contactId ?? null,
        dealId: rt.dealId ?? null,
        channelId: flowChannelId,
      });
      rt.activeChannelId = flowChannelId;
      if (!flowMetaClient.configured) {
        throw new MetaSendFailureError(
          "send_whatsapp_flow: nenhum canal META_CLOUD_API configurado para esta organização.",
        );
      }

      const flowToken = randomUUID();
      let externalId: string | null = null;
      try {
        const sendResult = await flowMetaClient.sendInteractiveFlow(
          to,
          body,
          {
            flowId: flow.metaFlowId,
            flowCta,
            flowToken,
            flowAction: "navigate",
          },
          header,
          footer,
          recipient,
        );
        externalId = sendResult.messages?.[0]?.id ?? null;
      } catch (sendErr) {
        const classified = classifyMetaSendFailure(sendErr) ?? toMetaSendFailure(sendErr);
        log.error(
          `Envio WhatsApp Flow falhou (contato=${rt.contactId ?? "—"}): ${classified.message}`,
        );
        await persistFailedAutomationOutbound({
          conversationId,
          content: displayContent,
          messageType: "interactive",
          senderName: rt.automationName ?? "Automação",
          triggeredByName: rt.triggeredByName,
          error: classified,
          channelId: flowChannelId,
        });
        throw classified;
      }

      if (conversationId) {
        const saved = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId,
            content: displayContent,
            direction: "out",
            messageType: "interactive",
            senderName: rt.automationName ?? "Automação",
            authorType: "bot",
            ...(rt.triggeredByName ? { triggeredByName: rt.triggeredByName } : {}),
            externalId,
            sendStatus: "sent",
            flowToken,
            ...(flowChannelId ? { channelId: flowChannelId } : {}),
          }),
        });
        sseBus.publish("new_message", {
          organizationId: getOrgIdOrNull(),
          conversationId,
          contactId: rt.contactId ?? undefined,
          direction: "out",
          content: displayContent,
        });

        if (resolveFailureGotoStepId(cfg)) {
          await awaitMetaDeliveryVerdict(saved.id, "send_whatsapp_flow");
        }
      }

      const stepId = (cfg as Record<string, unknown>).__stepId as string | undefined;
      const FLOW_DEFAULT_TIMEOUT_MS = 86_400_000;
      const rawTimeout = readNumber(cfg, "timeoutMs");
      const flowTimeoutMs = rawTimeout && rawTimeout > 0 ? rawTimeout : FLOW_DEFAULT_TIMEOUT_MS;
      if (stepId && rt.contactId) {
        const nextId = readStepRef(cfg, "nextStepId");
        await persistPausedContext(rt, stepId, flowTimeoutMs, {
          [AWAITING_FLOW_VAR]: {
            stepId,
            buttonId: "flow",
            flowToken,
            ...(nextId ? { gotoStepId: nextId } : {}),
          },
        });
      }

      return { skipRemaining: true };
    }

    case "webhook": {
      const rawUrl = readString(cfg, "url");
      if (!rawUrl) throw new Error("webhook: url obrigatória");
      const method = (readString(cfg, "method") ?? "POST").toUpperCase();
      const headers = asRecord(cfg["headers"]) ?? {};

      // Root pra resolver os tokens {{...}} do body/headers/params custom.
      const root = buildWebhookRoot(rt);

      const h = new Headers({ "Content-Type": "application/json" });
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") h.set(k, interpolateWebhookString(v, root));
      }

      // Interpola URL (tokens em path/query já digitados pelo operador).
      let finalUrl = interpolateWebhookString(rawUrl, root);

      // queryParams: aceita array `[{key,value}]` (formato da UI) ou
      // Record<string,string> (compat). Interpolamos valores e anexamos
      // via URLSearchParams — preservando qualquer query já presente
      // na URL (não sobrescreve, só concatena).
      const rawParams = cfg["queryParams"];
      const paramPairs: Array<[string, string]> = [];
      if (Array.isArray(rawParams)) {
        for (const p of rawParams) {
          if (
            p !== null &&
            typeof p === "object" &&
            typeof (p as { key?: unknown }).key === "string" &&
            typeof (p as { value?: unknown }).value === "string"
          ) {
            const key = (p as { key: string }).key.trim();
            if (!key) continue;
            paramPairs.push([key, interpolateWebhookString((p as { value: string }).value, root)]);
          }
        }
      } else if (rawParams && typeof rawParams === "object") {
        for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
          if (typeof v === "string" && k.trim()) {
            paramPairs.push([k, interpolateWebhookString(v, root)]);
          }
        }
      }
      if (paramPairs.length > 0) {
        const sep = finalUrl.includes("?") ? "&" : "?";
        const qs = new URLSearchParams(paramPairs).toString();
        finalUrl = `${finalUrl}${sep}${qs}`;
      }

      // Body custom (com variáveis) tem prioridade. Sem ele, payload legado.
      const customBody = readString(cfg, "body");
      let bodyStr: string | undefined;
      if (method === "GET" || method === "HEAD") {
        bodyStr = undefined;
      } else if (customBody && customBody.trim()) {
        bodyStr = interpolateWebhookString(customBody, root);
      } else {
        bodyStr = JSON.stringify({
          event: rt.event,
          contactId: rt.contactId ?? null,
          dealId: rt.dealId ?? null,
          data: rt.data,
        });
      }

      await assertSafeOutboundUrl(finalUrl);
      const res = await fetch(finalUrl, {
        method,
        headers: h,
        body: bodyStr,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`webhook: HTTP ${res.status}`);
      return {};
    }

    case "consume_stock":
    case "decrement_stock": {
      // Baixa de estoque OPT-IN: o operador adiciona este passo a uma
      // automação (ex.: gatilho `deal_won` ou entrada em estágio) para
      // reduzir o estoque dos produtos vinculados ao negócio. Só age em
      // produtos com `trackStock=true`. BLOQUEIA (lança erro) se faltar
      // estoque em qualquer item — não aplica baixa parcial nem deixa
      // o estoque negativo.
      let targetDealId = rt.dealId ?? readString(cfg, "dealId");
      if (!targetDealId && rt.contactId) {
        const openDeal = await prisma.deal.findFirst({
          where: { contactId: rt.contactId, status: "OPEN" },
          orderBy: { updatedAt: "desc" },
          select: { id: true },
        });
        targetDealId = openDeal?.id;
      }
      if (!targetDealId) throw new Error("consume_stock: dealId ausente no contexto");

      const items = await prisma.dealProduct.findMany({
        where: { dealId: targetDealId },
        select: {
          quantity: true,
          product: { select: { id: true, name: true, trackStock: true, stock: true } },
        },
      });

      const tracked = items.filter((it) => it.product.trackStock);
      if (tracked.length === 0) return {};

      // Pré-checagem de bloqueio: se algum produto não tem saldo, aborta
      // tudo antes de qualquer escrita.
      for (const it of tracked) {
        const need = Number(it.quantity);
        const have = Number(it.product.stock);
        if (have < need) {
          throw new Error(
            `consume_stock: estoque insuficiente para "${it.product.name}" (disponível ${have}, necessário ${need})`,
          );
        }
      }

      await prisma.$transaction(
        tracked.map((it) =>
          prisma.product.update({
            where: { id: it.product.id },
            data: { stock: { decrement: Number(it.quantity) } },
          }),
        ),
      );
      return {};
    }

    case "delay": {
      const ms = readNumber(cfg, "ms") ?? readNumber(cfg, "milliseconds") ?? 0;
      const waitMs = Math.max(0, Math.floor(ms));
      // 11/ago/26 — Delay longo NÃO pode ser setTimeout: segura um slot de
      // concorrência do worker por dias (incidente dna_work: 5 jobs do
      // "Follow-up de envio de vaga" c/ delay=7d travaram TODAS as
      // automações) e a espera morre a cada restart/deploy. Acima do
      // threshold persistimos a espera (contexto RUNNING + timeoutAt) —
      // o sweeper `sweepExpiredTimeouts` retoma no `nextStepId`.
      if (shouldPersistDelay(waitMs)) {
        const until = new Date(Date.now() + waitMs);
        const paused = await pauseAwaitingReply(cfg, rt, waitMs);
        return {
          ...paused,
          note: `aguardando até ${until.toISOString().replace("T", " ").slice(0, 16)} UTC`,
        };
      }
      await new Promise((r) => setTimeout(r, waitMs));
      return {};
    }

    case "condition": {
      // Multi-branch (estilo Kommo): avalia cada branch em ordem. A
      // primeira branch cujas `rules` TODAS baterem (AND) dispara o
      // caminho `branch.nextStepId`. Se nenhuma bater, usa `elseStepId`.
      const flowVars = (cfg as Record<string, unknown>)["__variables"] as Record<string, unknown> | undefined;
      const evalRoot: Record<string, unknown> = {
        // 27/mai/26 — `tags` e `tagIds` expostos no evalRoot a partir
        // dos arrays carregados em `resolveRuntimeContext`. Os ops
        // `has_tag`/`not_has_tag` esperam encontrar arrays — se o
        // contato não tiver tags, fica `[]`, o que faz `has_tag`
        // retornar false (correto). Sobrescrevemos depois do spread
        // pra garantir que campos com mesmo nome do Prisma não vencem.
        contact: rt.contact
          ? { ...rt.contact, tags: rt.contactTagNames, tagIds: rt.contactTagIds }
          : { tags: rt.contactTagNames, tagIds: rt.contactTagIds },
        // `rt.deal` já carrega `stageName`, `pipelineId` e `pipelineName`
        // em runtime (ver `resolveRuntimeContext`). As versões "por ID"
        // ficam disponíveis pra retrocompatibilidade, e os novos campos
        // "por nome" são o caminho preferido nas novas conditions.
        deal: rt.deal
          ? { ...rt.deal, tags: rt.dealTagNames, tagIds: rt.dealTagIds }
          : { tags: rt.dealTagNames, tagIds: rt.dealTagIds },
        conversation: rt.conversation ?? null,
        data: rt.data,
        event: rt.event,
        variables: flowVars ?? {},
        // Campos personalizados (slug → valor). Paths na UI:
        // `contactCustomFields.<name>` / `dealCustomFields.<name>`.
        contactCustomFields: rt.contactCustomFields ?? {},
        dealCustomFields: rt.dealCustomFields ?? {},
      };

      const conditionCfg = normalizeConditionConfig(cfg);
      for (const branch of conditionCfg.branches) {
        const allMatch = branch.rules.every((rule) => {
          let left = rule.field ? getByPath(evalRoot, rule.field) : undefined;

          // 27/mai/26 v2 — Para `has_tag`/`not_has_tag`, considera a
          // UNIÃO de tags de contato + deal independente do field
          // escolhido na UI (`contact.tags`, `deal.tags`, ou as versões
          // `.tagIds`). O step `add_tag` atual só persiste em
          // `TagOnContact`, então um operador que configura
          // `deal.tags has_tag "CLT"` esperando match na tag
          // recém-adicionada via fluxo nunca veria a condição bater.
          // União resolve o cenário-padrão sem exigir UI nova de
          // entity (contact vs deal) no step `add_tag`.
          if (
            (rule.op === "has_tag" || rule.op === "not_has_tag") &&
            (rule.field === "contact.tags" ||
              rule.field === "deal.tags" ||
              rule.field === "contact.tagIds" ||
              rule.field === "deal.tagIds")
          ) {
            const useIds = rule.field === "contact.tagIds" || rule.field === "deal.tagIds";
            left = useIds
              ? [...rt.contactTagIds, ...rt.dealTagIds]
              : [...rt.contactTagNames, ...rt.dealTagNames];
          }

          const rightRaw = rule.value;
          // Right pode ser string com {{variavel}} — mesmo interpolador
          // das mensagens (caminhos com ponto: contact.name, etc.).
          const right =
            typeof rightRaw === "string"
              ? interpolateContextVariables(rightRaw, rt, flowVars)
              : rightRaw;

          // ── Regra de expediente (independente de field) ─────────
          // Ops `in_business_hours` / `not_in_business_hours` esperam
          // `value` = JSON string com `{ schedule, timezone }` (mesma
          // forma do step `business_hours`). Curto-circuito antes de
          // `evalCondition` porque a comparação não é escalar.
          if (rule.op === "in_business_hours" || rule.op === "not_in_business_hours") {
            const isOpen = evaluateBusinessHoursValue(right);
            return rule.op === "in_business_hours" ? isOpen : !isOpen;
          }

          return evalCondition(left, rule.op, right);
        });
        if (allMatch) {
          if (branch.nextStepId) {
            return { skipRemaining: true, gotoStepId: branch.nextStepId };
          }
          // Branch bateu sem destino: para. Cair no linear dispara o
          // passo vizinho (mesmo bug do fallback steps[i+1]).
          return { skipRemaining: true };
        }
      }

      // Nenhuma branch bateu.
      if (conditionCfg.elseStepId) {
        return { skipRemaining: true, gotoStepId: conditionCfg.elseStepId };
      }
      return { skipRemaining: true };
    }

    case "round_robin": {
      // Estilo Kommo: NÃO atribui agente — só escolhe qual caminho do
      // fluxo seguir, em rodízio circular entre execuções da mesma
      // automação+step. Cursor persistido em AutomationRoundRobinState
      // (chave [automationId, stepId]); ver @/lib/automation-round-robin.
      const rrCfg = normalizeRoundRobinConfig(cfg);
      const options = rrCfg.options;
      const n = options.length;
      if (n === 0) return { skipRemaining: true };

      const rrStepId = (cfg as Record<string, unknown>).__stepId as string | undefined;
      if (!rrStepId) throw new Error("round_robin: __stepId ausente no contexto de execução");

      const signature = roundRobinOptionsSignature(options);

      const chosenIndex = await prisma.$transaction(async (tx) => {
        const existing = await tx.automationRoundRobinState.findUnique({
          where: { automationId_stepId: { automationId: rt.automationId, stepId: rrStepId } },
        });

        if (!existing) {
          await tx.automationRoundRobinState.create({
            data: withOrgFromCtx({
              automationId: rt.automationId,
              stepId: rrStepId,
              lastIndex: -1,
              optionsSignature: signature,
            }),
          });
        } else if (existing.optionsSignature !== signature) {
          // Lista de opções mudou (opção adicionada/removida) — reseta
          // a fila pro início, conforme o texto de ajuda do card.
          await tx.automationRoundRobinState.update({
            where: { automationId_stepId: { automationId: rt.automationId, stepId: rrStepId } },
            data: { lastIndex: -1, optionsSignature: signature },
          });
        }

        // UPDATE atômico: calcula o próximo índice em uma única
        // instrução (o UPDATE toma lock de linha no Postgres —
        // execuções concorrentes da mesma automação+step serializam
        // aqui em vez de lerem o mesmo lastIndex "velho").
        const rows = await tx.$queryRaw<{ lastIndex: number }[]>`
          UPDATE automation_round_robin_states
          SET "lastIndex" = ("lastIndex" + 1) % ${n}, "updatedAt" = NOW()
          WHERE "automationId" = ${rt.automationId} AND "stepId" = ${rrStepId}
          RETURNING "lastIndex"
        `;
        return rows[0]?.lastIndex ?? 0;
      });

      // Escolhe options[chosenIndex]. Sem "else" obrigatória: se a
      // opção sorteada não tiver destino, avança o cursor de LEITURA
      // (sem persistir) e tenta a próxima em ordem circular, no
      // máximo 1 volta completa. O `lastIndex` persistido fica no
      // índice ESCOLHIDO nesta execução (chosenIndex) independente de
      // qual destino tenha efetivamente sido usado.
      for (let i = 0; i < n; i++) {
        const opt = options[(chosenIndex + i) % n];
        if (opt.nextStepId) {
          return { skipRemaining: true, gotoStepId: opt.nextStepId };
        }
      }

      // Nenhuma opção tem destino configurado — encerra o ramo sem erro.
      return { skipRemaining: true };
    }

    case "update_lead_score": {
      const targetContactId = rt.contactId ?? readString(cfg, "contactId");
      if (!targetContactId) throw new Error("update_lead_score: contactId ausente");
      await updateContactScore(targetContactId);
      return {};
    }

    case "question": {
      if (!rt.contactId) throw new Error("question: contactId ausente");
      const content = readString(cfg, "content") ?? readString(cfg, "message") ?? "";
      log.debug(`Pergunta ao contato ${rt.contactId}: "${content.slice(0, 60)}"`);
      if (content) {
        const phoneRaw = rt.contact?.phone ?? "";
        const digits = phoneRaw.replace(/\D/g, "");
        const to = digits.length >= 8 ? digits : undefined;
        const recipient = rt.contact?.whatsappBsuid?.trim() || undefined;
        if (!to && !recipient) {
          throw new MetaSendFailureError(
            `question: sem destino — contato não tem telefone nem BSUID`,
          );
        }
        const vars = (cfg as Record<string, unknown>)["__variables"] as Record<string, unknown> | undefined;
        const interpolated = await interpolateMessageVariables(content, rt, vars);

        const questionChannelId = resolveOutboundChannelId(cfg, rt);
        const conv = await resolveAutomationSendConv(
          rt.contactId,
          sendConvOptsFromRt(rt, questionChannelId),
        );
        const questionMetaClient = await resolveAutomationMetaClient({
          automationId: rt.automationId,
          conversationId: conv?.id,
          contactId: rt.contactId ?? null,
          dealId: rt.dealId ?? null,
          channelId: questionChannelId,
        });
        rt.activeChannelId = questionChannelId;
        if (!questionMetaClient.configured) {
          throw new MetaSendFailureError(
            "question: nenhum canal META_CLOUD_API configurado para esta organização."
          );
        }
        let externalId: string | null = null;
        try {
          const sendResult = await questionMetaClient.sendText(to, interpolated, recipient);
          externalId = sendResult.messages?.[0]?.id ?? null;
        } catch (sendErr) {
          // Catch restrito à chamada Meta — erros de DB/SSE não viram fallback.
          const classified = toMetaSendFailure(sendErr);
          log.error(`Envio question falhou (contato=${rt.contactId}): ${classified.message}`);
          await persistFailedAutomationOutbound({
            conversationId: conv?.id,
            content: interpolated,
            messageType: "text",
            senderName: rt.automationName ?? "Automação",
            triggeredByName: rt.triggeredByName,
            error: classified,
            channelId: questionChannelId,
          });
          throw classified;
        }
        if (conv) {
          const saved = await prisma.message.create({
            data: withOrgFromCtx({ conversationId: conv.id, content: interpolated, direction: "out", messageType: "text", senderName: rt.automationName ?? "Automação", authorType: "bot", ...(rt.triggeredByName ? { triggeredByName: rt.triggeredByName } : {}), externalId, ...(questionChannelId ? { channelId: questionChannelId } : {}) }),
          });
          sseBus.publish("new_message", { organizationId: getOrgIdOrNull(), conversationId: conv.id, contactId: rt.contactId, direction: "out", content: interpolated });

          if (resolveFailureGotoStepId(cfg)) {
            await awaitMetaDeliveryVerdict(saved.id, "question");
          }
        }
      }
      const questionStepId = (cfg as Record<string, unknown>).__stepId as string | undefined;
      const questionTimeoutMs = readNumber(cfg, "timeoutMs");
      if (questionStepId && rt.contactId) {
        await persistPausedContext(rt, questionStepId, questionTimeoutMs);
      }
      return { skipRemaining: true };
    }

    case "wait_for_reply": {
      if (!rt.contactId) throw new Error("wait_for_reply: contactId ausente");
      const wfrStepId = (cfg as Record<string, unknown>).__stepId as string | undefined;
      const wfrTimeoutMs = readNumber(cfg, "timeoutMs");
      if (wfrStepId) {
        await persistPausedContext(rt, wfrStepId, wfrTimeoutMs);
      }
      log.debug(`Aguardando resposta do contato ${rt.contactId}`);
      return { skipRemaining: true };
    }

    case "set_variable": {
      const varName = readString(cfg, "name") ?? readString(cfg, "variableName");
      if (!varName) throw new Error("set_variable: name obrigatório");
      let varValue: unknown = cfg["value"] ?? "";
      if (typeof varValue === "string") {
        const vars = (cfg as Record<string, unknown>)["__variables"] as Record<string, unknown> | undefined;
        varValue = interpolateContextVariables(varValue, rt, vars);
      }
      if (rt.contactId) {
        const existingCtx = await getActiveContext(rt.automationId, rt.contactId);
        if (existingCtx) {
          const ctxVars = { ...(existingCtx.variables as Record<string, unknown>), [varName]: varValue };
          await advanceContext(existingCtx.id, existingCtx.currentStepId, ctxVars);
        }
      }
      return { setVariable: { name: varName, value: varValue } };
    }

    case "goto": {
      const targetStepId = readString(cfg, "targetStepId") ?? readString(cfg, "nextStepId");
      if (!targetStepId) throw new Error("goto: targetStepId obrigatório");
      return { skipRemaining: true, gotoStepId: targetStepId };
    }

    case "transfer_automation": {
      const targetId = readString(cfg, "targetAutomationId");
      if (!targetId) throw new Error("transfer_automation: automação destino não definida");

      if (rt.contactId) {
        const existingCtx = await getActiveContext(rt.automationId, rt.contactId);
        if (existingCtx) {
          await advanceContext(existingCtx.id, null, (existingCtx.variables as Record<string, unknown>) ?? {});
        }
      }

      log.info(`Transferindo automação ${rt.automationId} → ${targetId}`);

      const transferPayload: AutomationJobPayload = {
        automationId: targetId,
        context: {
          event: rt.event,
          contactId: rt.contactId ?? undefined,
          dealId: rt.dealId ?? undefined,
          data: rt.data,
          // Herda profundidade (+1) para o anti-loop de encadeamento.
          depth: (rt.depth ?? 0) + 1,
        },
      };

      // Em modo external vai para a fila `automation-jobs` (worker dedicado).
      // Em modo inline (dev), enqueueAutomationJob ainda executa direto —
      // sem setImmediate/runAutomationInline paralelo na API.
      const { enqueueAutomationJob } = await import("@/lib/queue");
      await enqueueAutomationJob(transferPayload);

      return { skipRemaining: true };
    }

    case "stop_automation": {
      if (rt.contactId) {
        const existingCtx = await getActiveContext(rt.automationId, rt.contactId);
        if (existingCtx) {
          await advanceContext(existingCtx.id, null, (existingCtx.variables as Record<string, unknown>) ?? {});
        }
      }
      log.debug(`Automação ${rt.automationId} interrompida`);
      return { skipRemaining: true };
    }

    case "finish": {
      if (rt.contactId) {
        const existingCtx = await getActiveContext(rt.automationId, rt.contactId);
        if (existingCtx) {
          await advanceContext(existingCtx.id, null, (existingCtx.variables as Record<string, unknown>) ?? {});
        }
      }
      return { skipRemaining: true };
    }

    case "create_deal": {
      if (!rt.contactId) throw new Error("create_deal: contactId ausente");
      const stageId = readString(cfg, "stageId");
      if (!stageId) throw new Error("create_deal: stageId obrigatório");
      // Título opcional: sem config → "Negócio {contato}"; senão "Negócio - #n".
      let rawTitle = readString(cfg, "title")?.trim() ?? "";
      if (!rawTitle && rt.contactId) {
        const contact = await prisma.contact.findFirst({
          where: { id: rt.contactId },
          select: { name: true },
        });
        rawTitle = defaultDealTitleForContact(contact?.name) ?? "";
      }
      const rawValue = readNumber(cfg, "value");
      const stage = await prisma.stage.findUnique({
        where: { id: stageId },
        select: { name: true, pipelineId: true, pipeline: { select: { name: true } } },
      });
      if (!stage) throw new Error("create_deal: stageId inválido");
      // `Deal.number` e mandatorio + unico por org. Aloca max+1 com retry
      // em P2002 (corrida concorrente). Mesmo padrao de services/deals.ts.
      let deal: Deal | null = null;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        const number = await nextDealNumber();
        const title = rawTitle || `Negócio - #${number}`;
        try {
          deal = await prisma.deal.create({
            data: withOrgFromCtx({
              number,
              title,
              contactId: rt.contactId,
              stageId,
              status: "OPEN" as const,
              ...(rawValue != null
                ? { value: new Prisma.Decimal(String(rawValue)) }
                : {}),
            }),
          });
          break;
        } catch (err) {
          lastErr = err;
          const isUnique =
            typeof err === "object" &&
            err !== null &&
            "code" in err &&
            (err as { code: string }).code === "P2002";
          if (!isUnique) throw err;
        }
      }
      if (!deal) {
        throw lastErr ?? new Error("Falha ao alocar Deal.number apos retries");
      }
      rt.dealId = deal.id;
      rt.deal = {
        ...(deal as Deal & { contactId: string | null }),
        stageName: stage.name,
        pipelineId: stage.pipelineId,
        pipelineName: stage.pipeline?.name ?? "",
      };
      return {};
    }

    case "finish_conversation": {
      await finishConversationsForContact(rt);
      return {};
    }

    case "tabulate_conversation": {
      if (!rt.contactId) return {};
      const closeToo = cfg.closeConversation !== false;
      const orgId = getOrgIdOrNull();
      const { resolveTabulationForStep } = await import("@/services/tabulations");
      const chosen = orgId
        ? await resolveTabulationForStep({
            organizationId: orgId,
            tabulationId: readString(cfg, "tabulationId"),
          }).catch(() => null)
        : null;

      // Tabulação apagada/desativada/movida depois de o fluxo ser montado: o
      // passo não derruba a execução. Se o encerramento estava junto, ele
      // acontece de todo jeito — só sem motivo gravado.
      if (!chosen) {
        log.warn(
          `tabulate_conversation: tabulação inválida ou ausente (${readString(cfg, "tabulationId") ?? "vazio"}) — segue sem tabular`,
        );
        if (closeToo) await finishConversationsForContact(rt);
        return {};
      }

      if (closeToo) {
        await finishConversationsForContact(rt, chosen);
        return {};
      }

      const convs = await prisma.conversation.findMany({
        where: { contactId: rt.contactId, status: { not: "RESOLVED" } },
        select: { id: true, externalId: true, organizationId: true },
      });
      for (const c of convs) {
        await prisma.conversation.update({
          where: { id: c.id },
          data: { tabulationId: chosen.tabulationId },
        });
        logTabulated(c, rt.contactId, chosen, {
          step: "tabulate_conversation",
        });
        try {
          const rowOrg = c.organizationId ?? orgId;
          if (rowOrg) {
            sseBus.publish("conversation_timeline_updated", {
              organizationId: rowOrg,
              conversationId: c.id,
              type: "CONVERSATION_TABULATED",
            });
          }
        } catch {
          /* best-effort */
        }
      }
      return {};
    }

    case "ask_ai_agent": {
      // Chama um agente de IA com o prompt configurado (interpolando
      // variáveis) e salva a resposta como variável de contexto pra
      // usar nos próximos passos (ex: condition, send_whatsapp_message).
      const agentId = readString(cfg, "agentId");
      if (!agentId) throw new Error("ask_ai_agent: agentId não configurado");
      const promptTemplate = readString(cfg, "promptTemplate") ?? "";
      const variableName = readString(cfg, "saveToVariable") ?? "ai_response";

      const vars = (cfg as Record<string, unknown>)["__variables"] as
        | Record<string, unknown>
        | undefined;
      const prompt = vars
        ? interpolateVariables(promptTemplate, vars)
        : promptTemplate;
      if (!prompt.trim()) throw new Error("ask_ai_agent: prompt vazio");

      // import dinâmico pra evitar ciclo (runner → prisma → services).
      const { runAgent } = await import("@/services/ai/runner");
      const openDeal = rt.contactId
        ? await prisma.deal.findFirst({
            where: { contactId: rt.contactId, status: "OPEN" },
            orderBy: { updatedAt: "desc" },
            select: { id: true },
          })
        : null;
      const conv = rt.contactId
        ? await prisma.conversation.findFirst({
            where: { contactId: rt.contactId, channel: "whatsapp" },
            orderBy: { updatedAt: "desc" },
            select: { id: true },
          })
        : null;

      const result = await runAgent({
        agentId,
        source: "automation",
        userMessage: prompt,
        conversationId: conv?.id ?? null,
        contactId: rt.contactId ?? null,
        dealId: openDeal?.id ?? null,
      });
      if (result.status === "FAILED") {
        throw new Error(`ask_ai_agent: ${result.error ?? "falha no agente"}`);
      }

      // Persiste a variável no contexto da automation (mesma lógica
      // usada por `set_variable`).
      if (rt.contactId) {
        const ctx = await getActiveContext(rt.automationId, rt.contactId);
        if (ctx) {
          const next = { ...((ctx.variables as Record<string, unknown>) ?? {}) };
          next[variableName] = result.text;
          await advanceContext(ctx.id, ctx.currentStepId, next);
        }
      }
      return {};
    }

    case "business_hours": {
      const isOpen = evaluateBusinessHoursValue({
        schedule: Array.isArray(cfg.schedule) ? cfg.schedule : [],
        timezone: readString(cfg, "timezone") ?? "America/Sao_Paulo",
      });
      if (!isOpen) {
        const elseStepId = readString(cfg, "elseStepId");
        if (elseStepId) return { skipRemaining: true, gotoStepId: elseStepId };
        return { skipRemaining: true };
      }
      return {};
    }

    case "check_agent_status": {
      // Disponível = AgentStatus.ONLINE do responsável da conversa.
      // Sem responsável, AWAY, OFFLINE ou sem registro → ramo Offline.
      const userId = await resolveConversationAssigneeId(rt);
      let online = false;
      if (userId) {
        const st = await prisma.agentStatus.findUnique({
          where: { userId },
          select: { status: true },
        });
        online = st?.status === "ONLINE";
      }
      if (!online) {
        const elseStepId = readString(cfg, "elseStepId");
        if (elseStepId) return { skipRemaining: true, gotoStepId: elseStepId };
        return { skipRemaining: true };
      }
      return {};
    }

    case "inventory.adjust":
    case "inventory_adjust": {
      // Ajuste de alocação via ledger novo (InventoryPool). Reusa o service
      // `inventory.ts` (transacional/auditado). NÃO toca o estoque legado
      // (`consume_stock`). Operações: consume | restock | reserve | release.
      // Resolve o pool por `poolId` explícito ou por `productId` (pool global).
      // `consume`/`reserve` lançam InsufficientInventoryError sem saldo —
      // o erro propaga e marca o passo como falho (bloqueante).
      const operation = (readString(cfg, "operation") ?? "consume").toLowerCase();
      const qty = Math.max(
        1,
        Math.floor(readNumber(cfg, "qty") ?? readNumber(cfg, "quantity") ?? 1),
      );

      let poolId = readString(cfg, "poolId");
      if (!poolId) {
        const productId = readString(cfg, "productId");
        if (!productId) {
          throw new Error("inventory.adjust: informe poolId ou productId");
        }
        const globalPool = await prisma.inventoryPool.findFirst({
          where: { productId, orgUnitId: null },
          select: { id: true },
        });
        const anyPool =
          globalPool ??
          (await prisma.inventoryPool.findFirst({
            where: { productId },
            select: { id: true },
          }));
        if (!anyPool) {
          throw new Error("inventory.adjust: nenhum pool encontrado para o produto");
        }
        poolId = anyPool.id;
      }

      const dealId = rt.dealId ?? readString(cfg, "dealId") ?? null;
      const inv = await import("@/services/inventory");
      if (operation === "restock") {
        await inv.restock({ poolId, qty, dealId, note: "Automação: reposição" });
      } else if (operation === "release") {
        await inv.release({ poolId, qty, dealId });
      } else if (operation === "reserve") {
        await inv.reserve({ poolId, qty, dealId });
      } else {
        await inv.consume({
          poolId,
          qty,
          reason: "SALE",
          dealId,
          note: "Automação: consumo",
        });
      }
      return {};
    }

    case "allocation.adjust":
    case "allocation_adjust": {
      // Passo agnóstico do catálogo por capacidades (PRD). Roteia pelo service
      // `allocation.ts` (fachada de inventory.ts) para que o alerta de saldo
      // baixo dispare. Operações: adjust (delta assinado) | consume | restock |
      // reserve | release. Resolve o pool por poolId ou productId (pool global).
      const operation = (readString(cfg, "operation") ?? "adjust").toLowerCase();

      let poolId = readString(cfg, "poolId");
      if (!poolId) {
        const productId = readString(cfg, "productId");
        if (!productId) {
          throw new Error("allocation.adjust: informe poolId ou productId");
        }
        const globalPool = await prisma.inventoryPool.findFirst({
          where: { productId, orgUnitId: null },
          select: { id: true },
        });
        const anyPool =
          globalPool ??
          (await prisma.inventoryPool.findFirst({
            where: { productId },
            select: { id: true },
          }));
        if (!anyPool) {
          throw new Error("allocation.adjust: nenhum pool encontrado para o produto");
        }
        poolId = anyPool.id;
      }

      const dealId = rt.dealId ?? readString(cfg, "dealId") ?? null;
      const alloc = await import("@/services/allocation");

      if (operation === "adjust") {
        const delta = Math.floor(readNumber(cfg, "delta") ?? 0);
        if (delta === 0) throw new Error("allocation.adjust: delta não pode ser 0");
        await alloc.adjust({ poolId, delta, dealId, note: "Automação: ajuste" });
        return {};
      }

      const qty = Math.max(
        1,
        Math.floor(readNumber(cfg, "qty") ?? readNumber(cfg, "quantity") ?? 1),
      );
      if (operation === "restock") {
        await alloc.restock({ poolId, qty, dealId, note: "Automação: reposição" });
      } else if (operation === "release") {
        await alloc.release({ poolId, qty, dealId });
      } else if (operation === "reserve") {
        await alloc.reserve({ poolId, qty, dealId });
      } else {
        await alloc.consume({
          poolId,
          qty,
          reason: "SALE",
          dealId,
          note: "Automação: consumo",
        });
      }
      return {};
    }

    case "stakeholder.notify":
    case "stakeholder_notify": {
      // Passo agnóstico: avalia StakeholderRule do produto para um evento e
      // notifica os papéis casados (PRD: capability stakeholders).
      const productId = readString(cfg, "productId");
      if (!productId) throw new Error("stakeholder.notify: informe productId");
      const event = readString(cfg, "event") ?? "STAGE_ENTERED";
      const subjectName = readString(cfg, "subjectName") ?? "Atualização";
      const processLabel = readString(cfg, "processLabel") ?? "Processo";
      const dealId = rt.dealId ?? readString(cfg, "dealId") ?? null;
      const svc = await import("@/services/stakeholder-notify");
      await svc.evaluateStakeholderRules({
        productId,
        event,
        subjectName,
        processLabel,
        dealId,
      });
      return {};
    }

    default:
      throw new Error(`Tipo de passo desconhecido: ${stepType}`);
  }
}

const WA_SEND_STEP_TYPES = new Set([
  "send_whatsapp_message",
  "send_whatsapp_template",
  "send_whatsapp_media",
  "send_whatsapp_interactive",
  "send_whatsapp_list",
  "send_whatsapp_flow",
  "send_product",
  "question",
]);

/** Passos que pausam o fluxo — no retry, se já SUCCESS, não continua linear. */
const RETRY_PAUSE_STEP_TYPES = new Set([
  "question",
  "send_whatsapp_interactive",
  "send_whatsapp_list",
  "send_whatsapp_flow",
  "wait_for_reply",
]);

/** Só roteiam — reexecutar no retry (sem efeito colateral). */
const RETRY_REROUTE_STEP_TYPES = new Set([
  "condition",
  "goto",
  "round_robin",
  "business_hours",
  "check_agent_status",
  "set_variable",
]);

async function loadRetryCompletedStepIds(
  automationId: string,
  contactId: string | null | undefined,
): Promise<Set<string>> {
  if (!contactId) return new Set();
  const lastStarted = await prisma.automationLog.findFirst({
    where: { automationId, contactId, status: "STARTED" },
    orderBy: { executedAt: "desc" },
    select: { executedAt: true },
  });
  if (!lastStarted) return new Set();
  const done = await prisma.automationLog.findMany({
    where: {
      automationId,
      contactId,
      status: "SUCCESS",
      stepId: { not: null },
      executedAt: { gte: lastStarted.executedAt },
    },
    select: { stepId: true },
  });
  return new Set(done.map((d) => d.stepId).filter((id): id is string => Boolean(id)));
}

const DEFAULT_TYPING_DELAY_MS = 2000;

function readHumanizeSettings(triggerConfig: unknown): {
  markAsRead: boolean;
  simulateTyping: boolean;
  typingDelayMs: number;
} {
  const tc = asRecord(triggerConfig) ?? {};
  return {
    markAsRead: tc.markAsRead === true,
    simulateTyping: tc.simulateTyping === true,
    typingDelayMs:
      typeof tc.typingDelayMs === "number" && tc.typingDelayMs > 0
        ? tc.typingDelayMs
        : DEFAULT_TYPING_DELAY_MS,
  };
}

async function getLastInboundWamid(contactId: string): Promise<string | null> {
  const conv = await prisma.conversation.findFirst({
    where: { contactId, channel: "whatsapp" },
    select: { id: true },
  });
  if (!conv) return null;
  const msg = await prisma.message.findFirst({
    where: { conversationId: conv.id, direction: "in", externalId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { externalId: true },
  });
  return msg?.externalId ?? null;
}

async function humanizeBeforeStep(
  stepType: string,
  humanize: { markAsRead: boolean; simulateTyping: boolean; typingDelayMs: number },
  wamid: string | null,
  metaClient: MetaWhatsAppClient
): Promise<void> {
  if (!WA_SEND_STEP_TYPES.has(stepType) || !wamid || !metaClient.configured) return;
  if (humanize.simulateTyping) {
    try {
      await metaClient.sendTypingIndicator(wamid);
      await new Promise((r) => setTimeout(r, humanize.typingDelayMs));
    } catch (err) {
      log.debug("Indicador de digitação falhou:", err instanceof Error ? err.message : err);
    }
  }
}

export async function runAutomationInline(payload: AutomationJobPayload): Promise<void> {
  const { automationId, context } = payload;
  const traceId = `at-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  log.debug(`▶ ${traceId} ${automationId} evento=${context.event} contato=${context.contactId ?? "—"}`);

  let automation;
  try {
    automation = await prisma.automation.findUnique({
      where: { id: automationId },
      include: { steps: { orderBy: { position: "asc" } } },
    });
  } catch (dbErr) {
    log.error(`[${traceId}] Erro ao carregar automação:`, dbErr);
    await logStep({
      automationId,
      contactId: context.contactId,
      dealId: context.dealId,
      status: "FAILED",
      message: `Erro ao carregar automação`,
      payload: inboundEventPayload(context.event, {}),
    });
    return;
  }

  if (!automation) {
    await logStep({
      automationId,
      contactId: context.contactId,
      dealId: context.dealId,
      status: "FAILED",
      message: `Automação não encontrada`,
      payload: inboundEventPayload(context.event, {}),
    });
    return;
  }

  if (!automation.active) {
    await logStep({
      automationId,
      contactId: context.contactId,
      dealId: context.dealId,
      status: "SKIPPED",
      message: `Automação inativa`,
      payload: inboundEventPayload(context.event, {}),
    });
    return;
  }

  const humanize = readHumanizeSettings(automation.triggerConfig);

  const contact = context.contactId
    ? await prisma.contact.findUnique({ where: { id: context.contactId }, select: { name: true, phone: true } })
    : null;
  const contactLabel = contact
    ? `${contact.name ?? "Contato"}${contact.phone ? ` (${contact.phone})` : ""}`
    : "—";

  const contextData = typeof context.data === "object" && context.data !== null
    ? context.data as Record<string, unknown>
    : {};

  const wamid =
    (typeof contextData.waMessageId === "string" ? contextData.waMessageId : null) ||
    (context.contactId ? await getLastInboundWamid(context.contactId) : null);

  const runChannelId =
    typeof contextData.channelId === "string" && contextData.channelId.trim()
      ? contextData.channelId.trim()
      : null;
  let runConvIdForMeta: string | undefined =
    typeof contextData.conversationId === "string" && contextData.conversationId.trim()
      ? contextData.conversationId.trim()
      : undefined;
  if (!runConvIdForMeta && context.contactId) {
    const c = await prisma.conversation.findFirst({
      where: { contactId: context.contactId, channel: "whatsapp" },
      select: { id: true },
    });
    runConvIdForMeta = c?.id;
  }
  const runMetaClient = await resolveAutomationMetaClient({
    automationId,
    conversationId: runConvIdForMeta,
    contactId: context.contactId ?? null,
    dealId: context.dealId ?? null,
    channelId: runChannelId,
  });

  if (humanize.markAsRead && wamid && runMetaClient.configured) {
    try {
      await runMetaClient.markAsRead(wamid);
    } catch (err) {
      log.debug("Falha ao marcar mensagem como lida:", err instanceof Error ? err.message : err);
    }
  }

  const metaWebhookEventId =
    typeof contextData.metaWebhookEventId === "string"
      ? contextData.metaWebhookEventId
      : null;

  // Antes do STARTED desta tentativa: SUCCESS da tentativa anterior.
  const completedOnPriorAttempt =
    (payload.attemptsMade ?? 0) > 0
      ? await loadRetryCompletedStepIds(automationId, context.contactId)
      : new Set<string>();

  await logStep({
    automationId,
    contactId: context.contactId,
    dealId: context.dealId,
    status: "STARTED",
    message: `${contactLabel} — ${triggerTypeLabel(context.event)}`,
    payload: inboundEventPayload(context.event, contextData, {
      contato: contact?.name ?? "Contato",
      ...(contact?.phone ? { telefone: contact.phone } : {}),
    }),
    metaWebhookEventId,
  });

  const rt = await resolveRuntimeContext(automationId, payload, automation.name);
  if (!rt) {
    await logStep({
      automationId,
      contactId: context.contactId,
      dealId: context.dealId,
      status: "FAILED",
      message: `Contato ou negócio não encontrado`,
      payload: inboundEventPayload(context.event, contextData),
    });
    return;
  }

  // A partir daqui qualquer escrita feita por executeStep/createDealEvent/
  // logEvent eh imputada a AUTOMATION (label = nome da automacao). Antes
  // ficava como SYSTEM ou herdava o ator do disparador (webhook/UI), o
  // que confundia o feed (mostrava o user humano que enviou a mensagem
  // como autor da troca de stage feita pelo bot).
  await runWithActor(
    {
      type: "AUTOMATION",
      label: automation.name,
      ref: automation.id,
    },
    async () => {

  let stepsFailed = 0;
  const stepById = new Map(automation.steps.map((s) => [s.id, s]));
  const NONE_ID = "__none__";
  const MAX_ITER = automation.steps.length * 2 + 10;

  let current: typeof automation.steps[0] | undefined = automation.steps[0];
  let iterations = 0;
  let flowVariables: Record<string, unknown> = {};
  // Quando o último step executado pausou o fluxo (skipRemaining), o
  // contexto recém-criado por pauseAwaitingReply precisa sobreviver ao
  // fim da execução — senão o clique/resposta do cliente cai no vazio.
  let pausedAtEnd = false;

  while (current && iterations < MAX_ITER) {
    iterations++;
    const step = current;
    const stepLabel = STEP_TYPE_LABELS[step.type] ?? step.type;
    const stepConfig = step.config as Record<string, unknown>;
    const enrichedConfig = { ...stepConfig, __stepId: step.id, __variables: flowVariables };
    const { __rfPos: _, __stepId: _s, nextStepId: _n, __hasExplicitEdges: _e, ...cleanConfig } = stepConfig;

    let result: StepResult;
    try {
      if (completedOnPriorAttempt.has(step.id) && !RETRY_REROUTE_STEP_TYPES.has(step.type)) {
        if (RETRY_PAUSE_STEP_TYPES.has(step.type)) {
          log.info(`[${traceId}] Retry: "${step.type}" já SUCCESS e pausa — não reexecuta`);
          pausedAtEnd = true;
          break;
        }
        if (step.type === "delay") {
          const delayMs = Number(stepConfig.ms ?? stepConfig.milliseconds ?? 0);
          if (shouldPersistDelay(Math.max(0, Math.floor(Number.isFinite(delayMs) ? delayMs : 0)))) {
            log.info(`[${traceId}] Retry: delay persistido já SUCCESS — não reexecuta`);
            pausedAtEnd = true;
            break;
          }
        }
        log.info(`[${traceId}] Retry: pulando "${step.type}" ${step.id} (já SUCCESS)`);
        result = {};
      } else {
      await humanizeBeforeStep(step.type, humanize, wamid, runMetaClient);

      // A origem (automação + nº do card) viaja pelo ALS para que TODO
      // evento de timeline escrito dentro do passo — inclusive os
      // gravados por services indiretos, como o motor da Distribuição
      // Inteligente — registre qual card causou a ação.
      result = await runWithAutomationOrigin(
        buildStepOrigin(rt, automation.name, step, automation.steps),
        () => executeStep(step.type, enrichedConfig, rt),
      );
      if (result.setVariable) {
        flowVariables = { ...flowVariables, [result.setVariable.name]: result.setVariable.value };
        rt.data = { ...rt.data, ...flowVariables };
      }
      // 27/mai/26 — Refresh das tags no `rt` após add_tag/remove_tag pra
      // que conditions subsequentes (no MESMO fluxo, sem wait_for_reply
      // no meio) enxerguem o estado atualizado. Antes o snapshot vinha
      // de `resolveRuntimeContext` e ficava stale, fazendo `has_tag`
      // sempre retornar false.
      if (step.type === "add_tag" || step.type === "remove_tag") {
        const snap = await loadAutomationTagSnapshot(rt.contactId, rt.dealId);
        rt.contactTagIds = snap.contactTagIds;
        rt.contactTagNames = snap.contactTagNames;
        rt.dealTagIds = snap.dealTagIds;
        rt.dealTagNames = snap.dealTagNames;
      }
      // 03/jun/26 — Mesmo motivo das tags: se um `update_field` mudou
      // um custom field (de contato ou negócio), um webhook subsequente
      // que use `{{contactCustomFields.<x>}}` precisa enxergar o valor
      // atualizado. Recarregamos só os custom fields (tags não mudam
      // aqui) pra evitar query desnecessária.
      if (step.type === "update_field") {
        const snap = await loadAutomationCustomFieldsSnapshot(
          rt.contactId,
          rt.dealId,
        );
        rt.contactCustomFields = snap.contactCustomFields;
        rt.dealCustomFields = snap.dealCustomFields;
      }
      await logStep({
        automationId,
        contactId: rt.contactId,
        dealId: rt.dealId,
        stepId: step.id,
        stepType: step.type,
        status: "SUCCESS",
        message: `${stepLabel} — ${result.note ?? "OK"}`,
        payload: cleanConfig,
      });
      if (result.skipRemaining && !result.gotoStepId) {
        pausedAtEnd = true;
        break;
      }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[${traceId}] Falha no step "${step.type}":`, msg);

      const sendFail =
        META_SEND_FAILURE_STEP_TYPES.has(step.type) ? classifyMetaSendFailure(err) : null;
      const failureGoto = sendFail ? resolveFailureGotoStepId(stepConfig) : null;
      if (sendFail && failureGoto && stepById.has(failureGoto)) {
        await logStep({
          automationId,
          contactId: rt.contactId,
          dealId: rt.dealId,
          stepId: step.id,
          stepType: step.type,
          status: "FAILED_HANDLED",
          message: `${stepLabel} — falha de envio (fallback): ${msg}`,
          payload: cleanConfig,
        });
        current = stepById.get(failureGoto);
        continue;
      }

      stepsFailed++;
      await logStep({
        automationId,
        contactId: rt.contactId,
        dealId: rt.dealId,
        stepId: step.id,
        stepType: step.type,
        status: "FAILED",
        message: `${stepLabel} — ${msg}`,
        payload: cleanConfig,
      });
      break;
    }

    if (result.gotoStepId && stepById.has(result.gotoStepId)) {
      current = stepById.get(result.gotoStepId);
      continue;
    }
    if (result.gotoStepId) {
      log.warn(`[${traceId}] Step "${step.type}" tem gotoStepId=${result.gotoStepId} inválido — fim de fluxo`);
      break;
    }

    const nid = typeof stepConfig.nextStepId === "string" ? stepConfig.nextStepId : null;
    if (nid === NONE_ID) break;
    if (nid && stepById.has(nid)) {
      current = stepById.get(nid);
    } else if (nid) {
      // nextStepId aponta pra step inexistente (foi apagado): para o fluxo
      // ao invés de cair na ordem da array (que poderia disparar passos
      // de outros ramos por engano).
      log.warn(`[${traceId}] Step "${step.type}" tem nextStepId=${nid} inválido — fim de fluxo`);
      break;
    } else {
      // Sem nextStepId definido: fallback linear é seguro só na primeira
      // execução (passos antigos pré-migration). Para evitar surpresas em
      // ramos paralelos, só cai pro próximo da array se o passo está em
      // posição linear (ainda não foi alvo de connect explícito).
      const hasExplicitEdges = stepConfig.__hasExplicitEdges === true;
      if (hasExplicitEdges) {
        log.debug(`[${traceId}] Step "${step.type}" sem nextStepId e __hasExplicitEdges — fim de ramo`);
        break;
      }
      const idx = automation.steps.indexOf(step);
      current = idx >= 0 ? automation.steps[idx + 1] : undefined;
    }
  }

  if (rt.contactId && !pausedAtEnd) {
    try {
      await closeStrandedContext(automationId, rt.contactId);
    } catch (err) {
      log.warn(
        `[${traceId}] closeStrandedContext falhou:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const status = stepsFailed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
  await logStep({
    automationId,
    contactId: rt.contactId,
    dealId: rt.dealId,
    status,
    message: stepsFailed > 0
      ? `${contactLabel} — finalizada com erros (${automation.steps.length} passos)`
      : `${contactLabel} — finalizada com sucesso (${automation.steps.length} passos)`,
    payload: inboundEventPayload(context.event, contextData),
    metaWebhookEventId,
  });

  if (rt.dealId) {
    createDealEvent(
      rt.dealId,
      null,
      "AUTOMATION_EXECUTED",
      {
        automationId,
        automationName: automation.name,
        event: context.event,
        stepsTotal: automation.steps.length,
        stepsFailed,
        status,
      },
      {
        type: "AUTOMATION",
        label: automation.name ? `Automação: ${automation.name}` : "Automação",
        ref: automationId,
      },
    ).catch(() => {});
  } else if (rt.contactId) {
    // Sem deal: ainda registramos no feed (/logs) pra dar visibilidade da
    // execução — importante para automações manuais disparadas pela conversa.
    logEvent({
      type: "AUTOMATION_EXECUTED",
      entityType: "CONTACT",
      entityId: rt.contactId,
      entityLabel: automation.name,
      contactId: rt.contactId,
      conversationId: rt.conversation?.id ?? null,
      meta: {
        automationId,
        automationName: automation.name,
        event: context.event,
        stepsTotal: automation.steps.length,
        stepsFailed,
        status,
      },
    }).catch(() => {});
  }

  // Disparo manual: NÃO postamos mais um card de status ("executada...") no
  // chat. As próprias mensagens enviadas pelos steps já são tagueadas com
  // `triggeredByName` (via withOrgFromCtx acima), então o inbox as exibe com
  // o selo "Manual" + avatar do agente que acionou (colab) — reproduzindo a
  // mensagem enviada, sem log redundante. Runs sem envio ao cliente ficam
  // visíveis apenas no activity log (AUTOMATION_EXECUTED).
    },
  );
}

const STEP_TYPE_LABELS: Record<string, string> = {
  send_email: "Enviar e-mail",
  move_stage: "Mover estágio",
  mark_deal_won: "Ganho",
  mark_deal_lost: "Perda",
  assign_owner: "Atribuir responsável",
  add_tag: "Adicionar tag",
  remove_tag: "Remover tag",
  update_field: "Atualizar campo",
  create_activity: "Criar atividade",
  send_whatsapp_message: "Mensagem WhatsApp",
  send_whatsapp_template: "Template WhatsApp",
  send_whatsapp_media: "Mídia WhatsApp",
  send_whatsapp_interactive: "Botões WhatsApp",
  send_whatsapp_list: "Lista WhatsApp",
  send_whatsapp_flow: "Formulário WhatsApp",
  send_product: "Enviar produto",
  webhook: "Webhook",
  delay: "Atraso",
  condition: "Condição",
  update_lead_score: "Lead score",
  question: "Pergunta ao lead",
  wait_for_reply: "Aguardar resposta",
  set_variable: "Definir variável",
  goto: "Ir para",
  finish: "Finalizar fluxo",
  create_deal: "Criar negócio",
  finish_conversation: "Encerrar conversa",
  tabulate_conversation: "Tabular conversa",
  business_hours: "Horário comercial",
  check_agent_status: "Status do agente",
  execute_distribution: "Executar distribuição",
};

export async function continueFromStep(
  automationId: string,
  contactId: string,
  fromStepId: string,
  variables: Record<string, unknown>
): Promise<void> {
  const automation = await prisma.automation.findUnique({
    where: { id: automationId },
    include: { steps: { orderBy: { position: "asc" } } },
  });
  if (!automation || !automation.active) return;

  const humanize = readHumanizeSettings(automation.triggerConfig);

  const fromIndex = automation.steps.findIndex((s) => s.id === fromStepId);
  if (fromIndex < 0) return;

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return;
  const contactLabel = contact
    ? `${contact.name ?? "Contato"}${contact.phone ? ` (${contact.phone})` : ""}`
    : contactId;

  const dealRaw = await prisma.deal.findFirst({
    where: { contactId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    include: {
      stage: { select: { name: true, pipelineId: true, pipeline: { select: { name: true } } } },
    },
  });
  const deal: DealWithNames | null = dealRaw
    ? (() => {
        const { stage, ...dealOnly } = dealRaw;
        return {
          ...(dealOnly as Deal & { contactId: string | null }),
          stageName: stage?.name ?? "",
          pipelineId: stage?.pipelineId ?? "",
          pipelineName: stage?.pipeline?.name ?? "",
        };
      })()
    : null;

  const conversation = await loadConversationSnapshot(contactId, variables);

  // 27/mai/26 — Carrega tags do contato e do deal pra que as conditions
  // com `has_tag`/`not_has_tag` enxerguem o estado atual. Antes,
  // `continueFromStep` montava o `rt` sem esses arrays e a condition
  // sempre caía no else (operador relatou: "selecionei CLT, condição
  // veio depois e foi ignorada").
  const tagSnapshot = await loadAutomationTagSnapshot(contactId, deal?.id);
  const customFieldsSnapshot = await loadAutomationCustomFieldsSnapshot(
    contactId,
    deal?.id,
  );

  const rt: RuntimeContext = {
    automationId,
    automationName: automation.name,
    contactId,
    dealId: deal?.id,
    event: "continue",
    data: variables,
    contact,
    deal,
    conversation,
    contactTagIds: tagSnapshot.contactTagIds,
    contactTagNames: tagSnapshot.contactTagNames,
    dealTagIds: tagSnapshot.dealTagIds,
    dealTagNames: tagSnapshot.dealTagNames,
    contactCustomFields: customFieldsSnapshot.contactCustomFields,
    dealCustomFields: customFieldsSnapshot.dealCustomFields,
    // Continuação após wait/question: mantém profundidade base (0). O
    // encadeamento relevante ocorre no fluxo principal (executeStep).
    depth: 0,
    // Canal do ticket/inbound que retomou o fluxo — não o último outbound
    // (podia ser outra conexão). Ver `loadLastAutomationChannelId`.
    activeChannelId: await loadLastAutomationChannelId(contactId, {
      conversationId:
        conversation?.id ??
        (typeof variables.conversationId === "string"
          ? variables.conversationId
          : null),
      channelId:
        (typeof variables.channelId === "string" ? variables.channelId : null) ??
        conversation?.channelId ??
        null,
    }),
  };

  const contChannelId =
    (typeof variables.channelId === "string" && variables.channelId.trim()
      ? variables.channelId.trim()
      : null) ?? conversation?.channelId ?? null;
  let contConvIdForMeta: string | undefined = conversation?.id;
  if (!contConvIdForMeta) {
    const c = await prisma.conversation.findFirst({
      where: { contactId, channel: "whatsapp" },
      select: { id: true },
    });
    contConvIdForMeta = c?.id;
  }
  const contMetaClient = await resolveAutomationMetaClient({
    automationId,
    conversationId: contConvIdForMeta,
    contactId,
    dealId: deal?.id ?? null,
    channelId: contChannelId,
  });

  const wamidForRead = await getLastInboundWamid(contactId);
  if (humanize.markAsRead && wamidForRead && contMetaClient.configured) {
    try {
      await contMetaClient.markAsRead(wamidForRead);
    } catch (err) {
      log.debug("Falha ao marcar mensagem como lida (continuação):", err instanceof Error ? err.message : err);
    }
  }

  await logStep({
    automationId,
    contactId,
    dealId: deal?.id,
    status: "STARTED",
    message: `${contactLabel} — continuando fluxo`,
    payload: inboundEventPayload("continue", {
      ...(contChannelId ? { channelId: contChannelId } : {}),
    }),
  });

  // Continuacao tambem roda como AUTOMATION (mesmo motivo do runAutomationInline).
  await runWithActor(
    { type: "AUTOMATION", label: automation.name, ref: automation.id },
    async () => {

  const stepById = new Map(automation.steps.map((s) => [s.id, s]));
  const NONE_ID = "__none__";
  const MAX_ITER = automation.steps.length * 2 + 10;

  let current: typeof automation.steps[0] | undefined = automation.steps[fromIndex];
  let iterations = 0;
  let flowVariables: Record<string, unknown> = { ...variables };

  while (current && iterations < MAX_ITER) {
    iterations++;
    const step = current;
    const stepLabel = STEP_TYPE_LABELS[step.type] ?? step.type;
    const stepConfig = {
      ...(step.config as Record<string, unknown>),
      __stepId: step.id,
      __variables: flowVariables,
    };

    const wamid = await getLastInboundWamid(contactId);
    await humanizeBeforeStep(step.type, humanize, wamid, contMetaClient);

    let result: StepResult;
    try {
      result = await runWithAutomationOrigin(
        buildStepOrigin(rt, automation.name, step, automation.steps),
        () => executeStep(step.type, stepConfig, rt),
      );
      if (result.setVariable) {
        flowVariables = { ...flowVariables, [result.setVariable.name]: result.setVariable.value };
        rt.data = { ...rt.data, ...flowVariables };
      }
      if (step.type === "add_tag" || step.type === "remove_tag") {
        const snap = await loadAutomationTagSnapshot(rt.contactId, rt.dealId);
        rt.contactTagIds = snap.contactTagIds;
        rt.contactTagNames = snap.contactTagNames;
        rt.dealTagIds = snap.dealTagIds;
        rt.dealTagNames = snap.dealTagNames;
      }
      if (step.type === "update_field") {
        const snap = await loadAutomationCustomFieldsSnapshot(
          rt.contactId,
          rt.dealId,
        );
        rt.contactCustomFields = snap.contactCustomFields;
        rt.dealCustomFields = snap.dealCustomFields;
      }
      await logStep({
        automationId,
        contactId,
        dealId: deal?.id,
        stepId: step.id,
        stepType: step.type,
        status: "SUCCESS",
        message: `${stepLabel} — ${result.note ?? "OK"}`,
      });
      if (result.skipRemaining && !result.gotoStepId) {
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const baseCfgForFail = step.config as Record<string, unknown>;
      const sendFail =
        META_SEND_FAILURE_STEP_TYPES.has(step.type) ? classifyMetaSendFailure(err) : null;
      const failureGoto = sendFail ? resolveFailureGotoStepId(baseCfgForFail) : null;
      if (sendFail && failureGoto && stepById.has(failureGoto)) {
        await logStep({
          automationId,
          contactId,
          dealId: deal?.id,
          stepId: step.id,
          stepType: step.type,
          status: "FAILED_HANDLED",
          message: `${stepLabel} — falha de envio (fallback): ${msg}`,
        });
        current = stepById.get(failureGoto);
        continue;
      }
      await logStep({
        automationId,
        contactId,
        dealId: deal?.id,
        stepId: step.id,
        stepType: step.type,
        status: "FAILED",
        message: `${stepLabel} — ${msg}`,
      });
      break;
    }

    if (result.gotoStepId && stepById.has(result.gotoStepId)) {
      current = stepById.get(result.gotoStepId);
      continue;
    }
    if (result.gotoStepId) {
      log.warn(`continueFromStep: step "${step.type}" tem gotoStepId=${result.gotoStepId} inválido — fim`);
      break;
    }

    const baseCfg = step.config as Record<string, unknown>;
    const nid = typeof baseCfg.nextStepId === "string" ? baseCfg.nextStepId : null;
    if (nid === NONE_ID) break;
    if (nid && stepById.has(nid)) {
      current = stepById.get(nid);
    } else if (nid) {
      log.warn(`continueFromStep: step "${step.type}" tem nextStepId=${nid} inválido — fim`);
      break;
    } else {
      // Sem nextStepId: continueFromStep está no meio de um ramo
      // (chegou aqui via wait_for_reply/question/buttons). Cair pra
      // automation.steps[idx+1] aqui pode disparar o passo do RAMO
      // VIZINHO por engano — então só seguimos se o step estiver
      // explicitamente sem __hasExplicitEdges (legado pré-migration).
      const hasExplicitEdges = baseCfg.__hasExplicitEdges === true;
      if (hasExplicitEdges) break;
      const idx = automation.steps.indexOf(step);
      current = idx >= 0 ? automation.steps[idx + 1] : undefined;
    }
  }

  // 12/ago/26 — closeStrandedContext roda INCONDICIONALMENTE ao fim da
  // continuação. O guard `contPausedAtEnd` deixava vazar o contexto quando
  // o fluxo terminava num step que retorna skipRemaining SEM persistir
  // espera (condition sem branch casada e sem else, round_robin sem
  // destino, business_hours fechado sem else): RUNNING eterno sem timer,
  // segurando a trava de reentrada do contato. Esperas legítimas não são
  // afetadas — toda pausa real persiste currentStepId pausante
  // (question/wait_for_reply/interactive/list/template/send c/ "Sem
  // resposta") ou timeoutAt (delay persistido) ANTES de retornar
  // skipRemaining, e closeStrandedContext recusa o fechamento nesses
  // casos (PAUSING_STEP_TYPES + isDelayWait).
  try {
    await closeStrandedContext(automationId, contactId);
  } catch (err) {
    log.warn(
      `continueFromStep closeStrandedContext falhou:`,
      err instanceof Error ? err.message : err,
    );
  }

  await logStep({
    automationId,
    contactId,
    dealId: deal?.id,
    status: "COMPLETED",
    message: `${contactLabel} — finalizada com sucesso`,
    payload: inboundEventPayload("continue", {
      ...(contChannelId ? { channelId: contChannelId } : {}),
    }),
  });

  if (deal?.id) {
    createDealEvent(
      deal.id,
      null,
      "AUTOMATION_EXECUTED",
      {
        automationId,
        automationName: automation.name,
        event: "continue",
        stepsTotal: automation.steps.length,
        status: "COMPLETED",
      },
      {
        type: "AUTOMATION",
        label: automation.name ? `Automação: ${automation.name}` : "Automação",
        ref: automationId,
      },
    ).catch(() => {});
  }
    },
  );
}
