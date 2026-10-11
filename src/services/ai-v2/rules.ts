/**
 * Avaliador ordenado de regras determinísticas da v2.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Rule, V2RuleAction, V2RuleCondition, V2CRMContext, V2BusinessHoursSlot, V2TeamClosure } from "@/lib/ai-v2/types";
import { humanRequestTerms, isHumanRequestRule } from "@/lib/ai-v2/config";
import { brHolidayName } from "@/lib/br-holidays";
import { noticeInstant } from "./notices";

export type V2RuleEvaluationInput = {
  userMessage: string;
  messageType?: string;
  isFirstMessage: boolean;
  mediaKinds?: string[];
  contactTags?: string[];
  dealStageName?: string;
  dealStageId?: string;
  dealPipelineName?: string;
  withinBusinessHours: boolean;
  surveyReceived?: boolean;
};

function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function weekdayFromString(s: string): number | undefined {
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[s];
}

const WEEKDAY_NAMES = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

/**
 * Horário de atendimento configurado, em texto ("segunda-feira: 08:00 às
 * 18:00"). Vazio quando desligado. Vai ao prompt e conta como fonte: antes
 * o agente dizia que o horário "não está informado" e transferia.
 */
export function businessHoursText(config: Pick<V2AgentConfig, "businessHours">, now: Date = new Date()): string {
  const bh = config.businessHours;
  if (!bh || !bh.enabled || bh.weekdays.length === 0) return "";
  const lines = [1, 2, 3, 4, 5, 6, 0].map((day) => {
    const slots = bh.weekdays.filter((s: V2BusinessHoursSlot) => s.day === day);
    return `- ${WEEKDAY_NAMES[day]}: ${slots.length ? slots.map((s: V2BusinessHoursSlot) => `${s.start} às ${s.end}`).join(" e ") : "sem atendimento"}`;
  });
  // Feriado e pausa da equipe: o horário da semana sozinho fazia o agente
  // dizer "a equipe volta segunda às 8h" num feriado.
  const extra = teamAvailabilityLines(config, now);
  return [...lines, ...extra].join("\n");
}

/** "segunda a sexta, 08:00 às 18:00; sábado, 08:00 às 12:00". Vazio quando desligado. */
export function businessHoursSummary(config: Pick<V2AgentConfig, "businessHours">): string {
  const bh = config.businessHours;
  if (!bh || !bh.enabled || bh.weekdays.length === 0) return "";
  const order = [1, 2, 3, 4, 5, 6, 0];
  const slotOf = (day: number) => bh.weekdays.filter((s: V2BusinessHoursSlot) => s.day === day).map((s: V2BusinessHoursSlot) => `${s.start} às ${s.end}`).join(" e ");
  const groups: Array<{ from: number; to: number; slot: string }> = [];
  for (const day of order) {
    const slot = slotOf(day);
    if (!slot) continue;
    const last = groups[groups.length - 1];
    if (last && last.slot === slot && order.indexOf(day) === order.indexOf(last.to) + 1) last.to = day;
    else groups.push({ from: day, to: day, slot });
  }
  const short = (d: number) => WEEKDAY_NAMES[d].replace("-feira", "");
  return groups.map((g) => `${g.from === g.to ? short(g.from) : `${short(g.from)} a ${short(g.to)}`}, ${g.slot}`).join("; ");
}

/**
 * Fora do horário configurado: frase para o aviso de transferência e o de
 * fila ("nossa equipe atende… sua mensagem fica registrada"). Vazio dentro
 * do horário ou sem horário configurado.
 */
export function outsideHoursNote(config: V2AgentConfig, now = new Date()): string {
  const summary = businessHoursSummary(config);
  if (!summary || isWithinV2BusinessHours(config, now)) return "";
  const back = teamReturnPhrase(config, now);
  // Texto da empresa em "Horário de atendimento"; {{horario}} vira o resumo
  // e {{retorno}} vira quando a equipe volta ("na terça-feira, 13/10, às 08:00").
  const custom = config.businessHours?.offHoursMessage?.trim();
  if (custom) {
    const text = custom.replace(/\{\{\s*horario\s*\}\}/g, summary).replace(/\{\{\s*retorno\s*\}\}/g, back.when);
    // Sem {{retorno}} no texto e com feriado/pausa no caminho, o cliente
    // contaria com o próximo horário normal: a data certa vai junto.
    return back.unusual && !/\{\{\s*retorno\s*\}\}/.test(custom) ? `${text} ${back.sentence}` : text;
  }
  return `Nossa equipe atende ${summary}. ${back.unusual ? `${back.reason}` : ""}Sua mensagem fica registrada e seguimos com você ${back.when}.`;
}

