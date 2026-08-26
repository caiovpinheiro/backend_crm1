import type { Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
// prismaBase + withSystemContext usados apenas em sweepExpiredTimeouts
// (cross-tenant). Os outros helpers deste arquivo sao chamados de
// API routes / webhooks que ja tem contexto montado.
import { prismaBase } from "@/lib/prisma-base";
import { sseBus } from "@/lib/sse-bus";
import { withSystemContext } from "@/lib/webhook-context";

const log = getLogger("automation-context");

/**
 * Notifica o inbox (SSE `automation_state`) que o conjunto de automações
 * ativas de um contato mudou — o frontend invalida o cache do chip
 * "robô em execução". Best-effort: nunca derruba o fluxo da automação.
 */
function publishAutomationState(row: {
  organizationId?: string | null;
  contactId?: string | null;
  automationId?: string | null;
  status?: string | null;
}) {
  if (!row?.contactId || !row.organizationId) return;
  try {
    sseBus.publish("automation_state", {
      organizationId: row.organizationId,
      contactId: row.contactId,
      automationId: row.automationId ?? null,
      status: row.status ?? null,
    });
  } catch {
    /* best-effort */
  }
}

function readNumber(cfg: unknown, key: string): number | undefined {
  if (!cfg || typeof cfg !== "object") return undefined;
  const v = (cfg as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Tipos de step que PAUSAM o fluxo aguardando próxima mensagem do contato.
 * Ao TRANSICIONAR pra um deles via processIncomingMessage, precisamos:
 *  1. Setar `currentStepId = step.id`
 *  2. Setar `timeoutAt` se o step tem `timeoutMs` configurado (cronômetro)
 *  3. NÃO chamar continueFromStep (esses steps pausam o fluxo)
 */
export const PAUSING_STEP_TYPES = new Set([
  "question",
  "send_whatsapp_interactive",
  "send_whatsapp_list",
  "send_whatsapp_template",
  "send_whatsapp_message",
  "wait_for_reply",
]);

/** Marcador de "fim de ramo" gravado pelo canvas em saídas não conectadas. */
const NONE_STEP_ID = "__none__";

/**
 * `true` quando o step veio do editor de canvas com as saídas desenhadas à
 * mão. Nesses steps NUNCA caímos no fallback linear (`steps[index + 1]`):
 * `automation.steps` está ordenado por `position`, que é ordem de CRIAÇÃO
 * no canvas e não do fluxo — em automações ramificadas o "próximo da array"
 * pertence a outro ramo.
 *
 * Mesma guarda que `automation-executor.ts` já aplica nos dois loops de
 * execução. Aqui ela cobre os pontos de RETOMADA (resposta do cliente e
 * timeout), que era por onde o bug escapava.
 */
export function hasExplicitEdges(config: unknown): boolean {
  return (
    config !== null &&
    typeof config === "object" &&
    (config as Record<string, unknown>).__hasExplicitEdges === true
  );
}

/**
 * Próximo step por POSIÇÃO na array. Só é permitido em automações legadas
 * (pré-canvas, sem `__hasExplicitEdges`); nas demais devolve `null` para o
 * chamador tratar como fim de ramo.
 */
export function linearFallbackStepId(
  steps: { id: string; config: unknown }[],
  currentStepId: string,
): string | null {
  const idx = steps.findIndex((s) => s.id === currentStepId);
  if (idx < 0) return null;
  if (hasExplicitEdges(steps[idx].config)) return null;
  return steps[idx + 1]?.id ?? null;
}

/** Lê uma referência de step do config, tratando `""`/`__none__` como ausente. */
export function readStepRef(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const v = (config as Record<string, unknown>)[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed || trimmed === NONE_STEP_ID) return null;
  return trimmed;
}

/**
 * Teto para o step `delay` rodar inline (setTimeout) no worker. Acima
 * disso a espera é persistida (contexto RUNNING + `timeoutAt`) e retomada
 * pelo `sweepExpiredTimeouts` — delays longos não seguram slot de
 * concorrência nem morrem com restart/deploy (incidente 11/ago/26:
 * delay de 7d do "Follow-up de envio de vaga" congelou os 5 slots do
 * worker-automations e parou TODAS as automações).
 */
export const DELAY_INLINE_MAX_MS = Math.max(
  0,
  Number(process.env.AUTOMATION_DELAY_INLINE_MAX_MS ?? 30_000),
);

export function shouldPersistDelay(waitMs: number, inlineMax = DELAY_INLINE_MAX_MS): boolean {
  return waitMs > inlineMax;
}

const PAUSED_CONTEXT_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;

/**
 * TTL de segurança para step pausante SEM `timeoutMs` do autor do fluxo.
 *
 * Sem `timeoutAt` o contexto fica RUNNING para sempre — `sweepExpiredTimeouts`
 * só varre `timeoutAt IS NOT NULL`. Isso trava o re-disparo da automação para
 * o contato E o 1º atendimento da IA, que sai em
 * `first_attendance_skip_automation_waiting` enquanto houver contexto ativo
 * (caso Juliana, 24/ago/26: template "BV - CALOUROS" com botões e sem
 * timeout configurado).
 *
 * `AUTOMATION_PAUSED_CONTEXT_TTL_MS=0` desliga.
 */
export const PAUSED_CONTEXT_TTL_MS = (() => {
  // Var vazia no painel (`AUTOMATION_PAUSED_CONTEXT_TTL_MS=`) tem que cair no
  // default — `Number("")` é 0, que desligaria o TTL sem ninguém pedir.
  const raw = process.env.AUTOMATION_PAUSED_CONTEXT_TTL_MS?.trim();
  if (!raw) return PAUSED_CONTEXT_TTL_DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return PAUSED_CONTEXT_TTL_DEFAULT_MS;
  return parsed;
})();

/**
 * Marca, nas variáveis do contexto, que o `timeoutAt` do step atual veio do
 * TTL e não do canvas. `processTimeout` usa isso para só ENCERRAR o contexto,
 * sem seguir `timeoutGotoStepId`/fallback linear — o autor nunca configurou
 * um timeout ali, então disparar um ramo seria inventar comportamento.
 */
const PAUSED_TTL_VAR = "__pausedTtlStepId";

function usesPausedTtl(explicitTimeoutMs: number | undefined): boolean {
  if (explicitTimeoutMs && explicitTimeoutMs > 0) return false;
  return PAUSED_CONTEXT_TTL_MS > 0;
}

/** `timeoutAt` de um step pausante: o do autor; senão o TTL de segurança. */
export function pausedStepTimeoutMs(
  explicitTimeoutMs: number | undefined,
): number | undefined {
  if (explicitTimeoutMs && explicitTimeoutMs > 0) return explicitTimeoutMs;
  return PAUSED_CONTEXT_TTL_MS > 0 ? PAUSED_CONTEXT_TTL_MS : undefined;
}

/** Grava/limpa o marcador de TTL sintético nas variáveis do contexto. */
export function markPausedTtl(
  variables: Record<string, unknown>,
  stepId: string,
  explicitTimeoutMs: number | undefined,
): Record<string, unknown> {
  const next = { ...variables };
  if (usesPausedTtl(explicitTimeoutMs)) next[PAUSED_TTL_VAR] = stepId;
  else delete next[PAUSED_TTL_VAR];
  return next;
}

/** `true` se o `timeoutAt` que acabou de expirar foi armado pelo TTL. */
function timeoutCameFromTtl(
  variables: Record<string, unknown>,
  currentStepId: string,
): boolean {
  return variables[PAUSED_TTL_VAR] === currentStepId;
}

export type InteractiveOption = {
  text?: string;
  title?: string;
  id?: string;
  gotoStepId?: string;
  kind?: string;
  flowDefinitionId?: string;
  flowCta?: string;
};

export const AWAITING_FLOW_VAR = "__awaitingFlow";

export type AwaitingFlowState = {
  stepId: string;
  buttonId: string;
  flowToken: string;
  gotoStepId?: string;
};

export function readAwaitingFlow(variables: Record<string, unknown>): AwaitingFlowState | null {
  const raw = variables[AWAITING_FLOW_VAR];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const stepId = typeof o.stepId === "string" ? o.stepId.trim() : "";
  const buttonId = typeof o.buttonId === "string" ? o.buttonId.trim() : "";
  const flowToken = typeof o.flowToken === "string" ? o.flowToken.trim() : "";
  if (!stepId || !buttonId || !flowToken) return null;
  const gotoStepId = typeof o.gotoStepId === "string" ? o.gotoStepId.trim() : "";
  return { stepId, buttonId, flowToken, ...(gotoStepId ? { gotoStepId } : {}) };
}

export function interactiveButtonId(b: InteractiveOption, idx: number): string {
  return (b.id || "").trim() || `btn_${idx}`;
}

export type InteractiveMenuDecision =
  | { action: "complete_flow"; buttonId: string }
  | { action: "goto_button"; button: InteractiveOption }
  | { action: "stay" }
  | { action: "no_match" };

/**
 * Decide o que fazer com um inbound enquanto o passo espera botões/lista.
 * nfm_reply não pode cair em "Outra resposta" se já houver um Flow aberto.
 */
export function decideInteractiveMenuInbound(input: {
  buttons: InteractiveOption[];
  messageContent: string;
  interactiveId?: string | null;
  flowReply?: boolean;
  flowToken?: string | null;
  awaitingFlow?: AwaitingFlowState | null;
}): InteractiveMenuDecision {
  const awaiting = input.awaitingFlow;
  const inboundToken = (input.flowToken ?? "").trim();
  if (awaiting && input.flowReply) {
    if (!inboundToken || inboundToken === awaiting.flowToken) {
      return { action: "complete_flow", buttonId: awaiting.buttonId };
    }
    return { action: "stay" };
  }

  const matched = matchInteractiveOption(
    input.buttons,
    input.messageContent,
    input.interactiveId,
  );
  if (matched) {
    return { action: "goto_button", button: matched };
  }

  return { action: "no_match" };
}

/** Clique de botão/lista ou nfm_reply deve retomar menu pausado mesmo com humano atendendo. */
export function shouldResumePausedMenuDespiteHumanAttendance(opts?: {
  interactiveId?: string | null;
  flowReply?: boolean;
}): boolean {
  return Boolean(opts?.flowReply || (opts?.interactiveId ?? "").trim());
}

/**
 * Casa resposta de botão/lista com a opção do config.
 * O executor envia `b.id || btn_${i}` / `r.id || row_${i}` (0-based) — quando
 * o JSON salvo não tem `id`, o `list_reply.id`/`button_reply.id` ainda casa
 * pelo fallback de índice.
 */
export function matchInteractiveOption(
  options: InteractiveOption[],
  messageContent: string,
  interactiveId?: string | null,
): InteractiveOption | undefined {
  const normalized = messageContent.trim().toLowerCase();
  const firstLine = normalized.split(/\r?\n/, 1)[0]?.trim() ?? normalized;
  const idNorm = (interactiveId ?? "").trim().toLowerCase();
  return options.find((b, idx) => {
    const label = (b.title || b.text || "").trim().toLowerCase();
    const btnId = (b.id || "").trim().toLowerCase();
    // Ids efetivos iguais aos gerados em automation-executor.ts
    const effectiveRowId = (btnId || `row_${idx}`).toLowerCase();
    const effectiveBtnId = (btnId || `btn_${idx}`).toLowerCase();
    return (
      (label && (label === normalized || label === firstLine)) ||
      (btnId && btnId === normalized) ||
      (idNorm && btnId && btnId === idNorm) ||
      (idNorm && (idNorm === effectiveRowId || idNorm === effectiveBtnId)) ||
      (!btnId &&
        idNorm &&
        (idNorm === `row_${idx}` || idNorm === `btn_${idx}`))
    );
  });
}

const GENERIC_BTN_ID = /^(btn|row)_\d+$/i;

function optionLabel(b: InteractiveOption): string {
  return (b.title || b.text || "").trim().toLowerCase();
}

/** Meta corta título de botão interativo em 20 chars — compara nessa janela. */
function titlesEquivalent(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.slice(0, 20) === b.slice(0, 20);
}

export function buttonsFromStepConfig(config: unknown): InteractiveOption[] {
  if (!config || typeof config !== "object") return [];
  const cfg = config as Record<string, unknown>;
  const fromButtons = Array.isArray(cfg.buttons) ? (cfg.buttons as InteractiveOption[]) : [];
  const fromRows = Array.isArray(cfg.rows) ? (cfg.rows as InteractiveOption[]) : [];
  return fromButtons.length > 0 ? fromButtons : fromRows;
}

/**
 * WhatsApp não desativa botões de mensagens anteriores. O aluno clica
 * "Receber dados de acesso" do welcome enquanto o robô espera o menu do
 * curso — o passo atual não casa e o else pede "clique numa opção".
 *
 * Procura o botão no resto da automação: id explícito (não btn_N genérico)
 * ou título único. Título repetido sem id distintivo não adivinha.
 */
export function matchStaleInteractiveOption(
  steps: { id: string; config: unknown }[],
  currentStepId: string,
  messageContent: string,
  interactiveId?: string | null,
): InteractiveOption | undefined {
  const catalog: InteractiveOption[] = [];
  for (const step of steps) {
    if (step.id === currentStepId) continue;
    catalog.push(...buttonsFromStepConfig(step.config));
  }
  if (catalog.length === 0) return undefined;

  const idNorm = (interactiveId ?? "").trim().toLowerCase();
  if (idNorm && !GENERIC_BTN_ID.test(idNorm)) {
    const byId = catalog.filter((b) => (b.id || "").trim().toLowerCase() === idNorm);
    if (byId.length === 1) return byId[0];
  }

  const needle = messageContent.trim().toLowerCase().split(/\r?\n/, 1)[0] ?? "";
  if (!needle) return undefined;
  const byTitle = catalog.filter((b) => titlesEquivalent(optionLabel(b), needle));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1 && idNorm) {
    const byTitleAndId = byTitle.filter((b) => (b.id || "").trim().toLowerCase() === idNorm);
    if (byTitleAndId.length === 1) return byTitleAndId[0];
  }
  return undefined;
}

export async function getActiveContext(automationId: string, contactId: string) {
  return prisma.automationContext.findFirst({
    where: {
      automationId,
      contactId,
      status: "RUNNING",
    },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Fecha contexto RUNNING órfão ao fim da execução do motor.
 * Não toca contextos parados em passo pausante (espera legítima de resposta).
 */
export async function closeStrandedContext(automationId: string, contactId: string) {
  const ctx = await getActiveContext(automationId, contactId);
  if (!ctx) return null;

  if (ctx.currentStepId) {
    const step = await prisma.automationStep.findUnique({
      where: { id: ctx.currentStepId },
      select: { type: true },
    });
    // `delay` persistido também é espera legítima (cronômetro via
    // `timeoutAt`) — fechar aqui mataria a retomada pelo sweeper.
    const isDelayWait = step?.type === "delay" && ctx.timeoutAt !== null;
    // send_whatsapp_message (texto puro) só "pausa" via humanize — sempre
    // com timeoutAt armado. RUNNING nesse step SEM timer = ponteiro stale
    // de uma continuação que já passou do step (o motor não avança
    // currentStepId a cada step executado em memória). Sem este recorte o
    // contexto vazava RUNNING pra sempre e a trava de reentrada impedia a
    // automação de re-disparar pro contato (bug "Aguardando Resposta
    // parou de funcionar", ago/2026 — 869 contextos vazados).
    const isStalePlainSend =
      step?.type === "send_whatsapp_message" && ctx.timeoutAt === null;
    if (
      step &&
      (PAUSING_STEP_TYPES.has(step.type) || isDelayWait) &&
      !isStalePlainSend
    ) {
      return null;
    }
  }

  const row = await prisma.automationContext.update({
    where: { id: ctx.id },
    data: { status: "COMPLETED", currentStepId: null, timeoutAt: null },
  });
  publishAutomationState(row);
  return row;
}

export async function createContext(
  automationId: string,
  contactId: string,
  firstStepId: string,
  timeoutMs?: number,
  initialVariables?: Record<string, unknown>,
) {
  const row = await prisma.automationContext.create({
    data: withOrgFromCtx({
      automationId,
      contactId,
      currentStepId: firstStepId,
      variables: (initialVariables ?? {}) as Prisma.InputJsonValue,
      status: "RUNNING" as const,
      timeoutAt: timeoutMs && timeoutMs > 0 ? new Date(Date.now() + timeoutMs) : null,
    }),
  });
  publishAutomationState(row);
  return row;
}

export async function advanceContext(
  contextId: string,
  nextStepId: string | null,
  variables: Record<string, unknown>,
  timeoutMs?: number,
) {
  const vars = variables as Prisma.InputJsonValue;

  if (!nextStepId) {
    const done = await prisma.automationContext.update({
      where: { id: contextId },
      data: { status: "COMPLETED", variables: vars, currentStepId: null, timeoutAt: null },
    });
    publishAutomationState(done);
    return done;
  }

  const advanced = await prisma.automationContext.update({
    where: { id: contextId },
    data: {
      currentStepId: nextStepId,
      variables: vars,
      timeoutAt: timeoutMs && timeoutMs > 0 ? new Date(Date.now() + timeoutMs) : null,
    },
  });
  publishAutomationState(advanced);
  return advanced;
}

export async function pauseContext(contextId: string) {
  const row = await prisma.automationContext.update({
    where: { id: contextId },
    data: { status: "PAUSED" },
  });
  publishAutomationState(row);
  return row;
}

/**
 * Interrompe manualmente um fluxo (robô) — acionado pelo operador via
 * inbox/deal ("Interromper robô"). Só age em contextos vivos
 * (RUNNING/PAUSED); marca como COMPLETED, limpa step/cronômetro e
 * publica `automation_state` pra sumir da lista de robôs ativos.
 * Retorna null se o contexto não existir ou já não estiver vivo.
 */
export async function cancelContext(contextId: string) {
  const ctx = await prisma.automationContext.findUnique({
    where: { id: contextId },
    select: { id: true, status: true },
  });
  if (!ctx || (ctx.status !== "RUNNING" && ctx.status !== "PAUSED")) {
    return null;
  }
  const row = await prisma.automationContext.update({
    where: { id: contextId },
    data: { status: "COMPLETED", currentStepId: null, timeoutAt: null },
  });
  publishAutomationState(row);
  return row;
}

/** Cancela todos os contextos RUNNING/PAUSED do contato (humano assumiu). */
export async function cancelActiveContextsForContact(
  contactId: string,
): Promise<number> {
  const active = await getContactActiveContexts(contactId);
  let n = 0;
  for (const ctx of active) {
    const row = await cancelContext(ctx.id);
    if (row) n += 1;
  }
  if (n > 0) {
    log.info(
      `cancelActiveContextsForContact contact=${contactId} cancelled=${n}`,
    );
  }
  return n;
}

export async function timeoutContext(contextId: string) {
  const row = await prisma.automationContext.update({
    where: { id: contextId },
    data: { status: "TIMED_OUT", timeoutAt: null },
  });
  publishAutomationState(row);
  return row;
}

export async function getContactActiveContexts(contactId: string) {
  return prisma.automationContext.findMany({
    where: { contactId, status: { in: ["RUNNING", "PAUSED"] } },
    include: {
      automation: { select: { id: true, name: true, steps: { orderBy: { position: "asc" } } } },
    },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Histórico de execuções ENCERRADAS (COMPLETED/TIMED_OUT) do contato —
 * alimenta a seção "Histórico" do card de automações no inbox/deal.
 * Ordena da mais recente pra mais antiga.
 */
export async function getContactAutomationHistory(contactId: string, limit = 20) {
  return prisma.automationContext.findMany({
    where: { contactId, status: { in: ["COMPLETED", "TIMED_OUT"] } },
    include: { automation: { select: { id: true, name: true } } },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
}

export type SalesbotProcessResult = {
  /** O robô consumiu a mensagem (o fluxo avançou ou foi encerrado por ela). */
  handled: boolean;
  /**
   * O robô de fato RESPONDEU o aluno. Quando ele apenas encerrou o contexto
   * (handoff: texto livre sem match, ponteiro morto, step que não esperava
   * resposta), ninguém falou com o aluno — e a IA precisa assumir. O gate em
   * `src/lib/meta-webhook/handler.ts` usa este campo, não `handled`.
   */
  replied: boolean;
  automationId?: string;
  contextId?: string;
};

export async function processIncomingMessage(
  contactId: string,
  messageContent: string,
  opts?: {
    interactiveId?: string | null;
    channelId?: string | null;
    conversationId?: string | null;
    flowReply?: boolean;
    flowToken?: string | null;
    flowPayload?: Record<string, unknown> | null;
  },
): Promise<SalesbotProcessResult> {
  // Guard: texto livre com humano atendendo não deixa o robô falar em cima
  // do consultor. Clique de botão/lista (`interactiveId`) e `nfm_reply`
  // (`flowReply`) devem retomar o menu que o próprio disparo manual acabou
  // de enviar. `suppressAutomation` também é true com assignee IA e serve
  // para NÃO disparar automações novas nos triggers — aqui não usamos,
  // senão o clique na lista/botão morre se a IA já era assignee antes do
  // gatilho manual.
  try {
    const { getHumanAttendanceForContact } = await import(
      "@/services/attendance-guards"
    );
    const snap = await getHumanAttendanceForContact(contactId);
    if (snap?.humanAttending) {
      if (shouldResumePausedMenuDespiteHumanAttendance(opts)) {
        log.info(
          `processIncomingMessage — humano atendendo mas inbound é clique/flow contact=${contactId} interactiveId=${opts?.interactiveId ?? "-"} flowReply=${Boolean(opts?.flowReply)} — retoma menu pausado`,
        );
      } else {
        const cancelled = await cancelActiveContextsForContact(contactId);
        log.info(
          `processIncomingMessage skip — humano atendendo contact=${contactId} cancelled=${cancelled} assignee=${snap.assignedToId ?? "-"} hasHumanReply=${snap.hasHumanReply}`,
        );
        return { handled: false, replied: false };
      }
    }
    if (snap?.assignedToId) {
      log.debug(
        `processIncomingMessage — assignee IA/não-humano contact=${contactId} assignee=${snap.assignedToId} type=${snap.assigneeType ?? "-"} — mantém contextos pausados`,
      );
    }
  } catch (err) {
    log.warn(
      `processIncomingMessage human-guard failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const activeContexts = await getContactActiveContexts(contactId);

  log.debug(
    `processIncomingMessage contactId=${contactId} contexts=${activeContexts.length} msg="${messageContent.slice(0, 40)}"`,
  );

  for (const ctx of activeContexts) {
    if (!ctx.currentStepId) {
      // Ponteiro morto: cliente falou e o robô não estava esperando nada.
      // Encerra para a conversa sair de Automação (handoff → Entrada).
      log.info(
        `processIncomingMessage handoff — ctx ${ctx.id} (auto=${ctx.automation.name}) sem currentStepId`,
      );
      await cancelContext(ctx.id);
      continue;
    }

    const currentStep = ctx.automation.steps.find((s) => s.id === ctx.currentStepId);
    if (!currentStep) {
      log.warn(
        `ctx ${ctx.id} (auto=${ctx.automation.name}) currentStepId=${ctx.currentStepId} não existe na automação — marcando como COMPLETED`,
      );
      // Step apagado da automação: limpa o contexto orfão pra não bloquear
      // futuras execuções (estado morto vivo era uma reclamação recorrente).
      await advanceContext(ctx.id, null, (ctx.variables as Record<string, unknown>) ?? {});
      continue;
    }
    if (!PAUSING_STEP_TYPES.has(currentStep.type)) {
      // Delay / step vazado RUNNING: o robô não estava à espera desta
      // mensagem. Encerrar evita a conversa ficar presa em Automação
      // depois do inbound (e o timeout do delay disparar por cima do
      // consultor). wait_for_reply / menu / template seguem abaixo.
      log.info(
        `processIncomingMessage handoff — ctx ${ctx.id} (auto=${ctx.automation.name}) currentStep=${currentStep.type} não espera resposta`,
      );
      await cancelContext(ctx.id);
      continue;
    }

    const config = currentStep.config as Record<string, unknown>;
    let nextStepId: string | null = null;
    let variables = { ...(ctx.variables as Record<string, unknown>) };
    const inboundChannelId = opts?.channelId?.trim();
    const inboundConversationId = opts?.conversationId?.trim();
    if (inboundChannelId) variables.channelId = inboundChannelId;
    if (inboundConversationId) variables.conversationId = inboundConversationId;

    if (currentStep.type === "wait_for_reply") {
      const varName = String(config.saveToVariable ?? "lastResponse").trim();
      if (varName) {
        variables = { ...variables, [varName]: messageContent };
      }
      const receivedGoto = readStepRef(config, "receivedGotoStepId");
      if (receivedGoto) {
        nextStepId = receivedGoto;
        log.info(
          `wait_for_reply resolvido — auto=${ctx.automation.name} contato=${contactId} → step=${nextStepId} (via receivedGotoStepId)`,
        );
      } else {
        nextStepId = linearFallbackStepId(ctx.automation.steps, ctx.currentStepId);
        if (nextStepId) {
          log.info(
            `wait_for_reply sem receivedGotoStepId — auto=${ctx.automation.name} → fallback linear step=${nextStepId}`,
          );
        } else {
          log.warn(
            `wait_for_reply sem receivedGotoStepId — auto=${ctx.automation.name} step=${currentStep.id} → fim de ramo (conecte a saída "resposta recebida" no canvas)`,
          );
        }
      }
    } else {
      const varName = String(config.saveToVariable ?? "lastResponse");
      variables = { ...variables, [varName]: messageContent };

      const buttonsFromButtons = Array.isArray(config.buttons)
        ? (config.buttons as InteractiveOption[])
        : [];
      const buttonsFromRows = Array.isArray(config.rows)
        ? (config.rows as InteractiveOption[])
        : [];
      // Lista WhatsApp usa `rows`; botões/question usam `buttons`.
      const buttons =
        buttonsFromButtons.length > 0 ? buttonsFromButtons : buttonsFromRows;

      if (buttons.length > 0) {
        const elseGoto = readStepRef(config, "elseGotoStepId");
        const defaultOut = readStepRef(config, "nextStepId");
        const awaitingFlow = readAwaitingFlow(variables);
        const decision = decideInteractiveMenuInbound({
          buttons,
          messageContent,
          interactiveId: opts?.interactiveId,
          flowReply: Boolean(opts?.flowReply),
          flowToken: opts?.flowToken,
          awaitingFlow,
        });

        const gotoFromButton = (matchedBtn: InteractiveOption, label: string) => {
          const btnGoto = readStepRef(matchedBtn, "gotoStepId");
          nextStepId = btnGoto ?? defaultOut ?? elseGoto;
          if (nextStepId) {
            const via = btnGoto
              ? "aresta do botão"
              : defaultOut
                ? "saída padrão do passo"
                : "saída 'nenhuma opção'";
            log.info(
              `botão "${label}" matched — auto=${ctx.automation.name} → step=${nextStepId} (via ${via})`,
            );
          } else {
            log.warn(
              `botão "${label}" matched mas sem nenhum destino — auto=${ctx.automation.name} step=${currentStep.id} → encerrando ramo (conecte esse botão no canvas)`,
            );
          }
        };

        if (decision.action === "complete_flow") {
          const awaiting = readAwaitingFlow(variables);
          delete variables[AWAITING_FLOW_VAR];
          if (opts?.flowPayload && Object.keys(opts.flowPayload).length > 0) {
            const varName = String(config.saveToVariable ?? "lastResponse");
            variables = { ...variables, [varName]: opts.flowPayload };
          }
          const doneBtn =
            buttons.find((b, i) => interactiveButtonId(b, i) === decision.buttonId) ??
            buttons.find((b) => (b.id || "").trim() === decision.buttonId);
          const storedGoto = (awaiting?.gotoStepId ?? "").trim();
          if (storedGoto) {
            nextStepId = storedGoto;
            log.info(
              `Flow concluído — auto=${ctx.automation.name} → step=${nextStepId} (goto gravado no envio)`,
            );
          } else if (doneBtn) {
            gotoFromButton(doneBtn, doneBtn.title || doneBtn.text || decision.buttonId);
          } else {
            nextStepId = defaultOut ?? elseGoto;
            log.info(
              `Flow concluído sem botão ${decision.buttonId} — auto=${ctx.automation.name} → step=${nextStepId ?? "(fim)"}`,
            );
          }
        } else if (decision.action === "goto_button") {
          delete variables[AWAITING_FLOW_VAR];
          const matchedBtn = decision.button;
          gotoFromButton(matchedBtn, matchedBtn.title || matchedBtn.text || matchedBtn.id || "");
        } else if (decision.action === "stay") {
          log.info(
            `nfm_reply ignorado (token não casa com Flow em aberto) — auto=${ctx.automation.name} step=${currentStep.id}`,
          );
          return { handled: true, automationId: ctx.automationId, contextId: ctx.id };
        } else {
          const staleBtn = matchStaleInteractiveOption(
            ctx.automation.steps,
            currentStep.id,
            messageContent,
            opts?.interactiveId,
          );
          const staleGoto = staleBtn ? readStepRef(staleBtn, "gotoStepId") : null;
          if (staleGoto) {
            nextStepId = staleGoto;
            const btnLabel = staleBtn?.title || staleBtn?.text || staleBtn?.id;
            log.info(
              `botão stale "${btnLabel}" matched — auto=${ctx.automation.name} step=${currentStep.id} → step=${nextStepId} (clique em menu anterior)`,
            );
          } else if (elseGoto) {
            nextStepId = elseGoto;
            log.info(
              `nenhum botão matched ("${messageContent}") — auto=${ctx.automation.name} → fallback elseGotoStepId step=${nextStepId}`,
            );
          } else if (hasExplicitEdges(config)) {
            // Menu/template com botões: cliente digitou texto livre em vez
            // de clicar. Antes o fluxo ficava parado no mesmo passo e a
            // conversa permanecia em Automação (ex.: "Bom dia, tudo bem?").
            // Handoff: encerra o robô para o ticket cair em Entrada.
            log.info(
              `processIncomingMessage handoff — texto livre sem match de botão ("${messageContent.slice(0, 40)}") auto=${ctx.automation.name} step=${currentStep.id}`,
            );
            await cancelContext(ctx.id);
            // Handoff: o robô saiu de cena SEM responder o aluno — a IA/o
            // consultor é quem precisa falar agora (`replied: false`).
            return {
              handled: true,
              replied: false,
              automationId: ctx.automationId,
              contextId: ctx.id,
            };
          } else {
            nextStepId = linearFallbackStepId(ctx.automation.steps, ctx.currentStepId);
            log.info(
              `nenhum botão matched ("${messageContent}") + sem elseGotoStepId — auto=${ctx.automation.name} → fallback linear step=${nextStepId ?? "(fim)"}`,
            );
          }
        }
      } else {
        // `question` de resposta aberta: a saída é única, então a aresta
        // desenhada (`nextStepId`) manda. Array só em fluxos legados.
        const openNext = readStepRef(config, "nextStepId");
        nextStepId =
          openNext ?? linearFallbackStepId(ctx.automation.steps, ctx.currentStepId);
        log.info(
          `question sem botões — auto=${ctx.automation.name} → step=${nextStepId ?? "(fim)"}${openNext ? " (via nextStepId)" : ""}`,
        );
      }
    }

    if (nextStepId) {
      // Resolve em cascata qualquer `wait_for_reply` encadeado: a mesma
      // mensagem que acabou de chegar CONTA como "resposta recebida" para
      // TODO wait_for_reply subsequente, até achar um step não-pausante,
      // um step pausante que EXIGE nova interação (question/interactive),
      // um `finish` ou um ramo órfão. Isso é o comportamento esperado
      // pelo usuário: "independente de quantas pausas existirem, a
      // resposta do cliente deve fazer o fluxo seguir".
      let currentTargetId: string = nextStepId;
      let cascade = 0;
      const CASCADE_LIMIT = 20;

      while (cascade++ < CASCADE_LIMIT) {
        const targetStep = ctx.automation.steps.find((s) => s.id === currentTargetId);
        if (!targetStep) {
          log.warn(
            `nextStepId=${currentTargetId} não existe na automação ${ctx.automation.name} — fechando contexto`,
          );
          await advanceContext(ctx.id, null, variables);
          return { handled: true, replied: true, automationId: ctx.automationId, contextId: ctx.id };
        }
        if (targetStep.type === "finish") {
          await advanceContext(ctx.id, null, variables);
          log.info(`fluxo finalizado — auto=${ctx.automation.name} contato=${contactId}`);
          return { handled: true, replied: true, automationId: ctx.automationId, contextId: ctx.id };
        }

        if (targetStep.type === "wait_for_reply") {
          const receivedGoto = readStepRef(targetStep.config, "receivedGotoStepId");
          if (!receivedGoto) {
            const fallback = linearFallbackStepId(ctx.automation.steps, targetStep.id);
            if (!fallback) {
              log.warn(
                `wait_for_reply (cascata) sem receivedGotoStepId — auto=${ctx.automation.name} step=${targetStep.id} → fim de ramo (conecte a saída "resposta recebida" no canvas)`,
              );
              await advanceContext(ctx.id, null, variables);
              return { handled: true, replied: true, automationId: ctx.automationId, contextId: ctx.id };
            }
            currentTargetId = fallback;
            log.info(
              `wait_for_reply (cascata) sem receivedGotoStepId — auto=${ctx.automation.name} → fallback linear step=${currentTargetId}`,
            );
            continue;
          }
          log.info(
            `wait_for_reply resolvido em cascata — auto=${ctx.automation.name} contato=${contactId} step=${targetStep.id} → step=${receivedGoto}`,
          );
          currentTargetId = receivedGoto;
          continue;
        }

        // Aqui paramos a cascata: targetStep é ou não-pausante (action)
        // ou pausante que precisa ENVIAR algo antes de esperar
        // (question, send_whatsapp_interactive). Propaga timeoutMs se
        // aplicável.
        const targetIsPausing = PAUSING_STEP_TYPES.has(targetStep.type);
        const targetExplicitTimeoutMs = targetIsPausing
          ? readNumber(targetStep.config, "timeoutMs")
          : undefined;
        const targetTimeoutMs = targetIsPausing
          ? pausedStepTimeoutMs(targetExplicitTimeoutMs)
          : undefined;
        const targetVariables = targetIsPausing
          ? markPausedTtl(variables, currentTargetId, targetExplicitTimeoutMs)
          : variables;

        await advanceContext(ctx.id, currentTargetId, targetVariables, targetTimeoutMs);

        try {
          const { continueFromStep } = await import("@/services/automation-executor");
          await continueFromStep(ctx.automationId, contactId, currentTargetId, variables);
          if (PAUSING_STEP_TYPES.has(targetStep.type)) {
            log.info(
              `próximo step (${targetStep.type}) executado e pausou o fluxo — auto=${ctx.automation.name} timeoutMs=${targetTimeoutMs ?? "—"}`,
            );
          }
        } catch (err) {
          log.error(
            `continueFromStep error — auto=${ctx.automation.name} step=${currentTargetId}:`,
            err,
          );
        }
        break;
      }

      if (cascade >= CASCADE_LIMIT) {
        log.warn(
          `cascata de wait_for_reply excedeu ${CASCADE_LIMIT} saltos — auto=${ctx.automation.name} → fechando contexto (possível loop de configuração)`,
        );
        await advanceContext(ctx.id, null, variables);
        return { handled: true, replied: true, automationId: ctx.automationId, contextId: ctx.id };
      }
    } else {
      // nextStepId nulo: encerra o contexto (não cai em fallback de array
      // pra evitar disparar passos de outros ramos por engano).
      await advanceContext(ctx.id, null, variables);
      log.info(`fluxo finalizado (sem próximo) — auto=${ctx.automation.name} contato=${contactId}`);
    }

    return { handled: true, replied: true, automationId: ctx.automationId, contextId: ctx.id };
  }

  log.debug(`nenhum contexto interativo encontrado pra contato=${contactId}`);
  // Qualquer RUNNING/PAUSED que o loop não consumiu (já cancelados no
  // corpo, ou recém-criados em corrida): garante saída de Automação.
  const leftover = await cancelActiveContextsForContact(contactId);
  if (leftover > 0) {
    log.info(
      `processIncomingMessage handoff leftover — contact=${contactId} cancelled=${leftover}`,
    );
  }
  // Também chega aqui quando os contextos foram encerrados no loop acima
  // (ponteiro morto / step que não esperava resposta): ninguém respondeu.
  return { handled: false, replied: false };
}

async function dispatchToNextStep(
  ctx: { id: string; automationId: string; contactId: string | null; automation: { name?: string; steps: { id: string; type: string; config: unknown }[] } },
  nextStepId: string | null,
  variables: Record<string, unknown>,
  reason: string,
): Promise<void> {
  if (!nextStepId) {
    await advanceContext(ctx.id, null, variables);
    log.info(`fluxo finalizado (sem próximo, ${reason}) — auto=${ctx.automation.name ?? ctx.automationId}`);
    return;
  }

  const targetStep = ctx.automation.steps.find((s) => s.id === nextStepId);
  if (!targetStep) {
    log.warn(
      `nextStepId=${nextStepId} não existe (${reason}) — auto=${ctx.automation.name ?? ctx.automationId} → fechando contexto`,
    );
    await advanceContext(ctx.id, null, variables);
    return;
  }
  if (targetStep.type === "finish") {
    await advanceContext(ctx.id, null, variables);
    log.info(`fluxo finalizado (${reason}) — auto=${ctx.automation.name ?? ctx.automationId}`);
    return;
  }

  const targetIsPausing = PAUSING_STEP_TYPES.has(targetStep.type);
  const targetExplicitTimeoutMs = targetIsPausing
    ? readNumber(targetStep.config, "timeoutMs")
    : undefined;
  const targetTimeoutMs = targetIsPausing
    ? pausedStepTimeoutMs(targetExplicitTimeoutMs)
    : undefined;
  const targetVariables = targetIsPausing
    ? markPausedTtl(variables, nextStepId, targetExplicitTimeoutMs)
    : variables;

  await advanceContext(ctx.id, nextStepId, targetVariables, targetTimeoutMs);

  if (ctx.contactId) {
    try {
      const { continueFromStep } = await import("@/services/automation-executor");
      await continueFromStep(ctx.automationId, ctx.contactId, nextStepId, variables);
      if (PAUSING_STEP_TYPES.has(targetStep.type)) {
        log.info(
          `próximo step pausa (${targetStep.type}, ${reason}) e foi executado — auto=${ctx.automation.name ?? ctx.automationId} timeoutMs=${targetTimeoutMs ?? "—"}`,
        );
      }
    } catch (err) {
      log.error(
        `continueFromStep error (${reason}) — auto=${ctx.automation.name ?? ctx.automationId} step=${nextStepId}:`,
        err,
      );
      // A continuação morreu no meio do ramo SEM re-pausar (um throw sai
      // do loop antes de qualquer wait). Se não fecharmos aqui, o contexto
      // fica RUNNING eternamente no step despachado e a trava de reentrada
      // (getActiveContext no fireTrigger) bloqueia a automação pro contato
      // pra sempre.
      await advanceContext(ctx.id, null, variables).catch(() => {});
    }
  } else if (PAUSING_STEP_TYPES.has(targetStep.type)) {
    log.info(
      `próximo step pausa (${targetStep.type}, ${reason}) sem contactId — auto=${ctx.automation.name ?? ctx.automationId} timeoutMs=${targetTimeoutMs ?? "—"}`,
    );
  }
}

export async function processTimeout(contextId: string) {
  const ctx = await prisma.automationContext.findUnique({
    where: { id: contextId },
    include: {
      automation: { select: { id: true, name: true, steps: { orderBy: { position: "asc" } } } },
    },
  });
  if (!ctx || ctx.status !== "RUNNING" || !ctx.currentStepId) {
    log.debug(`processTimeout — ctx ${contextId} inativo/sem step, ignorando`);
    return;
  }

  const step = ctx.automation.steps.find((s) => s.id === ctx.currentStepId);

  // TTL de segurança: o autor NÃO configurou timeout neste passo, então não
  // seguimos aresta nenhuma — só encerramos o contexto para destravar o
  // contato (re-disparo da automação e 1º atendimento da IA).
  if (timeoutCameFromTtl(
    (ctx.variables as Record<string, unknown>) ?? {},
    ctx.currentStepId,
  )) {
    log.info(
      `TTL de contexto pausado expirou — auto=${ctx.automation.name} step=${ctx.currentStepId} (${step?.type ?? "?"}) → encerrando contexto`,
    );
    await advanceContext(
      ctx.id,
      null,
      (ctx.variables as Record<string, unknown>) ?? {},
    );
    return;
  }

  // `delay` persistido: o "timeout" É a conclusão da espera — segue a
  // aresta `nextStepId` (fallback linear só pra legado pré-canvas).
  if (step && step.type === "delay") {
    const delayConfig = step.config as Record<string, unknown>;
    const delayVars = (ctx.variables as Record<string, unknown>) ?? {};
    const delayNext =
      readStepRef(delayConfig, "nextStepId") ??
      linearFallbackStepId(ctx.automation.steps, ctx.currentStepId);
    if (!delayNext) {
      log.warn(
        `delay expirou SEM nextStepId — auto=${ctx.automation.name} step=${step.id} → encerrando fluxo (conecte a saída no canvas)`,
      );
    }
    await dispatchToNextStep(
      {
        id: ctx.id,
        automationId: ctx.automationId,
        contactId: ctx.contactId,
        automation: ctx.automation,
      },
      delayNext,
      delayVars,
      "delay concluído",
    );
    return;
  }

  if (!step || !PAUSING_STEP_TYPES.has(step.type)) {
    log.debug(
      `processTimeout — ctx ${contextId} step=${step?.type ?? "?"} não é interativo, ignorando`,
    );
    return;
  }

  const config = step.config as Record<string, unknown>;
  const variables = (ctx.variables as Record<string, unknown>) ?? {};
  const ctxForDispatch = {
    id: ctx.id,
    automationId: ctx.automationId,
    contactId: ctx.contactId,
    automation: ctx.automation,
  };

  if (step.type === "wait_for_reply") {
    const timeoutGoto = readStepRef(config, "timeoutGotoStepId");
    if (!timeoutGoto) {
      log.warn(
        `wait_for_reply timeout sem timeoutGotoStepId — auto=${ctx.automation.name} step=${step.id} → fechando contexto`,
      );
      await advanceContext(ctx.id, null, variables);
      return;
    }
    log.info(
      `wait_for_reply timeout — auto=${ctx.automation.name} contato=${ctx.contactId} → step=${timeoutGoto}`,
    );
    await dispatchToNextStep(ctxForDispatch, timeoutGoto, variables, "wait_for_reply timeout");
    return;
  }

  const action = String(config.timeoutAction ?? "continue");

  if (action === "stop") {
    log.info(`question/interactive timeout (action=stop) — auto=${ctx.automation.name}`);
    await advanceContext(ctx.id, null, variables);
    return;
  }

  let nextStepId: string | null = null;

  // 03/ago/26 — Se o operador desenhou a aresta de timeout no canvas
  // (`timeoutGotoStepId` preenchido), respeitamos SEMPRE — independente
  // de `timeoutAction`. O editor grava a aresta mas nem sempre grava
  // `timeoutAction: "goto"` (default fica "continue" em
  // `automation-workflow.ts::defaultConfigForType`). Cair no fallback
  // linear (stepIndex+1) num canvas multi-ramo pula pra step do RAMO
  // VIZINHO por engano (bug INICIO-PIPE: timeout do interactive[2]
  // caía em step[3] "Acesso à Plataforma" sem o cliente ter clicado,
  // e o próximo timeout caía em step[6] "Já já um consultor...",
  // movendo o lead pra "Em Atendimento" sozinho). `wait_for_reply`
  // já respeita `timeoutGotoStepId` sempre — aqui deixamos consistente.
  const explicitTimeoutGoto = readStepRef(config, "timeoutGotoStepId");

  if (explicitTimeoutGoto) {
    nextStepId = explicitTimeoutGoto;
  } else {
    // Sem aresta de timeout desenhada: fallback linear, permitido apenas
    // em automações legadas (`linearFallbackStepId` devolve null quando o
    // step veio do canvas com arestas explícitas).
    nextStepId = linearFallbackStepId(ctx.automation.steps, ctx.currentStepId);
    log.warn(
      nextStepId
        ? `question/interactive timeout SEM timeoutGotoStepId — auto=${ctx.automation.name} step=${step.id} → fallback linear step=${nextStepId} (conecte a aresta de timeout no canvas p/ evitar surpresa em ramos paralelos)`
        : `question/interactive timeout SEM timeoutGotoStepId — auto=${ctx.automation.name} step=${step.id} → encerrando fluxo (conecte a aresta de timeout no canvas)`,
    );
  }

  log.info(
    `question/interactive timeout — auto=${ctx.automation.name} action=${action} → step=${nextStepId ?? "(fim)"}`,
  );
  await dispatchToNextStep(ctxForDispatch, nextStepId, variables, `${step.type} timeout`);
}

function applyVariableTransform(raw: unknown, transform?: string): string {
  const value = raw == null ? "" : String(raw);
  if (!transform) return value;
  const t = transform.trim().toLowerCase();
  if (t === "first" || t === "first_name" || t === "primeiro_nome") {
    return value.trim().split(/\s+/)[0] ?? "";
  }
  return value;
}

export function interpolateVariables(template: string, variables: Record<string, unknown>): string {
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)(?:\s*\|\s*([a-zA-Z0-9_]+))?\s*\}\}/g,
    (_, key: string, transform?: string) => {
      const val = variables[key];
      if (val == null) {
        return transform ? `{{${key}|${transform}}}` : `{{${key}}}`;
      }
      return applyVariableTransform(val, transform);
    },
  );
}

export async function sweepExpiredTimeouts(): Promise<number> {
  // Worker cross-tenant: lista contextos expirados de TODAS as orgs
  // usando prismaBase (sem scope). Cada processamento entra em seu
  // proprio withSystemContext.
  const expired = await prismaBase.automationContext.findMany({
    where: {
      status: "RUNNING",
      timeoutAt: { not: null, lte: new Date() },
    },
    select: { id: true, organizationId: true },
    take: 50,
  });
  let processed = 0;
  for (const ctx of expired) {
    try {
      await withSystemContext(ctx.organizationId, () => processTimeout(ctx.id));
      processed++;
    } catch (err) {
      console.error(`[automation-context] sweepExpiredTimeouts error for ${ctx.id}:`, err);
    }
  }
  return processed;
}

let _sweepInterval: ReturnType<typeof setInterval> | null = null;

export function startTimeoutSweeper(intervalMs = 30_000) {
  if (_sweepInterval) return;
  _sweepInterval = setInterval(() => {
    sweepExpiredTimeouts().catch((err) =>
      console.error("[automation-context] sweeper error:", err)
    );
  }, intervalMs);
  if (typeof _sweepInterval === "object" && "unref" in _sweepInterval) {
    (_sweepInterval as NodeJS.Timeout).unref();
  }
  console.info(`[automation-context] timeout sweeper started (every ${intervalMs}ms)`);
}

export function stopTimeoutSweeper() {
  if (_sweepInterval) {
    clearInterval(_sweepInterval);
    _sweepInterval = null;
  }
}
