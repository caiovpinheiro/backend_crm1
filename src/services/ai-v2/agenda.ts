/**
 * Agenda de envios automáticos do agente v2 — regras puras (sem banco).
 *
 * Duas origens, um caminho de envio:
 * - retomada agendada ("me manda amanhã"): o modelo devolve
 *   `schedule_message` e o motor grava uma linha `kind = scheduled`;
 * - follow-up por etapa: régua configurada para as etapas do negócio; cada
 *   passo vira uma linha `kind = followup`.
 *
 * O que sai da agenda é reconhecido pelo id da mensagem gravado na linha,
 * nunca pelo texto (o loop de lembrete de 10–12/11 veio de reconhecer pelo
 * texto). Cada passo tem chave única por âncora, e há teto de envios desde
 * a última mensagem do cliente que não depende de reconhecer nada.
 * Nenhum domínio de cliente.
 */

import type {
  V2AgentConfig,
  V2AutoSendTemplate,
  V2BusinessHoursSlot,
  V2FollowUpSequence,
  V2FollowUpSequenceStep,
} from "@/lib/ai-v2/types";
import { noticeInstant } from "./notices";
import { dealStageMatches } from "./rules";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Janela de atendimento do WhatsApp (Meta), com folga para não errar na borda. */
export const WHATSAPP_WINDOW_MS = 24 * HOUR;
export const WHATSAPP_WINDOW_MARGIN_MS = 5 * MINUTE;
/** Passo de régua vencido há mais que isto não sai (régua recém-ligada, worker parado). */
export const AGENDA_LATE_GRACE_MS = 6 * HOUR;
/** Antecedência mínima de uma retomada. */
export const SCHEDULE_MIN_LEAD_MS = 10 * MINUTE;
/** "No fim" da régua: padrão 1 dia depois do último passo. */
export const ON_END_DEFAULT_AFTER_MIN = 24 * 60;
/** Teto absoluto de follow-ups desde a última mensagem do cliente. */
export const MAX_FOLLOWUPS_SINCE_INBOUND = 5;
/** SENDING parado além disto vira FAILED (nunca volta a PENDING). */
export const AGENDA_SENDING_LEASE_MS = 10 * MINUTE;
/** Encerramentos feitos pelo próprio agente: a retomada pode reabrir o ticket. */
export const AGENT_CLOSE_REASONS = ["inactivity", "resolved", "rule", "deferred"] as const;

export const DEFAULT_OPT_OUT_TERMS = [
  "pare de mandar",
  "para de mandar",
  "parem de mandar",
  "não quero mais",
  "não me mande",
  "não mande mais",
  "não tenho interesse",
  "sair da lista",
  "me tira da lista",
  "descadastrar",
];

export const SCHEDULE_FALLBACK_MESSAGE = "Oi! Combinamos de retomar a nossa conversa agora. Podemos continuar?";
export const FOLLOWUP_STEP_FALLBACK_MESSAGE = "Oi! Passando para saber se posso te ajudar a continuar. É só me responder por aqui.";

export type AgendaKind = "scheduled" | "followup";

export type AgendaOutcome =
  | "client_replied"
  | "human"
  | "other_agent"
  | "stage_changed"
  | "deal_closed"
  | "conversation_closed"
  | "conversation_missing"
  | "opt_out"
  | "no_template"
  | "daily_cap"
  | "superseded"
  | "agent_off"
  | "channel"
  | "not_allowed"
  | "late"
  | "interrupted"
  | "send_failed"
  | "model_cancelled";

export function agendaTimezone(config: Pick<V2AgentConfig, "businessHours">): string {
  return config.businessHours?.timezone || "America/Sao_Paulo";
}

type LocalParts = { isoDate: string; weekday: number; minutes: number };

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(date: Date, timeZone: string): LocalParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const weekday = WEEKDAY[get("weekday")];
    if (weekday === undefined) return null;
    return { isoDate: `${get("year")}-${get("month")}-${get("day")}`, weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
  } catch {
    return null;
  }
}

