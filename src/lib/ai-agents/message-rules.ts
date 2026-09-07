/**
 * Regras de mensagem — "quando a mensagem for sobre ISTO, o próximo passo é
 * AQUILO", declarado pelo operador na tela do agente.
 *
 * Este módulo é GENÉRICO de propósito: não existe aqui (nem pode existir)
 * nenhum termo de vertical — polo, curso, matrícula, retenção. O tema é dado
 * do operador; o código só avalia.
 *
 * Precedência é a ORDEM DA LISTA: a primeira regra habilitada que casar
 * decide o turno, e nada depois dela roda. Era exatamente isso que faltava:
 * a ordem dos interceptos determinísticos vivia implícita no código, então
 * tirar um termo de uma lista fazia o intercepto seguinte pegar a mensagem.
 */

export type MessageRuleAction =
  /// Deixa o agente responder normalmente, usando a base de conhecimento.
  /// É o próximo passo que não existia — e o que faltava para assunto que o
  /// operador documentou na base cair no modelo em vez de virar fila.
  | "answer_with_knowledge"
  /// Transfere para um departamento da organização.
  | "transfer_department"
  /// Transfere para a fila humana, sem fixar departamento.
  | "transfer_human"
  /// Responde um texto fixo, sem chamar o modelo.
  | "fixed_reply";

export const MESSAGE_RULE_ACTIONS: MessageRuleAction[] = [
  "answer_with_knowledge",
  "transfer_department",
  "transfer_human",
  "fixed_reply",
];

export type MessageRule = {
  id: string;
  /// Nome que o operador dá à regra ("Assunto de polo").
  label: string;
  enabled: boolean;
  /// Casa se QUALQUER termo aparecer na mensagem (sem acento/caixa).
  anyOf: string[];
  /// Só casa se TODOS estes termos aparecerem.
  allOf: string[];
  /// Não casa se algum destes aparecer.
  noneOf: string[];
  action: MessageRuleAction;
  /// Só em `transfer_department`: nome do departamento da organização.
  department: string | null;
  /// `fixed_reply`: o texto (obrigatório). Transferências: texto do aviso
  /// ao cliente (`null` = o agente usa o texto de fila já configurado).
  message: string | null;
};

/** Rótulos pt-BR de operador. O FE não deve traduzir o nome técnico. */
export const MESSAGE_RULE_LABELS: {
  matchTitle: string;
  matchHint: string;
  actionTitle: string;
  actions: Array<{ id: MessageRuleAction; label: string; hint: string }>;
} = {
  matchTitle: "Quando a mensagem for sobre",
  matchHint:
    "Escreva os termos como o cliente escreve. Basta um deles aparecer na mensagem.",
  actionTitle: "O que fazer",
  actions: [
    {
      id: "answer_with_knowledge",
      label: "Deixar o agente responder usando a base de conhecimento",
      hint: "O agente responde com os documentos da base, sem transferir.",
    },
    {
      id: "transfer_department",
      label: "Transferir para um departamento",
      hint: "A conversa vai para a fila do departamento escolhido.",
    },
    {
      id: "transfer_human",
      label: "Transferir para a fila de atendimento humano",
      hint: "Sem escolher departamento — entra na fila geral.",
    },
    {
      id: "fixed_reply",
      label: "Responder com um texto fixo",
      hint: "O agente envia exatamente o texto escrito, sem chamar o modelo.",
    },
  ],
};

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function termList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isAction(v: unknown): v is MessageRuleAction {
  return (
    typeof v === "string" &&
    MESSAGE_RULE_ACTIONS.includes(v as MessageRuleAction)
  );
}

/**
 * Regra sem critério casaria com tudo, e regra sem destino não tem próximo
 * passo executável: as duas são descartadas na normalização em vez de
 * virarem surpresa em produção.
 */
export function normalizeMessageRules(v: unknown): MessageRule[] {
  if (!Array.isArray(v)) return [];
  const out: MessageRule[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const action = isAction(r.action) ? r.action : null;
    if (!action) continue;
    const anyOf = termList(r.anyOf);
    const allOf = termList(r.allOf);
    if (anyOf.length === 0 && allOf.length === 0) continue;
    const department = text(r.department);
    const message = text(r.message);
    if (action === "transfer_department" && !department) continue;
    if (action === "fixed_reply" && !message) continue;
    const id = text(r.id) ?? `regra-${out.length + 1}`;
    if (out.some((existing) => existing.id === id)) continue;
    out.push({
      id,
      label: text(r.label) ?? id,
      enabled: r.enabled !== false,
      anyOf,
      allOf,
      noneOf: termList(r.noneOf),
      action,
      department: action === "transfer_department" ? department : null,
      message: action === "answer_with_knowledge" ? null : message,
    });
  }
  return out;
}

export function messageRuleMatches(
  message: string | null | undefined,
  rule: MessageRule,
): boolean {
  const haystack = fold(message ?? "");
  if (!haystack) return false;
  const has = (term: string) => {
    const needle = fold(term);
    return needle.length > 0 && haystack.includes(needle);
  };
  if (rule.noneOf.some(has)) return false;
  if (rule.allOf.length > 0 && !rule.allOf.every(has)) return false;
  if (rule.anyOf.length > 0) return rule.anyOf.some(has);
  return rule.allOf.length > 0;
}

export type MessageRuleHit = {
  rule: MessageRule;
  /// Posição da regra na lista (1-based) — é a precedência que o operador vê.
  position: number;
};

/** Primeira regra habilitada que casa. Avaliação é código, não instrução. */
export function evaluateMessageRules(
  message: string | null | undefined,
  rules: MessageRule[] | null | undefined,
): MessageRuleHit | null {
  if (!rules?.length) return null;
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (!rule.enabled) continue;
    if (messageRuleMatches(message, rule)) return { rule, position: i + 1 };
  }
  return null;
}

/**
 * Departamento que as regras do operador definem para a mensagem — sem
 * executar nada. Usado por quem só precisa SABER o destino (inferência de
 * departamento, hint de tool).
 */
export function departmentFromMessageRules(
  message: string | null | undefined,
  rules: MessageRule[] | null | undefined,
): string | null {
  const hit = evaluateMessageRules(message, rules);
  if (!hit) return null;
  return hit.rule.action === "transfer_department" ? hit.rule.department : null;
}
