import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { normalizeV2Config, validateV2Config } from "@/lib/ai-v2/config";
import { applyConfigChanges } from "../config-patch";
import {
  aggregateTone,
  approachChanges,
  attributeHumanMessages,
  buildListenTranscript,
  effectiveListenStatus,
  estimateListenCostMath,
  frequentPatterns,
  groupPatterns,
  knowledgeCandidates,
  listenEndsAt,
  parseSampleAnalysis,
  toneChanges,
  type ListenAnalysis,
  type ListenKnowledgeItem,
  type ListenMessage,
  type ListenSample,
} from "../listen-extract";

const msg = (id: string, direction: string, authorType: string, content: string, extra: Partial<ListenMessage> = {}): ListenMessage => ({
  id, direction, authorType, content, createdAt: new Date(), ...extra,
});

const config = normalizeV2Config({
  name: "Agente",
  tone: "Cordial.",
  autonomyMode: "auto",
  themes: [{ id: "t1", name: "Entrega", when: ["prazo"], examples: [], instructions: "Explique o prazo." }],
  handoff: { defaultDestination: { type: "department", id: "dep-1" }, message: "Vou transferir." },
} as never);

const analysis = (patch: Partial<ListenAnalysis> = {}): ListenAnalysis => ({
  outcome: "resolved",
  knowledge: [],
  approach: { opening: "", closing: "", habits: [], handoffReason: "" },
  tone: { formality: 3, length: "short", emojis: "light", bold: null, treatment: "você", greeting: "", signoff: "", vocabulary: [], samples: [] },
  ...patch,
});

describe("escutar a equipe — autoria e transcrição", () => {
  it("evento de envio vence o nome; sem evento, casa o nome; IA nunca é da equipe", () => {
    const out = attributeHumanMessages(
      [
        msg("m1", "out", "human", "Oi!", { senderName: "Outra Pessoa" }),
        msg("m2", "out", "human", "Posso ajudar?", { senderName: "ana souza" }),
        msg("m3", "out", "bot", "Sou a IA", { isAi: true, senderName: "Ana Souza" }),
        msg("m4", "in", "human", "oi"),
      ],
      new Map([["m1", "u-ana"]]),
      new Map([["ana souza", "u-ana"]]),
    );
    expect(out.map((m) => m.userId)).toEqual(["u-ana", "u-ana", null, null]);
  });

  it("rótulos, máscara do contato e da pessoa escutada, texto da Referência", () => {
    const tr = buildListenTranscript(
      [
        msg("1", "in", "human", "Oi, sou o Pedro, meu fone é 11 99999-8888"),
        msg("2", "out", "human", "Oi Pedro! Aqui é a Ana, já te ajudo.", { userId: "u-ana" }),
        msg("3", "out", "human", "Assumindo aqui.", { userId: "u-outro" }),
        msg("4", "out", "bot", "Mensagem automática", { isAi: true }),
      ],
      new Set(["u-ana"]),
      ["Pedro", "Ana"],
    );
    expect(tr.text).toContain("Cliente: Oi, sou o [nome]");
    expect(tr.text).not.toContain("99999");
    expect(tr.text).toContain("Referência: Oi [nome]! Aqui é a [nome]");
    expect(tr.text).toContain("Equipe (outra pessoa): Assumindo aqui.");
    expect(tr.text).toContain("Agente IA: Mensagem automática");
    expect(tr.referenceCount).toBe(1);
  });
});

describe("escutar a equipe — análise", () => {
  const reference = "Para trocar, é só mandar a foto do produto 😊\nQualquer coisa estou por aqui!";

  it("citação e exemplo só se estiverem no que a Referência escreveu", () => {
    const a = parseSampleAnalysis(
      {
        outcome: "resolved",
        knowledge: [
          { kind: "procedure", question: "Como troco?", answer: "Mandar a foto do produto pelo WhatsApp.", quote: "é só mandar a foto do produto" },
          { kind: "fact", question: "Prazo?", answer: "Troca em até trinta dias corridos.", quote: "trinta dias" },
        ],
        approach: { opening: "Cumprimenta", habits: ["Confirma o pedido antes de explicar"], closing: "Se coloca à disposição" },
        tone: { formality: 2, length: "short", emojis: "light", samples: ["Qualquer coisa estou por aqui!", "frase inventada"] },
      },
      reference,
    );
    expect(a?.knowledge[0].quote).toBe("é só mandar a foto do produto");
    expect(a?.knowledge[1].quote).toBeNull();
    expect(a?.tone.samples).toEqual(["Qualquer coisa estou por aqui!"]);
    expect(a?.approach.habits).toEqual(["Confirma o pedido antes de explicar"]);
  });

  it("conversa que não se resolveu não ensina conhecimento nem abordagem", () => {
    const a = parseSampleAnalysis({ outcome: "unresolved", knowledge: [{ question: "x", answer: "resposta longa o bastante" }], approach: { habits: ["h"] }, tone: {} }, reference);
    expect(a?.knowledge).toEqual([]);
    expect(a?.approach.habits).toEqual([]);
    expect(parseSampleAnalysis(null, reference)).toBeNull();
  });
});