type LocalParts = { isoDate: string; weekday: number; minutes: number };

function localParts(date: Date, timeZone: string): LocalParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const weekday = weekdayFromString(get("weekday"));
    if (weekday === undefined) return null;
    return { isoDate: `${get("year")}-${get("month")}-${get("day")}`, weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
  } catch {
    return null;
  }
}

/** Pausa da equipe em andamento no instante (com a janela já convertida para instantes). */
export function activeTeamClosure(config: Pick<V2AgentConfig, "businessHours">, now = new Date()): { closure: V2TeamClosure; start: Date; end: Date } | null {
  const bh = config.businessHours;
  if (!bh) return null;
  for (const c of bh.closures ?? []) {
    const start = noticeInstant(c.startsAt, bh.timezone);
    const end = noticeInstant(c.endsAt, bh.timezone);
    if (start && end && start.getTime() <= now.getTime() && now.getTime() < end.getTime()) return { closure: c, start, end };
  }
  return null;
}

/** Feriado nacional sem expediente hoje (opção "Feriados nacionais sem expediente"). */
function closedHoliday(config: Pick<V2AgentConfig, "businessHours">, isoDate: string): string | null {
  return config.businessHours?.holidaysClosed ? brHolidayName(isoDate) : null;
}

export function isWithinV2BusinessHours(config: Pick<V2AgentConfig, "businessHours">, now = new Date()): boolean {
  const bh = config.businessHours;
  if (!bh || !bh.enabled || bh.weekdays.length === 0) return true;
  const local = localParts(now, bh.timezone);
  if (!local) return true;
  if (closedHoliday(config, local.isoDate)) return false;
  if (activeTeamClosure(config, now)) return false;
  // Todas as faixas do dia ("08:00–12:00 e 13:00–18:00"): antes só a primeira valia.
  return bh.weekdays.some((s: V2BusinessHoursSlot) => s.day === local.weekday && local.minutes >= parseTime(s.start) && local.minutes < parseTime(s.end));
}

/**
 * Quando a equipe volta: o próximo início de faixa depois de agora, pulando
 * feriado (se a opção estiver ligada) e pausas da equipe. `unusual` quando
 * um feriado ou uma pausa mudou a data em relação ao horário da semana.
 */
export function nextTeamOpening(config: Pick<V2AgentConfig, "businessHours">, now = new Date()): { at: Date; unusual: boolean; reason: string } | null {
  const bh = config.businessHours;
  if (!bh || !bh.enabled || bh.weekdays.length === 0) return null;
  // Candidatos: inícios de faixa nas próximas 3 semanas e fins de pausa.
  // A equipe volta no primeiro candidato que cai dentro do horário (faixa
  // do dia, sem feriado fechado e sem pausa) — inclusive o fim de uma pausa
  // no meio da faixa ("treinamento até 13:00" → volta às 13:00).
  const candidates: Date[] = [];
  const holidayDays: Array<{ isoDate: string; weekday: number; name: string }> = [];
  for (let i = 0; i < 21; i += 1) {
    const local = localParts(new Date(now.getTime() + i * 86_400_000), bh.timezone);
    if (!local) return null;
    const slots = bh.weekdays.filter((x: V2BusinessHoursSlot) => x.day === local.weekday);
    for (const x of slots) {
      const at = noticeInstant(`${local.isoDate}T${x.start}`, bh.timezone);
      if (at && at.getTime() > now.getTime()) candidates.push(at);
    }
    const holiday = slots.length > 0 ? closedHoliday(config, local.isoDate) : null;
    if (holiday) holidayDays.push({ isoDate: local.isoDate, weekday: local.weekday, name: holiday });
  }
  const closures = (bh.closures ?? [])
    .map((c) => ({ c, start: noticeInstant(c.startsAt, bh.timezone), end: noticeInstant(c.endsAt, bh.timezone) }))
    .filter((x): x is { c: V2TeamClosure; start: Date; end: Date } => !!x.start && !!x.end && x.end.getTime() > now.getTime());
  for (const x of closures) candidates.push(x.end);
  candidates.sort((a, b) => a.getTime() - b.getTime());

  const plainConfig = { businessHours: { ...bh, holidaysClosed: false, closures: [] } };
  const plain = candidates.find((at) => isWithinV2BusinessHours(plainConfig, at)) ?? null;
  const found = candidates.find((at) => isWithinV2BusinessHours(config, at));
  if (!found) return null;

  const reasons: string[] = [];
  const closureNow = activeTeamClosure(config, now);
  if (closureNow) reasons.push(`A equipe está em ${closureNow.closure.label?.trim() || "pausa"}.`);
  for (const x of closures) {
    if (closureNow && x.c.id === closureNow.closure.id) continue;
    if (x.start.getTime() < found.getTime()) {
      const r = `A equipe estará em ${x.c.label?.trim() || "pausa"}.`;
      if (!reasons.includes(r)) reasons.push(r);
    }
  }
  const foundDate = localParts(found, bh.timezone)?.isoDate ?? "";
  for (const h of holidayDays) {
    if (h.isoDate > foundDate) break;
    const label = `${WEEKDAY_NAMES[h.weekday]}, ${h.isoDate.slice(8, 10)}/${h.isoDate.slice(5, 7)}`;
    reasons.push(`${label.charAt(0).toUpperCase()}${label.slice(1)} é feriado (${h.name}).`);
  }
  // Pausa em andamento sem horário normal antes do fim dela também conta
  // como "fora do comum": o cliente precisa saber o motivo.
  const unusual = !plain || plain.getTime() !== found.getTime() || !!closureNow;
  return { at: found, unusual, reason: reasons.join(" ") };
}

