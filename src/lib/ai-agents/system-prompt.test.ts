import { afterEach, describe, expect, it, vi } from "vitest";

import { renderSystemPrompt, type RenderArgs } from "@/lib/ai-agents/system-prompt";

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
