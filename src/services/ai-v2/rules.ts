/**
 * Avaliador ordenado de regras determinísticas da v2.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Rule, V2RuleAction, V2RuleCondition, V2CRMContext, V2BusinessHoursSlot } from "@/lib/ai-v2/types";

export type V2RuleEvaluationInput = {
  userMessage: string;
  messageType?: string;
  isFirstMessage: boolean;
  mediaKinds?: string[];
  contactTags?: string[];
  dealStageName?: string;
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
      result = condition.values?.some((v) => input.dealStageName?.toLowerCase() === v.toLowerCase()) ?? false;
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
    if (evaluateRule(rule, input, context)) return rule;
  }
  return null;
}

export function applyRuleActions(rule: V2Rule): V2RuleAction[] {
  return rule.actions;
}