function minutesOf(hhmm: string): number {
  const [h, m] = String(hhmm ?? "").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Primeiro instante permitido a partir de `at`. Sem janela (ou janela sem
 * nenhum horário válido) = qualquer hora: o próprio `at`.
 */
export function nextAllowedSlot(at: Date, window: V2BusinessHoursSlot[] | undefined, timeZone: string): Date {
  const slots = (window ?? []).filter((s) => minutesOf(s.end) > minutesOf(s.start));
  if (slots.length === 0) return at;
  for (let d = 0; d <= 8; d += 1) {
    const lp = localParts(new Date(at.getTime() + d * DAY), timeZone);
    if (!lp) return at;
    const today = slots.filter((s) => s.day === lp.weekday).sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    for (const s of today) {
      const start = minutesOf(s.start);
      const end = minutesOf(s.end);
      if (d === 0) {
        if (lp.minutes >= start && lp.minutes < end) return at;
        if (lp.minutes >= end) continue;
      }
      const instant = noticeInstant(`${lp.isoDate}T${hhmm(start)}`, timeZone);
      if (instant && instant.getTime() >= at.getTime()) return instant;
    }
  }
  return at;
}

export function withinWhatsAppWindow(lastInboundAt: Date | null | undefined, now: Date): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - new Date(lastInboundAt).getTime() < WHATSAPP_WINDOW_MS - WHATSAPP_WINDOW_MARGIN_MS;
}

/** "hoje às 15h", "amanhã às 9h30", "na segunda-feira, 30/11, às 9h". */
export function formatWhen(at: Date, now: Date, timeZone: string): string {
  const a = localParts(at, timeZone);
  const n = localParts(now, timeZone);
  if (!a || !n) return at.toISOString();
  const h = Math.floor(a.minutes / 60);
  const m = a.minutes % 60;
  const time = m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
  const tomorrow = localParts(new Date(now.getTime() + DAY), timeZone);
  if (a.isoDate === n.isoDate) return `hoje às ${time}`;
  if (tomorrow && a.isoDate === tomorrow.isoDate) return `amanhã às ${time}`;
  const names = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const [, mo, d] = a.isoDate.split("-");
  return `${a.weekday === 0 || a.weekday === 6 ? "no" : "na"} ${names[a.weekday]}, ${d}/${mo}, às ${time}`;
}

export type ScheduleNormalization =
  | { ok: true; dueAt: Date; requestedAt: Date; adjusted: boolean }
  | { ok: false; why: "disabled" | "invalid_at" | "past" | "too_far" };

/**
 * Valida o pedido do modelo. `at` é data e hora no fuso do agente
 * ("2026-11-26T09:00") ou ISO com fuso. Sem `at` = "mais tarde": daqui a
 * `laterDefaultHours`. Hora que já passou há pouco (o modelo arredondou
 * "agora") vira a antecedência mínima; passada há mais de 1 h é erro.
 */
export function normalizeSchedule(args: {
  at?: unknown;
  now: Date;
  config: Pick<V2AgentConfig, "scheduling" | "autoSend" | "businessHours">;
}): ScheduleNormalization {
  const sch = args.config.scheduling;
  if (!sch?.enabled) return { ok: false, why: "disabled" };
  const tz = agendaTimezone(args.config);
  const raw = typeof args.at === "string" ? args.at.trim() : "";
  let requested: Date | null;
  if (!raw) requested = new Date(args.now.getTime() + (sch.laterDefaultHours ?? 3) * HOUR);
  else requested = noticeInstant(raw, tz);
  if (!requested || Number.isNaN(requested.getTime())) return { ok: false, why: "invalid_at" };
  const minAt = args.now.getTime() + SCHEDULE_MIN_LEAD_MS;
  if (requested.getTime() < args.now.getTime() - HOUR) return { ok: false, why: "past" };
  const base = requested.getTime() < minAt ? new Date(minAt) : requested;
  if (base.getTime() > args.now.getTime() + (sch.maxDaysAhead ?? 7) * DAY) return { ok: false, why: "too_far" };
  const dueAt = nextAllowedSlot(base, args.config.autoSend?.sendWindow, tz);
  if (dueAt.getTime() > args.now.getTime() + ((sch.maxDaysAhead ?? 7) + 1) * DAY) return { ok: false, why: "too_far" };
  return { ok: true, dueAt, requestedAt: requested, adjusted: Math.abs(dueAt.getTime() - requested.getTime()) >= MINUTE };
}

