import { describe, expect, it } from "vitest";

import {
  defaultWebchatV2Config,
  isImportantWebchatEvent,
  matchWebchatRoutingRules,
  normalizeWebchatV2Config,
  readWebchatV2Config,
  WebchatV2ConfigError,
} from "@/lib/webchat/v2-config";

const base = defaultWebchatV2Config();

describe("defaultWebchatV2Config", () => {
  it("nasce seguro: anônimo desligado, sem callback, sem regras, match por externalId", () => {
    expect(base.context.anonymous).toBe(false);
    expect(base.s2s).toEqual({ queueTagId: null, callbackUrl: null, rules: [] });
    expect(base.identity).toEqual({ matchField: { type: "externalId" }, attributeMap: [] });
    expect(base.events.importantOpensConversation).toBe(false);
    expect(base.refDealCustomFieldId).toBeNull();
  });
});

describe("normalizeWebchatV2Config", () => {
  it("patch parcial em qualquer nível mantém o resto", () => {
    const out = normalizeWebchatV2Config({ context: { labels: { etapa_atual: "Etapa" } } }, base);
    expect(out.context.labels).toEqual({ etapa_atual: "Etapa" });
    expect(out.context.maxKeys).toBe(base.context.maxKeys);
    expect(out.events).toEqual(base.events);
  });

  it("undefined/null devolve a base", () => {
    expect(normalizeWebchatV2Config(undefined, base)).toBe(base);
    expect(normalizeWebchatV2Config(null, base)).toBe(base);
  });

  it("aceita match por campo personalizado e mapeamento de atributos", () => {
    const out = normalizeWebchatV2Config(
      {
        identity: {
          matchField: { type: "customField", customFieldId: "cf_1" },
          attributeMap: [{ attribute: "plano", customFieldId: "cf_2" }],
        },
      },
      base,
    );
    expect(out.identity.matchField).toEqual({ type: "customField", customFieldId: "cf_1" });
    expect(out.identity.attributeMap).toEqual([{ attribute: "plano", customFieldId: "cf_2" }]);
  });

  it.each([
    [{ context: { maxKeys: 0 } }],
    [{ context: { maxKeys: 101 } }],
    [{ context: { maxValueChars: 2.5 } }],
    [{ events: { retentionDays: 400 } }],
    [{ events: { maxPerBatch: 51 } }],
    [{ events: { important: ["com espaço"] } }],
    [{ context: { labels: { "chave inválida": "x" } } }],
    [{ identity: { matchField: { type: "email" } } }],
    [{ identity: { attributeMap: [{ attribute: "a", customFieldId: "x" }, { attribute: "a", customFieldId: "y" }] } }],
    [{ s2s: { callbackUrl: "http://site.test/cb" } }],
    [{ s2s: { callbackUrl: "https://u:p@site.test/cb" } }],
    [{ s2s: { rules: [{ tagId: "t1" }] } }],
    [{ s2s: { rules: [{ category: "a" }] } }],
    [{ refDealCustomFieldId: "id com espaço" }],
    [{ context: "x" }],
  ])("rejeita %j", (patch) => {
    expect(() => normalizeWebchatV2Config(patch, base)).toThrow(WebchatV2ConfigError);
  });

  it("callbackUrl https e regras válidas; null limpa", () => {
    const out = normalizeWebchatV2Config(
      {
        s2s: {
          callbackUrl: "https://site.test/cb",
          queueTagId: "tag_1",
          rules: [{ priority: " Alta ", pinNote: true }, { category: "suporte", departmentId: "dep_1" }],
        },
        refDealCustomFieldId: "cf_deal",
      },
      base,
    );
    expect(out.s2s.callbackUrl).toBe("https://site.test/cb");
    expect(out.s2s.rules).toEqual([
      { priority: "Alta", pinNote: true },
      { category: "suporte", departmentId: "dep_1" },
    ]);
    const cleared = normalizeWebchatV2Config(
      { s2s: { callbackUrl: null, queueTagId: "" }, refDealCustomFieldId: null },
      out,
    );
    expect(cleared.s2s.callbackUrl).toBeNull();
    expect(cleared.s2s.queueTagId).toBeNull();
    expect(cleared.refDealCustomFieldId).toBeNull();
    expect(cleared.s2s.rules).toHaveLength(2);
  });

  it("rótulo vazio é descartado; nomes importantes sem repetição", () => {
    const out = normalizeWebchatV2Config(
      { context: { labels: { a: " ", b: "B" } }, events: { important: ["erro", "erro", "pagamento.falhou"] } },
      base,
    );
    expect(out.context.labels).toEqual({ b: "B" });
    expect(out.events.important).toEqual(["erro", "pagamento.falhou"]);
  });
});

describe("readWebchatV2Config", () => {
  it("config sem v2 = defaults", () => {
    expect(readWebchatV2Config({ publicKey: "wc_x" })).toEqual(base);
    expect(readWebchatV2Config(null)).toEqual(base);
  });

  it("bloco inválido volta ao default sem derrubar os válidos", () => {
    const out = readWebchatV2Config({
      v2: { context: { maxKeys: 9999 }, events: { retentionDays: 7 } },
    });
    expect(out.context).toEqual(base.context);
    expect(out.events.retentionDays).toBe(7);
  });
});

describe("regras e eventos importantes", () => {
  const rules = normalizeWebchatV2Config(
    {
      s2s: {
        rules: [
          { priority: "alta", pinNote: true },
          { category: "financeiro", priority: "alta", tagId: "t1" },
          { category: "suporte", departmentId: "d1" },
        ],
      },
    },
    base,
  ).s2s.rules;

  it("casa todos os critérios presentes, sem caixa", () => {
    expect(matchWebchatRoutingRules(rules, { category: "Financeiro", priority: "ALTA" })).toHaveLength(2);
    expect(matchWebchatRoutingRules(rules, { priority: "alta" })).toEqual([{ priority: "alta", pinNote: true }]);
    expect(matchWebchatRoutingRules(rules, { category: "outro" })).toEqual([]);
  });

  it("importante pelo site ou pela lista do canal", () => {
    const cfg = normalizeWebchatV2Config({ events: { important: ["erro"] } }, base);
    expect(isImportantWebchatEvent("erro", false, cfg)).toBe(true);
    expect(isImportantWebchatEvent("clique", true, cfg)).toBe(true);
    expect(isImportantWebchatEvent("clique", undefined, cfg)).toBe(false);
  });
});
