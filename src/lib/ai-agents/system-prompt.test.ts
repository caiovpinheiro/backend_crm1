import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composeRuntimeOverride,
  duplicatesSteeringRules,
  fallbackSteeringRules,
  renderSystemPrompt,
  type RenderArgs,
} from "@/lib/ai-agents/system-prompt";
import {
  ACADEMIC_SYSTEM_PROMPT_OVERRIDE,
} from "@/verticals/academic/atendimento-prompt";

/**
 * A data atual é FATO injetado no prompt. Antes disso o agente não sabia
 * se um prazo já passou e inventava datas/semestres inexistentes.
 */
const BASE: RenderArgs = {
  template: "Você é {{agent_name}} da {{company_name}}.",
  override: null,
  productPolicy: null,
  hasProductSearch: false,
  hasEnrollmentLookup: false,
  hasCrmFieldSearch: false,
  tone: "profissional",
  language: "pt-BR",
  autonomyMode: "AUTONOMOUS",
  contact: null,
  deal: null,
  retrievalBlock: "",
  qualificationQuestions: [],
  outputStyle: "conversational",
  templateVars: { agent_name: "Julia", company_name: "EduIT" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("renderSystemPrompt — data de referência", () => {
  it("injeta dia da semana, data e hora em pt-BR no fuso do agente", () => {
    const prompt = renderSystemPrompt({
      ...BASE,
      timezone: "America/Sao_Paulo",
      now: new Date("2026-09-07T19:20:00Z"),
    });
    expect(prompt).toContain(
      "DATA E HORA ATUAIS (fato do sistema, fuso America/Sao_Paulo): segunda-feira, 07/09/2026, 16:20.",
    );
    expect(prompt).toContain("NUNCA infira nem invente outra data");
  });

  it("coloca a data no início do prompt, antes da base de conhecimento", () => {
    const prompt = renderSystemPrompt({
      ...BASE,
      timezone: "America/Sao_Paulo",
      now: new Date("2026-09-07T19:20:00Z"),
      retrievalBlock: "BASE DE CONHECIMENTO:\n- doc",
    });
    expect(prompt.indexOf("DATA E HORA ATUAIS")).toBeLessThan(
      prompt.indexOf("BASE DE CONHECIMENTO"),
    );
    expect(prompt.indexOf("Você é Julia da EduIT.")).toBeLessThan(
      prompt.indexOf("DATA E HORA ATUAIS"),
    );
  });

  it("muda conforme o relógio quando `now` não é passado", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T19:20:00Z"));
    expect(
      renderSystemPrompt({ ...BASE, timezone: "America/Sao_Paulo" }),
    ).toContain("segunda-feira, 07/09/2026, 16:20");

    vi.setSystemTime(new Date("2026-12-21T11:05:00Z"));
    expect(
      renderSystemPrompt({ ...BASE, timezone: "America/Sao_Paulo" }),
    ).toContain("segunda-feira, 21/12/2026, 08:05");
  });

  it("respeita o fuso configurado do agente", () => {
    const prompt = renderSystemPrompt({
      ...BASE,
      timezone: "America/Manaus",
      now: new Date("2026-09-08T02:30:00Z"),
    });
    expect(prompt).toContain("fuso America/Manaus): segunda-feira, 07/09/2026, 22:30.");
  });

  it("sem fuso configurado cai no default America/Sao_Paulo", () => {
    const prompt = renderSystemPrompt({
      ...BASE,
      now: new Date("2026-09-07T19:20:00Z"),
    });
    expect(prompt).toContain("fuso America/Sao_Paulo): segunda-feira, 07/09/2026, 16:20.");
  });
});

/**
 * `systemPromptOverride` salvo no banco é a MESMA regra que o fallback do
 * arquétipo. Com `steeringRules` vazio o runner injetava o documento duas
 * vezes — 45.969 caracteres de prompt, com `## IDENTIDADE`, `## REGRAS
 * ABSOLUTAS` e `## CONFIANÇA` repetidos em versões divergentes.
 */
describe("override duplicado das regras de steering", () => {
  const fallback = fallbackSteeringRules("ATENDIMENTO", "academic");

  /** A cópia velha do banco: mesmas seções, texto que já divergiu. */
  const staleCopy = ACADEMIC_SYSTEM_PROMPT_OVERRIDE.split(/\r?\n/)
    .map((l) => (l.startsWith("#") ? l : l.slice(0, Math.ceil(l.length / 2))))
    .join("\n");

  it("reconhece a cópia salva, idêntica ou divergente", () => {
    expect(duplicatesSteeringRules(ACADEMIC_SYSTEM_PROMPT_OVERRIDE, fallback)).toBe(
      true,
    );
    expect(duplicatesSteeringRules(staleCopy, fallback)).toBe(true);
  });

  it("override de verdade do operador é preservado", () => {
    const own = "Sempre confirme o CPF antes de falar de pagamento.";
    expect(duplicatesSteeringRules(own, fallback)).toBe(false);
    expect(duplicatesSteeringRules(null, fallback)).toBe(false);
    expect(duplicatesSteeringRules(own, "")).toBe(false);
  });

  it("com steeringRules vazio, o documento entra uma vez só", () => {
    // O que a montagem antiga (concat direto) produzia.
    expect([staleCopy, fallback].join("\n\n").split("## IDENTIDADE").length - 1)
      .toBe(2);

    const composed =
      composeRuntimeOverride({
        savedOverride: staleCopy,
        // Vazio no banco → o runner usa o fallback do arquétipo.
        steeringRules: fallback,
        blocks: ["## QUANDO VOCÊ NÃO SOUBER (regra dura)"],
      }) ?? "";

    for (const heading of [
      "## IDENTIDADE",
      "## REGRAS ABSOLUTAS",
      "## COMO CONVERSAR",
      "## CONFIANÇA (obrigatório)",
    ]) {
      expect(composed.split(heading).length - 1, heading).toBe(1);
    }
    expect(composed).toContain("## QUANDO VOCÊ NÃO SOUBER (regra dura)");
    expect(composed.length).toBeLessThan(fallback.length + 2000);
  });

  it("override diferente continua somando com as regras", () => {
    const own = "Sempre confirme o CPF antes de falar de pagamento.";
    const composed = composeRuntimeOverride({
      savedOverride: own,
      steeringRules: fallback,
      blocks: [null, "  ", "bloco final"],
    });

    expect(composed).toContain(own);
    expect(composed).toContain("## REGRAS ABSOLUTAS");
    expect(composed?.endsWith("bloco final")).toBe(true);
    expect(composed?.indexOf(own)).toBe(0);
  });

  it("sem nada para injetar devolve null", () => {
    expect(composeRuntimeOverride({})).toBeNull();
    expect(
      composeRuntimeOverride({ savedOverride: "   ", steeringRules: "" }),
    ).toBeNull();
  });
});
