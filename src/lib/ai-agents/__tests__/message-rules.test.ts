/**
 * Motor de regras: avaliação determinística, precedência pela ordem da
 * lista e nenhuma palavra de vertical no código.
 */
import { describe, expect, it } from "vitest";

import {
  departmentFromMessageRules,
  evaluateMessageRules,
  normalizeMessageRules,
  type MessageRule,
} from "@/lib/ai-agents/message-rules";
import { defaultInboxPolicy, normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { inferDepartmentFromContext } from "@/verticals/academic/department-routing";

const POLO_PHRASES = [
  "quero trocar de polo",
  "quero mudar de polo",
  "quero transferir de polo",
  "me colocaram num polo distante",
];

function rule(over: Partial<MessageRule>): MessageRule {
  return {
    id: "r",
    label: "Regra",
    enabled: true,
    anyOf: [],
    allOf: [],
    noneOf: [],
    action: "answer_with_knowledge",
    department: null,
    message: null,
    ...over,
  };
}

describe("evaluateMessageRules", () => {
  it("as quatro frases de polo caem na MESMA regra", () => {
    const rules = [rule({ id: "polo", anyOf: ["polo"] })];
    const hits = POLO_PHRASES.map((p) => evaluateMessageRules(p, rules));

    expect(hits.every((h) => h?.rule.id === "polo")).toBe(true);
    expect(new Set(hits.map((h) => h?.rule.action)).size).toBe(1);
  });

  it("a primeira regra da lista vence — precedência é a ordem", () => {
    const rules = [
      rule({ id: "polo", anyOf: ["polo"] }),
      rule({
        id: "retencao",
        anyOf: ["trocar de polo"],
        action: "transfer_department",
        department: "Retenção",
      }),
    ];

    expect(evaluateMessageRules("quero trocar de polo", rules)?.rule.id).toBe(
      "polo",
    );
    expect(evaluateMessageRules("quero trocar de polo", [...rules].reverse())
      ?.rule.id).toBe("retencao");
  });

  it("regra desligada não decide nada", () => {
    const rules = [rule({ id: "polo", anyOf: ["polo"], enabled: false })];
    expect(evaluateMessageRules("trocar de polo", rules)).toBeNull();
  });

  it("noneOf veta e allOf exige todos", () => {
    const rules = [
      rule({ id: "a", anyOf: ["polo"], noneOf: ["cancelar"] }),
      rule({ id: "b", allOf: ["polo", "endereco"] }),
    ];

    expect(evaluateMessageRules("quero cancelar e mudar de polo", rules)).toBeNull();
    expect(evaluateMessageRules("qual o endereço do polo", rules)?.rule.id).toBe(
      "a",
    );
    expect(evaluateMessageRules("quero cancelar meu polo", rules)).toBeNull();
  });

  it("regra sem critério ou sem destino é descartada na normalização", () => {
    const normalized = normalizeMessageRules([
      { id: "sem-criterio", action: "transfer_human" },
      { id: "sem-depto", action: "transfer_department", anyOf: ["x"] },
      { id: "sem-texto", action: "fixed_reply", anyOf: ["x"] },
      { id: "ok", action: "transfer_human", anyOf: ["x"] },
    ]);

    expect(normalized.map((r) => r.id)).toEqual(["ok"]);
  });

  it("só regra de transferência devolve departamento", () => {
    const rules = [
      rule({ id: "polo", anyOf: ["polo"] }),
      rule({
        id: "cancel",
        anyOf: ["cancelar"],
        action: "transfer_department",
        department: "Retenção",
      }),
    ];

    expect(departmentFromMessageRules("trocar de polo", rules)).toBeNull();
    expect(departmentFromMessageRules("quero cancelar", rules)).toBe("Retenção");
  });
});

describe("regras semeadas do pack academic", () => {
  it("agente sem configuração salva herda as regras que eram regex fixo", () => {
    const policy = normalizeInboxPolicy(null, "academic");
    const ids = policy.messageRules.map((r) => r.id);

    expect(ids).toContain("academic-retencao-cancelamento");
    expect(ids).toContain("academic-retencao-troca-curso-polo");
    expect(
      evaluateMessageRules("quero trancar a matrícula", policy.messageRules)
        ?.rule.action,
    ).toBe("transfer_department");
  });

  it("lista salva vence — inclusive vazia (operador removeu)", () => {
    const policy = normalizeInboxPolicy(
      { messageRules: [] },
      "academic",
    );
    expect(policy.messageRules).toEqual([]);
  });

  it("agente sem pack não herda regra nenhuma", () => {
    expect(normalizeInboxPolicy(null, null).messageRules).toEqual([]);
    expect(defaultInboxPolicy().messageRules).toEqual([]);
  });
});

describe("inferDepartmentFromContext sem regex fixo", () => {
  it("as quatro frases de polo deixam de virar retenção quando a regra manda responder", () => {
    const policy = normalizeInboxPolicy(
      {
        messageRules: [
          {
            id: "polo",
            label: "Assunto de polo",
            action: "answer_with_knowledge",
            anyOf: ["polo"],
          },
          ...normalizeInboxPolicy(null, "academic").messageRules,
        ],
      },
      "academic",
    );

    for (const phrase of POLO_PHRASES) {
      expect(
        inferDepartmentFromContext({ userMessage: phrase, policy }),
        phrase,
      ).not.toBe("retencao");
    }
  });

  it("cancelamento continua indo para retenção pelas regras semeadas", () => {
    const policy = normalizeInboxPolicy(null, "academic");

    expect(
      inferDepartmentFromContext({
        userMessage: "quero cancelar minha matrícula",
        policy,
      }),
    ).toBe("retencao");
    expect(
      inferDepartmentFromContext({
        userMessage: "quero trocar de curso",
        policy,
      }),
    ).toBe("retencao");
  });
});
