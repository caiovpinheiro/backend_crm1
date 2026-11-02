import { describe, expect, it } from "vitest";

import {
  defaultWebchatAppearance,
  defaultWebchatV2Config,
  hasWebchatRoutingEffect,
  isImportantWebchatEvent,
  matchWebchatRoutingRules,
  normalizeWebchatV2Config,
  readWebchatV2Config,
  resolveS2SRouting,
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

describe("identidade por campo de negócio e atendimento (§9.12)", () => {
  const base = () => defaultWebchatV2Config();

  it("padrão não muda nada", () => {
    expect(hasWebchatRoutingEffect(base().routing)).toBe(false);
    expect(base().routing).toEqual({
      priority: "standard",
      destination: { type: "distribution" },
      keepCurrentOwner: true,
      fallback: { type: "distribution" },
    });
  });

  it("aceita campo de negócio; normalização padrão é none", () => {
    const res = normalizeWebchatV2Config(
      { identity: { matchField: { type: "dealCustomField", customFieldId: "f1" } } },
      base(),
    );
    expect(res.identity.matchField).toEqual({ type: "dealCustomField", customFieldId: "f1", normalize: "none" });
  });

  it("recusa normalização ou tipo inválidos", () => {
    const bad = { identity: { matchField: { type: "dealCustomField", customFieldId: "f1", normalize: "x" } } };
    expect(() => normalizeWebchatV2Config(bad, base())).toThrow(WebchatV2ConfigError);
    expect(() =>
      normalizeWebchatV2Config({ identity: { matchField: { type: "outro" } } }, base()),
    ).toThrow(WebchatV2ConfigError);
  });

  it("routing parcial mescla sobre o gravado", () => {
    const first = normalizeWebchatV2Config(
      { routing: { priority: "high", destination: { type: "user", id: "u1" } } },
      base(),
    );
    const second = normalizeWebchatV2Config({ routing: { keepCurrentOwner: false } }, first);
    expect(second.routing).toMatchObject({
      priority: "high",
      destination: { type: "user", id: "u1" },
      keepCurrentOwner: false,
    });
    expect(hasWebchatRoutingEffect(second.routing)).toBe(true);
  });

  it.each([
    [{ priority: "urgente" }],
    [{ destination: { type: "fila" } }],
    [{ destination: { type: "user" } }],
    [{ fallback: { type: "department", id: "com espaço" } }],
    [{ keepCurrentOwner: "sim" }],
  ])("routing inválido é recusado: %j", (routing) => {
    expect(() => normalizeWebchatV2Config({ routing }, base())).toThrow(WebchatV2ConfigError);
  });

  it("leitura tolerante: routing ruim volta ao padrão e o resto fica", () => {
    const res = readWebchatV2Config({
      v2: { routing: { priority: "urgente" }, context: { anonymous: true } },
    });
    expect(res.routing).toEqual(base().routing);
    expect(res.context.anonymous).toBe(true);
  });

  it("regra aceita destino e prioridade como ação", () => {
    const res = normalizeWebchatV2Config(
      {
        s2s: {
          rules: [{ priority: "high", destination: { type: "ai_agent", id: "a1" }, queuePriority: "high" }],
        },
      },
      base(),
    );
    expect(res.s2s.rules[0]).toEqual({
      priority: "high",
      destination: { type: "ai_agent", id: "a1" },
      queuePriority: "high",
    });
    expect(() =>
      normalizeWebchatV2Config({ s2s: { rules: [{ priority: "high", queuePriority: "baixa" }] } }, base()),
    ).toThrow(WebchatV2ConfigError);
  });

  it("S2S: primeira regra com destino vence; alta vale se canal ou regra pedir", () => {
    const channel = {
      ...base().routing,
      destination: { type: "department", id: "d" } as const,
    };
    const a = { priority: "high", destination: { type: "user", id: "u1" } as const };
    const b = { priority: "high", destination: { type: "user", id: "u2" } as const, queuePriority: "high" as const };
    expect(resolveS2SRouting(channel, [a, b])).toEqual({
      routing: { ...channel, destination: { type: "user", id: "u1" }, priority: "high" },
      force: true,
      departmentId: null,
    });
    expect(resolveS2SRouting(channel, [])).toEqual({ routing: channel, force: false, departmentId: null });
    const high = { ...channel, priority: "high" as const };
    expect(resolveS2SRouting(high, [{ priority: "x", tagId: "t" }]).routing.priority).toBe("high");
  });
});

describe("appearance (§9.15)", () => {
  const topic = (over: Record<string, unknown> = {}) => ({
    id: "t1",
    label: "Acesso",
    icon: "lock",
    action: { type: "write" },
    ...over,
  });
  const option = (over: Record<string, unknown> = {}) => ({
    id: "o1",
    label: "Senha",
    action: { type: "send_text", text: "Travei na senha" },
    ...over,
  });
  const appearance = (patch: unknown) => normalizeWebchatV2Config({ appearance: patch }, base).appearance;
  const withTopics = (...topics: unknown[]) => ({ start: { topics } });

  it("padrão: compact, sem expandir, sem tópicos, faixa e fechamento desligados", () => {
    expect(base.appearance).toEqual({
      model: "compact",
      allowExpand: false,
      start: { topics: [] },
      contextBanner: { enabled: false },
      closing: { enabled: false },
    });
  });

  it("aceita o contrato inteiro, com as três ações e followUp", () => {
    const full = {
      model: "guided",
      allowExpand: true,
      start: {
        title: "Em que podemos ajudar?",
        subtitle: "Escolha um assunto",
        writeLabel: "Escrever",
        topics: [
          topic({
            action: { type: "send_text", text: "Quero falar sobre acesso" },
            followUp: {
              question: "Em qual etapa?",
              hint: "Se preferir, descreva",
              options: [
                option(),
                option({ id: "o2", action: { type: "open_url", url: "https://exemplo.test/ajuda", label: "Ver" } }),
                option({ id: "o3", action: { type: "write" } }),
              ],
            },
          }),
          topic({ id: "t2", icon: "help" }),
        ],
      },
      contextBanner: { enabled: true, titleKey: "curso.nome", subtitleKey: "etapa_atual" },
      closing: { enabled: true, resolvedLabel: "Resolvido", needHelpLabel: "Preciso de ajuda" },
    };
    expect(appearance(full)).toEqual(full);
  });

  it("patch parcial mantém o resto; topics troca a lista inteira", () => {
    const saved = normalizeWebchatV2Config(
      {
        appearance: {
          model: "assisted",
          start: { title: "Oi", topics: [topic()] },
          closing: { enabled: true, resolvedLabel: "Ok" },
        },
      },
      base,
    );

    const partial = normalizeWebchatV2Config({ appearance: { start: { subtitle: "Sub" } } }, saved).appearance;
    expect(partial.model).toBe("assisted");
    expect(partial.start).toEqual({ title: "Oi", subtitle: "Sub", topics: saved.appearance.start.topics });
    expect(partial.closing).toEqual({ enabled: true, resolvedLabel: "Ok" });

    const replaced = normalizeWebchatV2Config(
      { appearance: { start: { topics: [topic({ id: "t9" })] } } },
      saved,
    ).appearance;
    expect(replaced.start.topics.map((t) => t.id)).toEqual(["t9"]);

    const other = normalizeWebchatV2Config({ context: { anonymous: true } }, saved);
    expect(other.appearance).toEqual(saved.appearance);
  });

  it("null ou vazio limpa o texto opcional, sem deixar a chave no JSON", () => {
    const saved = normalizeWebchatV2Config(
      {
        appearance: {
          start: { title: "Oi", subtitle: "Sub" },
          contextBanner: { titleKey: "curso" },
        },
      },
      base,
    );
    const out = normalizeWebchatV2Config(
      { appearance: { start: { title: null, subtitle: "   " }, contextBanner: { titleKey: "" } } },
      saved,
    ).appearance;
    expect(Object.keys(out.start)).toEqual(["topics"]);
    expect(Object.keys(out.contextBanner)).toEqual(["enabled"]);
  });

  it("apara os textos, descarta campo desconhecido e tira o followUp null", () => {
    const out = appearance(
      withTopics({
        ...topic({ label: "  Acesso  ", followUp: null, html: "<b>x</b>" }),
        action: { type: "write", text: "ignorado", extra: 1 },
      }),
    );
    expect(out.start.topics).toEqual([
      { id: "t1", label: "Acesso", icon: "lock", action: { type: "write" } },
    ]);
  });

  it("texto com marcação fica como texto, sem filtro nem conversão", () => {
    const out = appearance(withTopics(topic({ label: "<b>Oi</b> & tchau" })));
    expect(out.start.topics[0].label).toBe("<b>Oi</b> & tchau");
  });

  it("aceita os limites exatos", () => {
    const topics = Array.from({ length: 6 }, (_, i) =>
      topic({ id: `t${i}`, label: "x".repeat(40), action: { type: "send_text", text: "y".repeat(500) } }),
    );
    const options = Array.from({ length: 6 }, (_, i) => option({ id: `o${i}` }));
    topics[0] = topic({ id: "t0", followUp: { question: "q".repeat(200), hint: "h".repeat(160), options } });
    const out = appearance({
      start: { title: "t".repeat(80), subtitle: "s".repeat(160), writeLabel: "w".repeat(40), topics },
      closing: { resolvedLabel: "r".repeat(40), needHelpLabel: "n".repeat(40) },
    });
    expect(out.start.topics).toHaveLength(6);
    expect(out.start.topics[0].followUp?.options).toHaveLength(6);
  });

  it("normaliza a URL de open_url", () => {
    const out = appearance(
      withTopics(topic({ action: { type: "open_url", url: "  HTTPS://Exemplo.test/a b  ", label: "Abrir" } })),
    );
    expect(out.start.topics[0].action).toEqual({
      type: "open_url",
      url: "https://exemplo.test/a%20b",
      label: "Abrir",
    });
  });

  it.each([
    ["appearance não objeto", "guided", /appearance/],
    ["modelo desconhecido", { model: "outro" }, /appearance\.model/],
    ["allowExpand não booleano", { allowExpand: "sim" }, /allowExpand/],
    ["start não objeto", { start: [] }, /appearance\.start/],
    ["título longo", { start: { title: "x".repeat(81) } }, /title/],
    ["subtítulo longo", { start: { subtitle: "x".repeat(161) } }, /subtitle/],
    ["rótulo de escrever longo", { start: { writeLabel: "x".repeat(41) } }, /writeLabel/],
    ["tópicos não lista", { start: { topics: {} } }, /topics/],
    [
      "sete tópicos",
      withTopics(...Array.from({ length: 7 }, (_, i) => topic({ id: `t${i}` }))),
      /no máximo 6/,
    ],
    ["tópico não objeto", withTopics("t1"), /topics\[0\]/],
    ["id ruim", withTopics(topic({ id: "com espaço" })), /\.id/],
    ["id repetido", withTopics(topic(), topic({ label: "Outro" })), /repetido/],
    ["rótulo vazio", withTopics(topic({ label: "   " })), /label/],
    ["rótulo longo", withTopics(topic({ label: "x".repeat(41) })), /label/],
    ["rótulo com NUL", withTopics(topic({ label: "a\u0000b" })), /caracteres inválidos/],
    ["rótulo com surrogate solto", withTopics(topic({ label: "a\ud83db" })), /caracteres inválidos/],
    ["ícone desconhecido", withTopics(topic({ icon: "star" })), /icon/],
    ["sem ação", withTopics(topic({ action: undefined })), /action/],
    ["ação desconhecida", withTopics(topic({ action: { type: "close_ticket" } })), /action\.type/],
    ["texto vazio", withTopics(topic({ action: { type: "send_text", text: " " } })), /action\.text/],
    ["texto longo", withTopics(topic({ action: { type: "send_text", text: "x".repeat(501) } })), /action\.text/],
    ["url sem https", withTopics(topic({ action: { type: "open_url", url: "http://exemplo.test" } })), /https/],
    ["url javascript", withTopics(topic({ action: { type: "open_url", url: "javascript:alert(1)" } })), /https/],
    ["url relativa", withTopics(topic({ action: { type: "open_url", url: "/ajuda" } })), /https/],
    ["url vazia", withTopics(topic({ action: { type: "open_url" } })), /https/],
    ["url com senha", withTopics(topic({ action: { type: "open_url", url: "https://a:b@exemplo.test" } })), /https/],
    [
      "url longa",
      withTopics(topic({ action: { type: "open_url", url: `https://exemplo.test/${"x".repeat(2000)}` } })),
      /url passa/,
    ],
    [
      "rótulo da url longo",
      withTopics(topic({ action: { type: "open_url", url: "https://exemplo.test", label: "x".repeat(41) } })),
      /action\.label/,
    ],
    ["followUp sem pergunta", withTopics(topic({ followUp: { options: [option()] } })), /question/],
    [
      "pergunta longa",
      withTopics(topic({ followUp: { question: "x".repeat(201), options: [option()] } })),
      /question/,
    ],
    [
      "dica longa",
      withTopics(topic({ followUp: { question: "q", hint: "x".repeat(161), options: [option()] } })),
      /hint/,
    ],
    ["followUp sem opções", withTopics(topic({ followUp: { question: "q", options: [] } })), /de 1 a 6/],
    [
      "sete opções",
      withTopics(
        topic({
          followUp: {
            question: "q",
            options: Array.from({ length: 7 }, (_, i) => option({ id: `o${i}` })),
          },
        }),
      ),
      /de 1 a 6/,
    ],
    [
      "opção repetida",
      withTopics(topic({ followUp: { question: "q", options: [option(), option()] } })),
      /repetido/,
    ],
    [
      "segundo nível",
      withTopics(
        topic({
          followUp: {
            question: "q",
            options: [option({ followUp: { question: "q2", options: [option()] } })],
          },
        }),
      ),
      /um nível só/,
    ],
    ["chave da faixa inválida", { contextBanner: { titleKey: "com espaço" } }, /titleKey/],
    ["subtítulo da faixa não texto", { contextBanner: { subtitleKey: 1 } }, /subtitleKey/],
    ["faixa sem booleano", { contextBanner: { enabled: "sim" } }, /contextBanner\.enabled/],
    ["fechamento sem booleano", { closing: { enabled: 1 } }, /closing\.enabled/],
    ["rótulo de fechamento longo", { closing: { resolvedLabel: "x".repeat(41) } }, /resolvedLabel/],
    ["rótulo de ajuda longo", { closing: { needHelpLabel: "x".repeat(41) } }, /needHelpLabel/],
  ])("rejeita: %s", (_name, patch, message) => {
    let err: unknown;
    try {
      appearance(patch);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WebchatV2ConfigError);
    expect((err as Error).message).toMatch(message);
  });

  it("mesmo id entre um tópico e uma opção é permitido: a unicidade é por lista", () => {
    const out = appearance(withTopics(topic({ followUp: { question: "q", options: [option({ id: "t1" })] } })));
    expect(out.start.topics[0].followUp?.options[0].id).toBe("t1");
  });

  describe("leitura tolerante", () => {
    it("config sem appearance cai no padrão", () => {
      expect(readWebchatV2Config({ v2: { context: { anonymous: true } } }).appearance).toEqual(
        defaultWebchatAppearance(),
      );
    });

    it.each([
      ["texto", "guided"],
      ["null", null],
      ["lista", []],
      ["modelo que não existe", { model: "antigo" }],
      ["tópico quebrado", { model: "guided", start: { topics: [{ id: "t1" }] } }],
    ])("appearance inválido (%s) volta inteiro ao padrão, e o resto do v2 fica", (_name, stored) => {
      const out = readWebchatV2Config({ v2: { appearance: stored, context: { anonymous: true } } });
      expect(out.appearance).toEqual(defaultWebchatAppearance());
      expect(out.context.anonymous).toBe(true);
    });

    it("appearance válido é lido como foi gravado", () => {
      const stored = { model: "assisted", allowExpand: true, start: { topics: [topic()] } };
      const out = readWebchatV2Config({ v2: { appearance: stored } });
      expect(out.appearance.model).toBe("assisted");
      expect(out.appearance.allowExpand).toBe(true);
      expect(out.appearance.start.topics).toHaveLength(1);
    });
  });
});
