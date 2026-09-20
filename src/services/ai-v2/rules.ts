/**
 * Avaliador ordenado de regras determinísticas da v2.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Rule, V2RuleAction, V2RuleCondition, V2CRMContext } from "@/lib/ai-v2/types";

export type V2RuleEvaluationInput = {
  userMessage: string;
  messageType?: string;
  isFirstMessage: boolean;
  mediaKinds?: string[];
  contactTags?: string[];
  dealStageName?: string;
  withinBusinessHours: boolean;
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ");
}

function containsKeywords(text: string, keywords: string[]): boolean {
  const nt = normalize(text);
  const words = nt.split(/\s+/).filter(Boolean);
  return keywords.some((kw) => {
    const nk = normalize(kw);
    if (!nk) return false;
    // Palavra exata ou substring de uma palavra? Usamos substring dentro de tokens.
    return words.some((w) => w.includes(nk) || nk.includes(w));
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
      result = false; // preenchido externamente se necessário
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
  const sorted = [...config.rules].sort((a, b) => a.order - b.order);
  for (const rule of sorted) {
    if (evaluateRule(rule, input, context)) return rule;
  }
  return null;
}

export function applyRuleActions(rule: V2Rule): V2RuleAction[] {
  return rule.actions;
}