function formatOpening(at: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "long" }).format(at);
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(at);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${weekday}, ${date}, às ${time}`;
}

/** "na terça-feira, 13/10, às 08:00" (ou "no próximo horário" sem cálculo possível). */
function teamReturnPhrase(config: Pick<V2AgentConfig, "businessHours">, now: Date): { when: string; sentence: string; unusual: boolean; reason: string } {
  const next = nextTeamOpening(config, now);
  if (!next || !config.businessHours) return { when: "no próximo horário", sentence: "", unusual: false, reason: "" };
  const when = `na ${formatOpening(next.at, config.businessHours.timezone)}`.replace(/^na (domingo|sábado)/, "no $1");
  const reason = next.reason ? `${next.reason} ` : "";
  return { when, sentence: `${reason}A equipe volta ${when}.`, unusual: next.unusual || !!next.reason, reason };
}

/** Linhas do prompt sobre feriado/pausa e quando a equipe volta. */
function teamAvailabilityLines(config: Pick<V2AgentConfig, "businessHours">, now: Date): string[] {
  const bh = config.businessHours;
  if (!bh) return [];
  const lines: string[] = [];
  if (bh.holidaysClosed) lines.push("- feriados nacionais: sem atendimento da equipe");
  const closure = activeTeamClosure(config, now);
  if (closure) lines.push(`- agora: equipe em ${closure.closure.label?.trim() || "pausa"} (sem atendimento humano)`);
  const next = nextTeamOpening(config, now);
  if (next && (next.unusual || next.reason)) lines.push(`- a equipe volta ${formatOpening(next.at, bh.timezone)}${next.reason ? ` (${next.reason.replace(/\.$/, "")})` : ""}`);
  return lines;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ");
}

/**
 * Palavra-chave casa com a palavra inteira ou com ela + até 3 letras no fim
 * (plural/gênero: "atendentes", "humanos"). Frase casa com a sequência de
 * palavras.
 *
 * Antes também valia "a palavra do cliente está DENTRO da palavra-chave":
 * "uma" ⊂ "hUMAno", "e"/"o" ⊂ "atendente"/"humano". Qualquer mensagem com
 * artigo disparava a regra "Pedido de humano" — o turno virava handoff sem
 * chamar o LLM e o cliente ficava sem resposta.
 */
function containsKeywords(text: string, keywords: string[]): boolean {
  const words = normalize(text).split(/\s+/).filter(Boolean);
  const joined = ` ${words.join(" ")} `;
  return keywords.some((kw) => {
    const kwWords = normalize(kw).split(/\s+/).filter(Boolean);
    if (kwWords.length === 0) return false;
    if (kwWords.length > 1) return joined.includes(` ${kwWords.join(" ")} `);
    const nk = kwWords[0];
    return words.some((w) => w === nk || (w.startsWith(nk) && w.length - nk.length <= 3));
  });
}

const sameText = (a: string | undefined, b: string) =>
  !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Valor da condição "etapa do negócio": o nome da etapa, o id dela ou
 * "Funil > Etapa". Só o nome casa com a etapa de mesmo nome em qualquer
 * funil; as outras duas formas apontam uma etapa só.
 */
export function dealStageMatches(
  value: string,
  input: Pick<V2RuleEvaluationInput, "dealStageName" | "dealStageId" | "dealPipelineName">,
): boolean {
  const v = value.trim();
  if (!v) return false;
  if (input.dealStageId && v === input.dealStageId) return true;
  const cut = v.indexOf(">");
  if (cut > 0) {
    const pipeline = v.slice(0, cut);
    const stage = v.slice(cut + 1);
    if (sameText(input.dealPipelineName, pipeline) && sameText(input.dealStageName, stage)) return true;
  }
  return sameText(input.dealStageName, v);
}

function evaluateCondition(
  condition: V2RuleCondition,
  input: V2RuleEvaluationInput,
  context: V2CRMContext,
): boolean {
  let result = false;
  switch (condition.type) {
    case "message_type":
      result = condition.values?.includes(input.messageType ?? "text") ?? false;
      break;
    case "keywords":
      result = containsKeywords(input.userMessage, condition.values ?? []);
      break;
    case "first_message":
      result = input.isFirstMessage;
      break;
    case "out_of_hours":
      result = !input.withinBusinessHours;
      break;
    case "contact_tag":
      result = condition.values?.some((v) => input.contactTags?.includes(v)) ?? false;
      break;
    case "deal_stage":
      result = condition.values?.some((v) => dealStageMatches(v, input)) ?? false;
      break;
    case "field_equals": {
      const value = context.contact?.[condition.field ?? ""] ?? context.selectedDeal?.[condition.field ?? ""];
      result = String(value).toLowerCase() === (condition.expected ?? "").toLowerCase();
      break;
    }
    case "no_deal":
      result = !context.selectedDeal;
      break;
    case "survey_received":
      result = input.surveyReceived ?? false;
      break;
    case "media_kind":
      result = condition.values?.some((v) => input.mediaKinds?.includes(v)) ?? false;
      break;
  }
  return condition.negate ? !result : result;
}

function evaluateRule(
  rule: V2Rule,
  input: V2RuleEvaluationInput,
  context: V2CRMContext,
): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => evaluateCondition(c, input, context));
}

export function evaluateV2Rules(
  config: V2AgentConfig,
  input: V2RuleEvaluationInput,
  context: V2CRMContext,
): V2Rule | null {
  const sorted = config.rules.filter((r) => r.enabled !== false).sort((a, b) => a.order - b.order);
  for (const rule of sorted) {
    if (evaluateRule(withHumanRequestTerms(rule, config, input.userMessage), input, context)) return rule;
  }
  return null;
}

/** Até quantas palavras a mensagem é um pedido curto ("atendente", "quero um humano"). */
export const HUMAN_REQUEST_SHORT_MESSAGE_WORDS = 4;

/**
 * Regra "Pedido de humano" (ligada): as palavras-chave valem junto com as de
 * "Chamar a equipe" e as frases explícitas — antes eram duas listas que
 * precisavam ser editadas juntas.
 *
 * Palavra solta ("atendente", "humano") só vale em mensagem curta. Numa
 * frase ("a atendente disse que o prazo era outro") ela não é pedido: a
 * regra transferia sem chamar o modelo. Ali valem as frases; o resto o
 * modelo decide.
 */
function withHumanRequestTerms(rule: V2Rule, config: V2AgentConfig, userMessage: string): V2Rule {
  if (!isHumanRequestRule(rule, config)) return rule;
  const terms = humanRequestTerms(config);
  const wordCount = (s: string) => normalize(s).split(/\s+/).filter(Boolean).length;
  const short = wordCount(userMessage) <= HUMAN_REQUEST_SHORT_MESSAGE_WORDS;
  return {
    ...rule,
    conditions: rule.conditions.map((c) =>
      c.type === "keywords"
        ? { ...c, values: [...new Set([...(c.values ?? []), ...terms])].filter((v) => short || wordCount(v) > 1) }
        : c,
    ),
  };
}

export function applyRuleActions(rule: V2Rule): V2RuleAction[] {
  return rule.actions;
}
