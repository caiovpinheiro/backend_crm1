import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/ai/provider", () => ({ generateWithTools: vi.fn() }));
vi.mock("@/services/ai/agent-key", () => ({ getAgentApiKey: vi.fn(), getAgentChatKey: vi.fn(), tryGetAgentApiKey: vi.fn() }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import {
  aggregateQuality,
  buildTranscript,
  claimKind,
  configAt,
  liveCheckOf,
  mapPool,
  normalizeQualityParams,
  parseHandlingReview,
  periodBounds,
  QUALITY_LIMITS,
  rankSources,
  stratifiedSample,
  turnSources,
  type ClaimOutcome,
} from "../reply-quality";

/** Gerador determinístico para as amostras. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe("tipo da afirmação sem fonte", () => {
  it("contato, valor, prazo, procedimento e outro", () => {
    expect(claimKind("Escreva para suporte@exemplo.com.br")).toBe("contato");
    expect(claimKind("Ligue para (11) 99999-0000")).toBe("contato");
    expect(claimKind("Acesse https://exemplo.com/portal")).toBe("contato");
    expect(claimKind("A taxa é de R$ 50,00")).toBe("valor");
    expect(claimKind("Há desconto de 10% à vista")).toBe("valor");
    expect(claimKind("O prazo de resposta é de 7 dias úteis")).toBe("prazo");
    expect(claimKind("A entrega é até 15/11")).toBe("prazo");
    expect(claimKind("O atendimento abre na segunda-feira")).toBe("prazo");
    expect(claimKind("Clique em “Solicitações” e escolha a opção")).toBe("procedimento");
    expect(claimKind("Vá em Perfil e preencha o formulário")).toBe("procedimento");
    expect(claimKind("O pedido é analisado pela coordenação")).toBe("outro");
  });
});

describe("fontes do turno", () => {
  it("trechos ranqueados pela proximidade com a resposta, até o orçamento", () => {
    const chunks = ["Horário de funcionamento: das 8h às 18h.", "Para emitir a segunda via, abra Pagamentos e toque em Segunda via.", "Política de trocas em 30 dias."];
    const ranked = rankSources(chunks, "Abra Pagamentos e toque em Segunda via para emitir.", 10_000);
    expect(ranked[0]).toContain("segunda via");
    expect(ranked).toHaveLength(3);
    const tight = rankSources(chunks, "Abra Pagamentos e toque em Segunda via.", 30);
    expect(tight).toHaveLength(1);
    expect(tight[0].length).toBe(30);
  });

  it("monta as fontes fixas da configuração do turno e os trechos gravados no log", () => {
    const config = normalizeV2Config({
      name: "A",
      tone: "t",
      globalRules: ["Nunca prometa prazo."],
      variables: [{ key: "Telefone da central", value: "0800 000 0000" }],
      allowedDomains: ["exemplo.com"],
      themes: [{ id: "t1", name: "Pagamento", instructions: "Explique a segunda via pelo aplicativo.", when: ["segunda via"] }],
    });
    const snapshot = {
      themeId: "t1",
      toolCalls: [
        { toolName: "knowledge_search", args: {}, result: { chunks: [{ docTitle: "Guia de pagamento", content: "Abra Pagamentos e toque em Segunda via." }] } },
        { toolName: "search_products", args: {}, result: { products: [{ name: "Plano B", price: 99 }] } },
      ],
      contact: { Nome: "[nome]" },
      selectedDeal: null,
      citableContact: { email: "x***@exemplo.com" },
      citableDeal: null,
    };
    const sources = turnSources({ config, snapshot, at: new Date("2026-10-08T15:00:00Z"), reply: "Abra Pagamentos.", messageModels: [{ name: "Segunda via", content: "Passo a passo da segunda via." }] });
    const all = sources.join("\n");
    expect(all).toContain("Explique a segunda via pelo aplicativo.");
    expect(all).toContain("Nunca prometa prazo.");
    expect(all).toContain("Telefone da central: 0800 000 0000");
    expect(all).toContain("exemplo.com");
    expect(all).toContain("Passo a passo da segunda via.");
    expect(all).toContain("Guia de pagamento");
    expect(all).toContain("Abra Pagamentos e toque em Segunda via.");
    expect(all).toContain("Plano B");
    expect(all).toContain("x***@exemplo.com");
    // A data do turno, não a de hoje.
    expect(all).toMatch(/08\/10\/2026|8 de outubro/);
    // Fixas antes dos trechos longos.
    expect(sources.findIndex((x) => x.includes("Nunca prometa"))).toBeLessThan(sources.findIndex((x) => x.includes("Abra Pagamentos e toque")));
  });

  it("toolCalls ausente ou em formato inesperado não quebra", () => {
    const config = normalizeV2Config({ name: "A", tone: "t" });
    const snapshot = { themeId: null, toolCalls: null, contact: null, selectedDeal: null, citableContact: null, citableDeal: null };
    expect(() => turnSources({ config, snapshot, at: new Date(), reply: "Oi", messageModels: [] })).not.toThrow();
  });

  it("configuração em vigor no horário: a última publicada antes; sem versão, a atual", () => {
    const v1 = normalizeV2Config({ name: "v1", tone: "t" });
    const v2 = normalizeV2Config({ name: "v2", tone: "t" });
    const current = normalizeV2Config({ name: "atual", tone: "t" });
    const versions = [
      { createdAt: new Date("2026-10-09T12:00:00Z"), config: v2 },
      { createdAt: new Date("2026-10-07T12:00:00Z"), config: v1 },
    ];
    expect(configAt(versions, new Date("2026-10-08T00:00:00Z"), current).name).toBe("v1");
    expect(configAt(versions, new Date("2026-10-10T00:00:00Z"), current).name).toBe("v2");
    expect(configAt(versions, new Date("2026-10-01T00:00:00Z"), current).name).toBe("atual");
    expect(configAt([], new Date(), current).name).toBe("atual");
  });
});

describe("checagem que rodou no atendimento", () => {
  it("lida do rastro", () => {
    expect(liveCheckOf([{ step: "verificação", detail: "Checagem por modelo: tudo sustentado pelos materiais" }])).toBe("model");
    expect(liveCheckOf([{ step: "verificação", detail: "Checagem por modelo desligada na configuração — só as regras fixas conferiram a resposta" }])).toBe("rules");
    expect(liveCheckOf([{ step: "entrada", detail: "Mensagem recebida" }])).toBe("none");
    expect(liveCheckOf(null)).toBe("none");
  });
});

describe("amostra estratificada", () => {
  it("cada assunto entra na proporção, com pelo menos um; total no limite", () => {
    const rows = [
      ...Array.from({ length: 90 }, (_, i) => ({ id: `a${i}`, theme: "A" })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, theme: "B" })),
      { id: "c0", theme: "C" },
    ];
    const s = stratifiedSample(rows, (r) => r.theme, 20, seeded(7));
    expect(s).toHaveLength(20);
    expect(new Set(s.map((r) => r.id)).size).toBe(20);
    expect(s.filter((r) => r.theme === "C")).toHaveLength(1);
    expect(s.filter((r) => r.theme === "B").length).toBeGreaterThanOrEqual(1);
    expect(s.filter((r) => r.theme === "A").length).toBeGreaterThanOrEqual(17);
  });

  it("menos linhas que o limite: todas", () => {
    expect(stratifiedSample([1, 2, 3], () => "x", 10)).toEqual([1, 2, 3]);
  });

  it("muitos grupos pequenos não estouram o limite", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, g: `g${i}` }));
    expect(stratifiedSample(rows, (r) => r.g, 10, seeded(3))).toHaveLength(10);
  });
});

describe("avaliação do jeito de lidar", () => {
  it("lê o JSON, aceita cercas de código e descarta categoria desconhecida", () => {
    const out = parseHandlingReview('```json\n{"itens":[{"categoria":"pediu_dado_ja_informado","trecho":"Qual o seu e-mail?","explicacao":"O cliente já tinha dado o e-mail."},{"categoria":"inventada","trecho":"x"},{"categoria":"TOM","trecho":"Calma."}]}\n```');
    expect(out).toEqual([
      { category: "pediu_dado_ja_informado", excerpt: "Qual o seu e-mail?", why: "O cliente já tinha dado o e-mail." },
      { category: "tom", excerpt: "Calma.", why: "" },
    ]);
    expect(parseHandlingReview('{"itens":[]}')).toEqual([]);
    expect(parseHandlingReview("sem json")).toBeNull();
    expect(parseHandlingReview('{"itens": "x"}')).toBeNull();
  });

  it("transcrição com papéis, dado sensível mascarado, nome do contato trocado e corte pelo começo", () => {
    const at = new Date("2026-10-08T12:00:00Z");
    const msgs = [
      { direction: "in", authorType: null, content: "Oi, sou a Maria, meu CPF é 529.982.247-25", createdAt: at },
      { direction: "out", authorType: "bot", content: "Olá Maria! Como posso ajudar?", createdAt: at },
      { direction: "out", authorType: "human", content: "Aqui é da equipe.", createdAt: at },
      { direction: "in", authorType: null, content: "  ", createdAt: at },
    ];
    const t = buildTranscript(msgs, (s) => s.replace(/Maria/g, "[nome]"));
    expect(t.split("\n")).toHaveLength(3);
    expect(t).toContain("Cliente: Oi, sou a [nome]");
    expect(t).not.toContain("529.982.247-25");
    expect(t).toContain("Agente: Olá [nome]!");
    expect(t).toContain("Equipe: Aqui é da equipe.");

    const long = Array.from({ length: 30 }, (_, i) => ({ direction: i % 2 ? "out" : "in", authorType: "bot", content: `mensagem ${i} ${"x".repeat(80)}`, createdAt: at }));
    const cut = buildTranscript(long, (s) => s, 500);
    expect(cut.length).toBeLessThanOrEqual(500);
    expect(cut).toContain("mensagem 29");
    expect(cut).not.toContain("mensagem 0 ");
  });
});

describe("resumo da análise", () => {
  const at = new Date("2026-10-08T12:00:00Z");
  const claim = (over: Partial<ClaimOutcome>): ClaimOutcome => ({ turnId: "t", conversationId: "c1", number: 10, at, theme: "Pagamento", liveCheck: "rules", ok: true, unsupported: [], ...over });

  it("taxa, por assunto, por tipo, por checagem do atendimento e exemplos", () => {
    const r = aggregateQuality({
      claimEligible: 50,
      claims: [
        claim({ unsupported: ["Escreva para suporte@exemplo.com"] }),
        claim({ unsupported: ["O prazo é de 7 dias", "A taxa é R$ 30"], theme: "Documentos", liveCheck: "model" }),
        claim({}),
        claim({ ok: false }),
      ],
      handlingEligible: 20,
      handling: [
        { conversationId: "c1", number: 10, ok: true, items: [{ category: "insistiu", excerpt: "a", why: "b" }, { category: "insistiu", excerpt: "c", why: "d" }] },
        { conversationId: "c2", number: 11, ok: true, items: [] },
        { conversationId: "c3", number: 12, ok: false, items: [] },
      ],
    });
    expect(r.claims).toMatchObject({ eligible: 50, checked: 3, notChecked: 1, withUnsupported: 2, rate: 66.7 });
    expect(r.claims.byKind).toEqual({ contato: 1, valor: 1, prazo: 1, procedimento: 0, outro: 0 });
    expect(r.claims.byTheme[0]).toEqual({ theme: "Pagamento", checked: 2, flagged: 1 });
    expect(r.claims.byLiveCheck.rules).toEqual({ checked: 2, flagged: 1 });
    expect(r.claims.byLiveCheck.model).toEqual({ checked: 1, flagged: 1 });
    expect(r.claims.examples).toHaveLength(3);
    expect(r.claims.examples[0]).toMatchObject({ number: 10, kind: "contato", theme: "Pagamento", at: at.toISOString() });

    expect(r.handling).toMatchObject({ eligible: 20, reviewed: 2, notReviewed: 1, withIssue: 1, rate: 50 });
    // Categoria conta uma vez por conversa; exemplos, todos.
    expect(r.handling.byCategory.insistiu).toBe(1);
    expect(r.handling.examples).toHaveLength(2);
  });

  it("sem nada conferido: taxa zero, sem divisão por zero", () => {
    const r = aggregateQuality({ claimEligible: 0, claims: [], handlingEligible: 0, handling: [] });
    expect(r.claims.rate).toBe(0);
    expect(r.handling.rate).toBe(0);
  });

  it("exemplos limitados", () => {
    const many = Array.from({ length: QUALITY_LIMITS.examples + 20 }, (_, i) => claim({ turnId: `t${i}`, unsupported: ["O prazo é de 7 dias"] }));
    expect(aggregateQuality({ claimEligible: many.length, claims: many, handlingEligible: 0, handling: [] }).claims.examples).toHaveLength(QUALITY_LIMITS.examples);
  });
});

describe("parâmetros e execução", () => {
  it("período e amostras normalizados com teto", () => {
    expect(normalizeQualityParams({ from: "2026-10-07", to: "2026-10-11", claimSample: "99999", handlingSample: -1 })).toEqual({
      from: "2026-10-07",
      to: "2026-10-11",
      claimSample: QUALITY_LIMITS.claimSampleMax,
      handlingSample: QUALITY_LIMITS.handlingSampleDefault,
    });
    const d = normalizeQualityParams({ from: "ontem" });
    expect(d.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.claimSample).toBe(QUALITY_LIMITS.claimSampleDefault);
  });

  it("limites do período em horário de Brasília, fim inclusivo", () => {
    const { from, to } = periodBounds({ from: "2026-10-07", to: "2026-10-11" });
    expect(from.toISOString()).toBe("2026-10-07T03:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-12T03:00:00.000Z");
  });

  it("pool respeita a concorrência e a ordem do resultado", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
  });
});
