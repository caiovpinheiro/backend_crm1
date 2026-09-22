import { describe, expect, it } from "vitest";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { buildAskDealMessage, tryParseDealChoice } from "@/services/ai-v2/context";

function baseConfig(dealFields: V2AgentConfig["contextFields"]["deal"]): V2AgentConfig {
  return {
    name: "Agente",
    model: "gpt-4o-mini",
    responseBehavior: "balanced",
    tone: "Objetivo",
    globalRules: [],
    allowedDomains: [],
    contextFields: { contact: [], deal: dealFields },
    variables: [],
    entry: { confirmContact: false, onDealNotFound: "handoff" },
    handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: ["humano"] },
    closure: {},
    limits: {},
    media: {},
    sentiment: {},
    survey: {},
    themes: [],
    rules: [],
    autonomyMode: "auto",
  } as unknown as V2AgentConfig;
}

describe("modo 'perguntar qual negócio'", () => {
  const deals = [
    { id: "deal-a", title: "Matrícula Ensino Médio", stageName: "Proposta", value: 1200 },
    { id: "deal-b", title: "Curso de Inglês", stageName: "Negociação", value: 800 },
  ];

  it("lista de negócios mostra apenas campos marcados como 'Citar'", () => {
    const cfg = baseConfig([
      { key: "title", label: "Nome", permissions: ["cite"] },
      { key: "stageName", label: "Etapa", permissions: ["cite"] },
      { key: "value", label: "Valor", permissions: ["read"] },
    ]);
    const msg = buildAskDealMessage(deals, cfg);
    expect(msg).toContain("Matrícula Ensino Médio");
    expect(msg).toContain("Proposta");
    expect(msg).not.toContain("1200");
    expect(msg).not.toContain("800");
  });

  it("reconhece escolha pelo número da opção", () => {
    const cfg = baseConfig([
      { key: "title", label: "Nome", permissions: ["cite"] },
    ]);
    expect(tryParseDealChoice("quero o 2", deals, cfg)).toBe("deal-b");
    expect(tryParseDealChoice("1", deals, cfg)).toBe("deal-a");
  });

  it("reconhece escolha pelo nome/valor citável", () => {
    const cfg = baseConfig([
      { key: "title", label: "Nome", permissions: ["cite"] },
      { key: "stageName", label: "Etapa", permissions: ["read"] },
    ]);
    expect(tryParseDealChoice("vou querer o curso de inglês", deals, cfg)).toBe("deal-b");
    // 'stageName' é só Ler, então não deve ser usado para escolha.
    expect(tryParseDealChoice("negociação", deals, cfg)).toBeNull();
  });

  it("não confunde valor lido como identificador de negócio", () => {
    const cfg = baseConfig([
      { key: "title", label: "Nome", permissions: ["cite"] },
      { key: "value", label: "Valor", permissions: ["read"] },
    ]);
    expect(tryParseDealChoice("o de 1200", deals, cfg)).toBeNull();
  });
});