export function normalizeForMatch(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COURTESY_WORDS = new Set([
  "ok", "okay", "okey", "blz", "beleza", "obrigado", "obrigada", "obg", "brigado", "brigada", "valeu", "vlw",
  "combinado", "certo", "ta", "bom", "otimo", "otima", "perfeito", "show", "top", "sim", "aguardo", "fico",
  "no", "aguardando", "ate", "amanha", "depois", "entao", "tudo", "bem", "joia", "isso", "pode", "ser",
  "fechado", "de", "nada", "muito", "mt", "mto", "ss", "s", "tmj", "grato", "grata", "agradeco", "otimo",
  "beleza", "e", "eu", "te", "espero", "esperando", "aguardarei", "certinho", "tranquilo", "tranquila", "massa",
]);

/** "ok", "obrigado!", "👍", "combinado, até amanhã": não muda o combinado. */
export function isCourtesyOnly(text: string | null | undefined): boolean {
  const n = normalizeForMatch(text);
  if (!n) return true;
  const words = n.split(" ");
  return words.length <= 8 && words.every((w) => COURTESY_WORDS.has(w));
}

export function isOptOut(text: string | null | undefined, terms: string[] | undefined): boolean {
  const n = normalizeForMatch(text);
  if (!n) return false;
  const list = (terms && terms.length > 0 ? terms : DEFAULT_OPT_OUT_TERMS).map(normalizeForMatch).filter(Boolean);
  return list.some((t) => ` ${n} `.includes(` ${t} `));
}

export function scheduledKey(conversationId: string, turnKey: string): string {
  return `sched:${conversationId}:${turnKey}`;
}

export function followUpKey(conversationId: string, sequenceId: string, anchorMessageId: string, stepIndex: number): string {
  return `fu:${conversationId}:${sequenceId}:${anchorMessageId}:${stepIndex}`;
}

export function sortedSteps(seq: Pick<V2FollowUpSequence, "steps">): V2FollowUpSequenceStep[] {
  return [...(seq.steps ?? [])].filter((s) => s && s.after > 0).sort((a, b) => a.after - b.after);
}

/** Régua que vale para o negócio: a primeira ligada cuja etapa casa. */
export function matchSequence(
  config: Pick<V2AgentConfig, "followUpSequences">,
  deal: { stageId?: string | null; stageName?: string | null; pipelineName?: string | null } | null,
): V2FollowUpSequence | null {
  if (!deal?.stageId && !deal?.stageName) return null;
  for (const seq of config.followUpSequences ?? []) {
    if (seq.enabled === false || sortedSteps(seq).length === 0) continue;
    const hit = (seq.dealStages ?? []).some((v) =>
      dealStageMatches(v, {
        dealStageId: deal.stageId ?? undefined,
        dealStageName: deal.stageName ?? undefined,
        dealPipelineName: deal.pipelineName ?? undefined,
      }),
    );
    if (hit) return seq;
  }
  return null;
}

export type AgendaRowLite = {
  stepIndex: number | null;
  status: string;
  outcome?: string | null;
  anchorMessageId: string | null;
  sequenceId?: string | null;
  /** text | template | action ("no fim"). */
  sentVia?: string | null;
  sentAt?: Date | null;
};

export type FollowUpPlan =
  | { action: "plan"; stepIndex: number; dueAt: Date; end: boolean }
  | { action: "skip"; stepIndex: number; end: boolean }
  | { action: "none"; why: string };

/**
 * Próximo passo da régua para a âncora (mensagem do agente sem resposta).
 * Passo cancelado encerra a régua nesta âncora; passo vencido há mais de
 * `AGENDA_LATE_GRACE_MS` é pulado (sem rajada ao ligar a régua ou depois de
 * o worker ficar parado). O "no fim" só roda depois de ao menos um passo
 * enviado.
 */
export function planFollowUp(args: {
  sequence: V2FollowUpSequence;
  anchorMessageId: string;
  anchorAt: Date;
  /** Linhas de follow-up da conversa desde a última mensagem do cliente. */
  rows: AgendaRowLite[];
  now: Date;
  window: V2BusinessHoursSlot[] | undefined;
  timeZone: string;
}): FollowUpPlan {
  const steps = sortedSteps(args.sequence);
  if (steps.length === 0) return { action: "none", why: "no_steps" };
  const mine = args.rows.filter((r) => r.anchorMessageId === args.anchorMessageId && (r.sequenceId ?? args.sequence.id) === args.sequence.id);
  if (mine.some((r) => r.status === "PENDING" || r.status === "SENDING")) return { action: "none", why: "open" };
  if (mine.some((r) => r.status === "CANCELLED" || r.status === "FAILED")) return { action: "none", why: "stopped" };
  // Teto que não depende de reconhecer nada: mensagens da régua desde a
  // última do cliente, de qualquer âncora ou régua.
  const sentSinceInbound = args.rows.filter((r) => r.status === "SENT" && r.sentVia !== "action").length;
  const done = new Set(mine.map((r) => r.stepIndex));
  const next = steps.findIndex((_, i) => !done.has(i));
  const capped = sentSinceInbound >= Math.min(steps.length, MAX_FOLLOWUPS_SINCE_INBOUND);
  if (next >= 0 && !capped) {
    const due = args.anchorAt.getTime() + steps[next].after * MINUTE;
    if (due + AGENDA_LATE_GRACE_MS < args.now.getTime()) return { action: "skip", stepIndex: next, end: false };
    return {
      action: "plan",
      stepIndex: next,
      dueAt: nextAllowedSlot(new Date(Math.max(due, args.now.getTime())), args.window, args.timeZone),
      end: false,
    };
  }
  const onEnd = args.sequence.onEnd;
  if (!onEnd || onEnd.action === "none") return { action: "none", why: "finished" };
  if (done.has(steps.length)) return { action: "none", why: "finished" };
  const sentMine = mine.filter((r) => r.status === "SENT" && r.sentVia !== "action" && (r.stepIndex ?? 0) < steps.length);
  if (sentMine.length === 0) return { action: "none", why: "nothing_sent" };
  const lastSent = Math.max(...sentMine.map((r) => (r.sentAt ? new Date(r.sentAt).getTime() : args.anchorAt.getTime())));
  const due = lastSent + (onEnd.after ?? ON_END_DEFAULT_AFTER_MIN) * MINUTE;
  if (due + AGENDA_LATE_GRACE_MS < args.now.getTime()) return { action: "skip", stepIndex: steps.length, end: true };
  return {
    action: "plan",
    stepIndex: steps.length,
    dueAt: nextAllowedSlot(new Date(Math.max(due, args.now.getTime())), args.window, args.timeZone),
    end: true,
  };
}

export type AgendaSnapshot = {
  kind: AgendaKind;
  now: Date;
  createdAt: Date;
  conversation: {
    status: string;
    assignedToId: string | null;
    channelKind: "meta" | "baileys" | "other";
    lastInboundAt: Date | null;
  } | null;
  agentUserId: string;
  /** Agente ligado e a régua/retomada ainda na configuração publicada. */
  agentActive: boolean;
  configured: boolean;
  state: { owner: string | null; stage: string | null; closeReason: string | null } | null;
  /** Mensagens do cliente (qualquer ticket do contato) depois da criação da linha. */
  inboundSinceCreated: string[];
  /**
   * Alguém da equipe escreveu ao cliente depois da última mensagem do agente
   * (sem mensagem do agente na conversa: depois da criação da linha).
   */
  humanOutboundAfterAgent: boolean;
  /** A conversa está com outro agente de IA. */
  assignedToOtherAi?: boolean;
  deal: { status: string | null; stageId: string | null } | null;
  dealStageIdAtCreate: string | null;
  stopOnStageChange: boolean;
  phoneAllowed: boolean;
  optedOut: boolean;
  sentLast24h: number;
  /** Mensagens de automação/campanha (robô que não é agente) nas últimas 24 h da conversa. */
  automationSentLast24h?: number;
  maxPerDay: number;
  window: V2BusinessHoursSlot[] | undefined;
  timeZone: string;
};

export type AgendaDecision =
  | { action: "cancel"; outcome: AgendaOutcome }
  | { action: "reschedule"; at: Date }
  | { action: "send"; via: "text" | "template"; reopen: boolean };

/** O que fazer com uma linha vencida. Ordem: parar > horário > canal. */
export function decideAgendaSend(s: AgendaSnapshot): AgendaDecision {
  const conv = s.conversation;
  if (!conv) return { action: "cancel", outcome: "conversation_missing" };
  if (!s.agentActive || !s.configured) return { action: "cancel", outcome: "agent_off" };
  if (s.optedOut) return { action: "cancel", outcome: "opt_out" };
  const replied = s.kind === "followup"
    ? s.inboundSinceCreated.length > 0
    : s.inboundSinceCreated.some((t) => !isCourtesyOnly(t));
  if (replied) return { action: "cancel", outcome: "client_replied" };
  // Ter responsável humano (ou ter sido transferida) não para a régua: o
  // passo só cai se alguém da equipe falou com o cliente depois do agente.
  // Antes, toda conversa passada à equipe perdia os passos seguintes.
  if (s.humanOutboundAfterAgent) return { action: "cancel", outcome: "human" };
  if (s.assignedToOtherAi) return { action: "cancel", outcome: "other_agent" };
  const dealStatus = (s.deal?.status ?? "").toUpperCase();
  if (dealStatus === "WON" || dealStatus === "LOST") return { action: "cancel", outcome: "deal_closed" };
  if (s.stopOnStageChange && s.dealStageIdAtCreate && s.deal && s.deal.stageId !== s.dealStageIdAtCreate) {
    return { action: "cancel", outcome: "stage_changed" };
  }
  let reopen = false;
  if (conv.status === "RESOLVED") {
    const byAgent = s.state?.stage === "closed"
      && (AGENT_CLOSE_REASONS as readonly string[]).includes(s.state?.closeReason ?? "");
    if (!byAgent) return { action: "cancel", outcome: "conversation_closed" };
    reopen = true;
  }
  if (conv.channelKind === "other") return { action: "cancel", outcome: "channel" };
  if (!s.phoneAllowed) return { action: "cancel", outcome: "not_allowed" };
  if (s.sentLast24h >= s.maxPerDay) return { action: "cancel", outcome: "daily_cap" };
  // Automações e campanhas também falaram com o cliente hoje: somadas, batem
  // o teto. O passo não morre — fica para o dia seguinte.
  if (s.sentLast24h + (s.automationSentLast24h ?? 0) >= s.maxPerDay) {
    return { action: "reschedule", at: nextAllowedSlot(new Date(s.now.getTime() + 24 * 60 * 60 * 1000), s.window, s.timeZone) };
  }
  const slot = nextAllowedSlot(s.now, s.window, s.timeZone);
  if (slot.getTime() > s.now.getTime()) return { action: "reschedule", at: slot };
  if (conv.channelKind === "baileys" || withinWhatsAppWindow(conv.lastInboundAt, s.now)) {
    return { action: "send", via: "text", reopen };
  }
  return { action: "send", via: "template", reopen };
}

export type TemplateCandidate = {
  name: string;
  language: string;
  variables: string[];
  purpose?: string;
  preview?: string;
};

export type AgentTemplateRow = {
  name: string;
  language: string;
  label?: string | null;
  bodyPreview?: string | null;
  hasVariables?: boolean | null;
};

/**
 * Modelos possíveis para um envio fora das 24 h: os do passo, senão os do
 * agente, senão (com a escolha automática ligada) os liberados para agente
 * sem variáveis — modelo com variável sem valor configurado não sai.
 */
export function templateCandidates(args: {
  step?: Pick<V2FollowUpSequenceStep, "templates"> | null;
  autoSend: V2AgentConfig["autoSend"];
  agentTemplates: AgentTemplateRow[];
}): TemplateCandidate[] {
  const byName = new Map(args.agentTemplates.map((t) => [t.name, t]));
  const fromConfig = (list: V2AutoSendTemplate[] | undefined) =>
    (list ?? []).filter((t) => t.name?.trim()).map((t) => {
      const known = byName.get(t.name);
      return {
        name: t.name,
        language: t.language || known?.language || "pt_BR",
        variables: t.variables ?? [],
        ...(t.purpose ? { purpose: t.purpose } : {}),
        ...(known?.bodyPreview ? { preview: known.bodyPreview } : {}),
      };
    }).filter((t) => !(byName.get(t.name)?.hasVariables && t.variables.length === 0));
  const own = fromConfig(args.step?.templates);
  if (own.length > 0) return own;
  const agent = fromConfig(args.autoSend?.templates);
  if (agent.length > 0) return agent;
  if (args.autoSend?.autoPickTemplates === false) return [];
  return args.agentTemplates
    .filter((t) => !t.hasVariables)
    .map((t) => ({
      name: t.name,
      language: t.language || "pt_BR",
      variables: [],
      ...(t.label ? { purpose: t.label } : {}),
      ...(t.bodyPreview ? { preview: t.bodyPreview } : {}),
    }));
}

/** Ordena pela afinidade de palavras com o propósito do envio (reserva da escolha pelo modelo). */
export function rankTemplates(candidates: TemplateCandidate[], purpose: string): TemplateCandidate[] {
  const words = new Set(normalizeForMatch(purpose).split(" ").filter((w) => w.length >= 4));
  const score = (t: TemplateCandidate) => {
    const hay = new Set(normalizeForMatch(`${t.name.replace(/_/g, " ")} ${t.purpose ?? ""} ${t.preview ?? ""}`).split(" "));
    let n = 0;
    for (const w of words) if (hay.has(w)) n += 1;
    return n;
  };
  return candidates
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}

/**
 * Guarda de efeito da retomada: hora ajustada → a resposta diz a hora
 * final; agendamento recusado → a resposta não fica prometendo retorno.
 */
export function scheduleReplyNote(
  reply: string,
  results: Array<{ action: { type: string }; ok: boolean; [k: string]: unknown }>,
): string {
  const r = results.find((x) => x.action.type === "schedule_message");
  if (!r) return reply;
  const base = (reply ?? "").trim();
  if (r.ok) {
    const when = typeof r.whenText === "string" ? r.whenText : "";
    if (!r.adjusted || !when || normalizeForMatch(base).includes(normalizeForMatch(when))) return reply;
    return base ? `${base}\n\nCombinado: te chamo ${when}.` : `Combinado: te chamo ${when}.`;
  }
  if (r.error === "schedule_sandbox") return reply;
  const note = "Não consegui deixar o retorno agendado por aqui; quando quiser continuar, é só me chamar.";
  return base ? `${base}\n\n${note}` : note;
}
