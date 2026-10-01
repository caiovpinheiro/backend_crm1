/**
 * Avaliador ordenado de regras determinísticas da v2.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Rule, V2RuleAction, V2RuleCondition, V2CRMContext, V2BusinessHoursSlot } from "@/lib/ai-v2/types";
import { humanRequestTerms, isHumanRequestRule } from "@/lib/ai-v2/config";

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
export function businessHoursText(config: Pick<V2AgentConfig, "businessHours">): string {
  const bh = config.businessHours;
  if (!bh || !bh.enabled || bh.weekdays.length === 0) return "";
  return [1, 2, 3, 4, 5, 6, 0]
    .map((day) => {
      const slots = bh.weekdays.filter((s: V2BusinessHoursSlot) => s.day === day);
      return `- ${WEEKDAY_NAMES[day]}: ${slots.length ? slots.map((s: V2BusinessHoursSlot) => `${s.start} às ${s.end}`).join(" e ") : "sem atendimento"}`;
    })
    .join("\n");
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
  // Texto da empresa em "Horário de atendimento"; {{horario}} vira o resumo.
  const custom = config.businessHours?.offHoursMessage?.trim();
  if (custom) return custom.replace(/\{\{\s*horario\s*\}\}/g, summary);
  return `Nossa equipe atende ${summary}. Sua mensagem fica registrada e seguimos com você no próximo horário.`;
}

export function isWithinV2BusinessHours(config: V2AgentConfig, now = new Date()): boolean {
  const bh = config.businessHours;
  if (!bh || !bh.enabled || bh.weekdays.length === 0) return true;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: bh.timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const weekday = weekdayFromString(parts.find((p) => p.type === "weekday")?.value ?? "");
  if (weekday === undefined) return true;
  const minutes = hour * 60 + minute;
  const slot = bh.weekdays.find((s: V2BusinessHoursSlot) => s.day === weekday);
  if (!slot) return false;
  const start = parseTime(slot.start);
  const end = parseTime(slot.end);
  return minutes >= start && minutes < end;
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