describe("escutar a equipe — agregação", () => {
  const samples = (n: number): ListenSample[] => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, conversationNumber: i, analysis: analysis() }));

  it("hábito vira proposta só quando se repete o bastante", () => {
    const items = [
      ...["a", "b"].map((id) => ({ text: "Confirma o pedido", sampleId: id })),
      ...["c", "d", "e", "f", "g"].map((id) => ({ text: "Pergunta o número do pedido", sampleId: id })),
    ];
    const vectors = items.map((i) => (i.text.startsWith("Confirma") ? [1, 0] : [0, 1]));
    const groups = groupPatterns(items, vectors);
    expect(frequentPatterns(groups, 12).map((p) => p.texts[0])).toEqual(["Pergunta o número do pedido"]);
    expect(frequentPatterns(groups, 30)).toEqual([]); // 5 de 30 < 35%
  });

  it("conhecimento: 2+ conversas, ou passo a passo de uma só para confirmar", () => {
    const one = { kind: "procedure" as const, question: "Como?", answer: "1. Abra\n2. Toque\n3. Envie", quote: null };
    const fact = { kind: "fact" as const, question: "Horário?", answer: "Das 8h às 18h, de segunda a sexta.", quote: null };
    const map = new Map<string, ListenKnowledgeItem>([["p", one], ["f1", fact], ["f2", fact], ["solo", { ...fact, answer: "Algo dito uma vez só aqui." }]]);
    const out = knowledgeCandidates(
      [
        { texts: ["f1", "f2"], textSampleIds: ["a", "b"], sampleIds: ["a", "b"], occurrences: 2 },
        { texts: ["p"], textSampleIds: ["c"], sampleIds: ["c"], occurrences: 1 },
        { texts: ["solo"], textSampleIds: ["d"], sampleIds: ["d"], occurrences: 1 },
      ],
      map,
    );
    expect(out.map((c) => [c.pattern.texts[0], c.confirm])).toEqual([["f1", false], ["p", true]]);
  });

  it("tom: o mais comum em cada traço, só com conversas suficientes", () => {
    expect(aggregateTone(samples(2))).toBeNull();
    const list = samples(4);
    list[0].analysis.tone.emojis = "none";
    const t = aggregateTone(list);
    expect(t?.emojis).toBe("light");
    expect(t?.length).toBe("short");
  });
});

describe("escutar a equipe — propostas na configuração", () => {
  it("tom e abordagem viram alterações válidas; nome da pessoa é recusado; igual ao atual é omitido", () => {
    const tone = toneChanges(config, { tone: "Próximo e simples.", responseLength: "short", emojis: "light", bold: null, examples: ["Oi! Já te ajudo 😊", "Aqui é a Ana"] }, ["Ana Souza"]);
    expect(tone.map((c) => c.path)).toEqual(["tone", "responseLength", "emojis"]);
    expect(String(tone[0].value)).toContain("Oi! Já te ajudo");
    expect(String(tone[0].value)).not.toContain("Ana Souza");
    expect(toneChanges(config, { tone: "Fale como a Ana." }, ["Ana Souza"])).toEqual([]);
    expect(toneChanges(config, { tone: "Cordial.", responseLength: "medium" }, [])).toEqual([]);

    const theme = approachChanges(config, { titulo: "x", texto: "Confirme o número do pedido antes de explicar.", themeId: "t1" }, []);
    const global = approachChanges(config, { titulo: "y", texto: "Encerre perguntando se ficou alguma dúvida." }, []);
    expect(theme[0].path).toBe("themes[id=t1].instructions");
    expect(global).toEqual([{ path: "globalRules", op: "add", value: ["Encerre perguntando se ficou alguma dúvida."] }]);
    const next = applyConfigChanges(config, [...tone, ...theme, ...global]);
    expect(validateV2Config(next).ok).toBe(true);
    expect(next.themes[0].instructions).toBe("Explique o prazo.\nConfirme o número do pedido antes de explicar.");
  });
});

describe("escutar a equipe — período e custo", () => {
  it("hoje termina 23:59 de Brasília; ligada vencida conta como encerrada; pausada não vence", () => {
    const now = new Date("2026-09-26T15:00:00-03:00");
    expect(listenEndsAt("today", {}, now)?.toISOString()).toBe("2026-09-27T02:59:59.000Z");
    expect(listenEndsAt("days", { days: 7 }, now)?.toISOString()).toBe("2026-10-03T02:59:59.000Z");
    expect(listenEndsAt("continuous", {}, now)).toBeNull();
    expect(() => listenEndsAt("range", { endsAt: "2026-09-01" }, now)).toThrow(/futuro/);
    const later = new Date("2026-09-28T10:00:00-03:00");
    expect(effectiveListenStatus({ status: "on", endsAt: listenEndsAt("today", {}, now) }, later)).toBe("expired");
    expect(effectiveListenStatus({ status: "paused", endsAt: listenEndsAt("today", {}, now) }, later)).toBe("paused");
  });

  it("estimativa: conversas × preço por conversa + sínteses", () => {
    const price = (i: number, o: number) => (i * 0.4 + o * 1.6) / 1_000_000;
    expect(estimateListenCostMath(0, price)).toBe(0);
    expect(estimateListenCostMath(10, price)).toBeCloseTo(10 * (2000 * 0.4 + 600 * 1.6) / 1e6 + 3 * (6000 * 0.4 + 2500 * 1.6) / 1e6, 3);
  });
});
