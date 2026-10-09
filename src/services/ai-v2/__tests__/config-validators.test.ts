import { describe, expect, it } from "vitest";

import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import {
  buildRoutingMap,
  firstAttendanceAgentIds,
  monthsInTitle,
  validateAgentConfig,
  variableRefs,
  type ConfigValidationData,
  type ValidationAgent,
} from "../config-validators";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const DEPT = "dep-vendas";

function cfg(over: Record<string, unknown> = {}): V2AgentConfig {
  return normalizeV2Config({
    name: "Agente",
    tone: "cordial",
    handoff: { defaultDestination: { type: "department", id: DEPT } },
    ...over,
  });
}

function agent(id: string, over: Partial<Omit<ValidationAgent, "config">> & { config?: Record<string, unknown> } = {}): ValidationAgent {
  const { config, ...rest } = over;
  return { id, name: id, active: true, engine: "simple", createdAt: new Date("2026-01-01T00:00:00.000Z"), ...rest, config: cfg(config) };
}

function data(over: Partial<ConfigValidationData> = {}): ConfigValidationData {
  return {
    agents: [],
    departments: [{ id: DEPT, name: "Vendas", memberCount: 3 }, { id: "dep-vazio", name: "Entregas", memberCount: 0 }],
    users: [{ id: "u-1", name: "Ana" }],
    distributionRules: [{ id: "dr-1", name: "Rodízio" }],
    tabulations: [{ id: "tab-1", name: "Vendas › Resolvido" }],
    automations: [],
    runOnAiClose: false,
    now: NOW,
    ...over,
  };
}

const codes = (d: ConfigValidationData, id = "a") => validateAgentConfig(id, d).map((f) => f.code);
const find = (d: ConfigValidationData, code: string, id = "a") => validateAgentConfig(id, d).filter((f) => f.code === code);

describe("1. grafo de roteamento", () => {
  it("configuração limpa não tem achado", () => {
    expect(codes(data({ agents: [agent("a", { config: { channelIds: ["ch-1"] } })] }))).toEqual([]);
  });

  it("destino inexistente, desligado e sem id bloqueiam; departamento sem gente avisa", () => {
    const d = data({
      agents: [
        agent("a", {
          config: {
            channelIds: ["ch-1"],
            themes: [
              { id: "t1", name: "Troca", instructions: "x", handoffDestination: { type: "department", id: "dep-sumiu" } },
              { id: "t2", name: "Prazo", instructions: "x", handoffDestination: { type: "ai_agent", id: "b" } },
              { id: "t3", name: "Pedido", instructions: "x", handoffDestination: { type: "user" } },
              { id: "t4", name: "Entrega", instructions: "x", handoffDestination: { type: "department", id: "dep-vazio" } },
            ],
          },
        }),
        agent("b", { active: false, config: {} }),
      ],
    });
    const out = validateAgentConfig("a", d);
    expect(out.find((f) => f.path === "themes[0].handoffDestination")).toMatchObject({ code: "destino_inexistente", severity: "bloqueia" });
    expect(out.find((f) => f.path === "themes[1].handoffDestination")).toMatchObject({ code: "destino_desligado", severity: "bloqueia" });
    expect(out.find((f) => f.path === "themes[2].handoffDestination")).toMatchObject({ code: "destino_sem_id", severity: "bloqueia" });
    expect(out.find((f) => f.path === "themes[3].handoffDestination")).toMatchObject({ code: "departamento_sem_usuario", severity: "avisa" });
  });

  it("destino padrão sem departamento bloqueia", () => {
    const d = data({ agents: [agent("a", { config: { channelIds: ["ch-1"], handoff: { defaultDestination: { type: "department" } } } })] });
    expect(find(d, "destino_sem_id")[0]).toMatchObject({ severity: "bloqueia", path: "handoff.defaultDestination" });
  });

  it("autotransferência: assunto ou atalho apontando para o próprio agente", () => {
    const d = data({
      agents: [
        agent("a", {
          config: {
            channelIds: ["ch-1"],
            themes: [{ id: "t1", name: "Troca", instructions: "x", directHandoff: true, handoffDestination: { type: "ai_agent", id: "a" } }],
            rules: [{ id: "r1", name: "Atalho", actions: [{ type: "handoff", destination: { type: "ai_agent", id: "a" } }] }],
          },
        }),
      ],
    });
    const out = find(d, "autotransferencia");
    expect(out.map((f) => f.path)).toEqual(["themes[0].handoffDestination", "rules[0].actions[0].destination"]);
    expect(out.every((f) => f.severity === "bloqueia")).toBe(true);
  });

  it("ping-pong A → B → A com transferência direta bloqueia; sem direta, avisa", () => {
    const direct = data({
      agents: [
        agent("a", { config: { channelIds: ["ch-1"], themes: [{ id: "t1", name: "Pagamento", instructions: "x", directHandoff: true, handoffDestination: { type: "ai_agent", id: "b" } }] } }),
        agent("b", { config: { themes: [{ id: "t9", name: "Outro assunto", instructions: "x", directHandoff: true, handoffDestination: { type: "ai_agent", id: "a" } }] } }),
      ],
    });
    const f = find(direct, "ciclo_entre_agentes")[0];
    expect(f).toMatchObject({ severity: "bloqueia", path: "themes[0].handoffDestination", evidence: "a → b → a" });
    expect(f.message).toContain("Outro assunto");
    // O mesmo ciclo aparece para B, no campo de B.
    expect(find(direct, "ciclo_entre_agentes", "b")[0]).toMatchObject({ severity: "bloqueia", path: "themes[0].handoffDestination" });

    const soft = data({
      agents: [
        agent("a", { config: { channelIds: ["ch-1"], themes: [{ id: "t1", name: "Pagamento", instructions: "x", handoffDestination: { type: "ai_agent", id: "b" } }] } }),
        agent("b", { config: { themes: [{ id: "t9", name: "Outro assunto", instructions: "x", handoffDestination: { type: "ai_agent", id: "a" } }] } }),
      ],
    });
    expect(find(soft, "ciclo_entre_agentes")[0].severity).toBe("avisa");
  });

  it("ciclo de três agentes é avisado uma vez para cada participante", () => {
    const d = data({
      agents: [
        agent("a", { config: { channelIds: ["ch-1"], themes: [{ id: "t1", name: "X", instructions: "x", handoffDestination: { type: "ai_agent", id: "b" } }] } }),
        agent("b", { config: { themes: [{ id: "t2", name: "Y", instructions: "x", handoffDestination: { type: "ai_agent", id: "c" } }] } }),
        agent("c", { config: { themes: [{ id: "t3", name: "Z", instructions: "x", handoffDestination: { type: "ai_agent", id: "a" } }] } }),
      ],
    });
    expect(find(d, "ciclo_entre_agentes")).toHaveLength(1);
    expect(find(d, "ciclo_entre_agentes")[0].evidence).toBe("a → b → c → a");
  });

  it("agente órfão: ligado, sem número, sem ninguém transferindo para ele", () => {
    const d = data({
      agents: [
        agent("a", { createdAt: new Date("2026-01-01T00:00:00.000Z"), config: {} }),
        agent("b", { createdAt: new Date("2026-02-01T00:00:00.000Z"), config: {} }),
      ],
    });
    // "a" é o mais antigo sem número: recebe conversa nova. "b" não.
    expect(codes(d, "a")).not.toContain("agente_orfao");
    expect(find(d, "agente_orfao", "b")[0]).toMatchObject({ severity: "avisa", path: "channelIds" });
    // Com alguém transferindo para "b", deixa de ser órfão.
    const routed = data({ agents: [agent("a", { config: { themes: [{ id: "t1", name: "Troca", instructions: "x", handoffDestination: { type: "ai_agent", id: "b" } }] } }), d.agents[1]] });
    expect(codes(routed, "b")).not.toContain("agente_orfao");
    // Ou um fluxo de automação que o chama.
    const flow = data({ agents: d.agents, automations: [{ id: "f1", name: "Boas-vindas", triggerType: "conversation_created", active: true, steps: [{ type: "transfer_to_ai_agent", config: { agentId: "b" } }] }] });
    expect(codes(flow, "b")).not.toContain("agente_orfao");
  });

  it("firstAttendanceAgentIds: vence quem está no canal; o mais antigo sem número atende o resto", () => {
    const ids = firstAttendanceAgentIds([
      agent("velho", { createdAt: new Date("2026-01-01"), config: {} }),
      agent("novo", { createdAt: new Date("2026-03-01"), config: {} }),
      agent("canal", { createdAt: new Date("2026-02-01"), config: { channelIds: ["ch-1"] } }),
      agent("canal-repetido", { createdAt: new Date("2026-04-01"), config: { channelIds: ["ch-1"] } }),
      agent("desligado", { active: false, config: { channelIds: ["ch-2"] } }),
    ]);
    expect([...ids].sort()).toEqual(["canal", "velho"]);
  });
});

describe("2. gatilhos de assunto", () => {
  it("mesma palavra em dois assuntos (igual ou mesma raiz) avisa, com o campo do primeiro em evidence", () => {
    const d = data({
      agents: [agent("a", { config: { channelIds: ["ch-1"], themes: [
        { id: "t1", name: "Troca", instructions: "x", when: ["troca", "devolução"] },
        { id: "t2", name: "Devolução", instructions: "x", when: ["devolução", "devolver"] },
        { id: "t3", name: "Trocas", instructions: "x", when: ["trocas"] },
      ] } })],
    });
    const out = find(d, "gatilho_repetido");
    expect(out.map((f) => f.path).sort()).toEqual(["themes[1].when[0]", "themes[2].when[0]"]);
    expect(out.find((f) => f.path === "themes[1].when[0]")?.evidence).toBe("themes[0].when[1]");
    expect(out.find((f) => f.path === "themes[2].when[0]")?.evidence).toBe("themes[0].when[0]");
    expect(out.every((f) => f.severity === "avisa")).toBe(true);
    // Repetição dentro do mesmo assunto não é achado.
    expect(codes(data({ agents: [agent("a", { config: { channelIds: ["ch-1"], themes: [{ id: "t1", name: "Troca", instructions: "x", when: ["troca", "troca"] }] } })] }))).not.toContain("gatilho_repetido");
  });

  it("palavra solta no infinitivo avisa (casa em “não quero cancelar”); frase não", () => {
    const d = data({
      agents: [agent("a", { config: { channelIds: ["ch-1"], themes: [
        { id: "t1", name: "Cancelamento", instructions: "x", when: ["cancelar", "quero cancelar", "cancelamento"] },
      ] } })],
    });
    const out = find(d, "gatilho_palavra_solta");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "themes[0].when[0]", severity: "avisa", evidence: "cancelar" });
    expect(out[0].message).toContain("não quero cancelar");
  });

  it("gatilho que é cumprimento comum avisa", () => {
    const d = data({
      agents: [agent("a", { config: { channelIds: ["ch-1"], themes: [
        { id: "t1", name: "Saudação", instructions: "x", when: ["Bom dia", "oi, tudo bem?", "preço"] },
      ] } })],
    });
    expect(find(d, "gatilho_cumprimento").map((f) => f.path)).toEqual(["themes[0].when[0]", "themes[0].when[1]"]);
  });

  it("assunto sem instruções, material e destino avisa; com qualquer um deles, não", () => {
    const d = data({
      agents: [agent("a", { config: { channelIds: ["ch-1"], themes: [
        { id: "t1", name: "Vazio", instructions: "", when: ["prazo"] },
        { id: "t2", name: "Com destino", instructions: "", when: ["troca"], handoffDestination: { type: "department", id: DEPT } },
        { id: "t3", name: "Com material", instructions: "", when: ["entrega"], knowledgeDocIds: ["doc-1"] },
        { id: "t4", name: "Direto", instructions: "", when: ["humano"], directHandoff: true },
      ] } })],
    });
    expect(find(d, "assunto_vazio").map((f) => f.path)).toEqual(["themes[0].instructions"]);
  });
});

describe("3. calendário", () => {
  it("monthsInTitle lê nome do mês e dd/mm, ignora fração e abreviação solta", () => {
    expect(monthsInTitle("Prova de setembro")).toEqual([9]);
    expect(monthsInTitle("Entrega até 15/11")).toEqual([11]);
    expect(monthsInTitle("Prazo 05/03/2027")).toEqual([3]);
    expect(monthsInTitle("Parcela 2/12")).toEqual([]);
    expect(monthsInTitle("Festa à beira-mar")).toEqual([]);
    expect(monthsInTitle("Reunião 15 set")).toEqual([9]);
    expect(monthsInTitle("Início das aulas de MARÇO")).toEqual([3]);
  });

  it("mês do título diferente do mês da data avisa; período que inclui o mês não", () => {
    const d = data({
      agents: [agent("a", { config: { channelIds: ["ch-1"], calendar: { events: [
        { id: "e1", start: "2026-10-30", title: "Prazo final de setembro" },
        { id: "e2", start: "2026-10-15", title: "Prazo final de outubro" },
        { id: "e3", start: "2026-11-25", end: "2027-01-10", title: "Recesso de dezembro" },
        { id: "e4", start: "2026-12-01", title: "Resultado da seleção" },
      ] } } })],
    });
    const out = find(d, "calendario_mes_divergente");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "calendar.events[0]", severity: "avisa", evidence: "2026-10-30" });
    expect(out[0].message).toContain("setembro");
    expect(out[0].message).toContain("outubro");
  });

  it("evento duplicado (mesmo título e data) avisa no segundo", () => {
    const d = data({
      agents: [agent("a", { config: { channelIds: ["ch-1"], calendar: { events: [
        { id: "e1", start: "2026-11-10", title: "Entrega do relatório" },
        { id: "e2", start: "2026-11-10", title: "entrega do relatório" },
        { id: "e3", start: "2026-11-11", title: "Entrega do relatório" },
      ] } } })],
    });
    expect(find(d, "calendario_evento_duplicado")).toEqual([expect.objectContaining({ path: "calendar.events[1]", evidence: "calendar.events[0]" })]);
  });

  it("calendário só com datas passadas avisa; com uma futura, não", () => {
    const past = data({ agents: [agent("a", { config: { channelIds: ["ch-1"], calendar: { events: [{ id: "e1", start: "2026-09-01", end: "2026-09-10", title: "Inscrições" }] } } })] });
    expect(find(past, "calendario_so_passado")[0]).toMatchObject({ path: "calendar.events", severity: "avisa" });
    const future = data({ agents: [agent("a", { config: { channelIds: ["ch-1"], calendar: { events: [{ id: "e1", start: "2026-09-01", title: "Inscrições" }, { id: "e2", start: "2026-10-09", title: "Hoje" }] } } })] });
    expect(codes(future)).not.toContain("calendario_so_passado");
  });
});

describe("4. campos mesclados", () => {
  it("variableRefs lê @Chave e @Chave.sub, ignora e-mail", () => {
    expect(variableRefs("Olá @Nome, fale com contato@empresa.com ou @contact.phone.")).toEqual(["Nome", "contact.phone"]);
    expect(variableRefs("@Link{ acesse @Link }")).toEqual(["Link", "Link"]);
  });

  it("campo inexistente nas mensagens bloqueia; informação da empresa, campo liberado, builtin e montada passam", () => {
    const d = data({
      agents: [agent("a", { config: {
        channelIds: ["ch-1"],
        variables: [{ key: "NomeEmpresa", value: "Loja" }],
        contextFields: { contact: [{ key: "cf1", label: "Código" }], deal: [] },
        derivedFields: [{ id: "d1", label: "Senha", parts: [] }],
        entry: { openingMessage: "Olá @name, aqui é a @NomeEmpresa. Seu código: @cf1 / @Código. Senha: @Senha. E-mail: suporte@loja.com" },
        handoff: { defaultDestination: { type: "department", id: DEPT }, message: "Vou passar para @Atendente agora." },
        themes: [{ id: "t1", name: "Troca", instructions: "Use @Protocolo ao responder.", handoffDestination: { type: "department", id: DEPT, message: "Passando para @Setor" } }],
        rules: [{ id: "r1", name: "Atalho", actions: [{ type: "send_message", message: "Seu negócio: @deal.title, @contact.name, @Numero" }] }],
      } })],
    });
    const out = find(d, "campo_inexistente");
    expect(out.map((f) => [f.path, f.evidence])).toEqual([
      ["handoff.message", "Atendente"],
      ["themes[0].handoffDestination.message", "Setor"],
      ["themes[0].instructions", "Protocolo"],
      ["rules[0].actions[0].message", "Numero"],
    ]);
    expect(out.every((f) => f.severity === "bloqueia")).toBe(true);
  });

  it("variante com/sem acento: na mensagem bloqueia e cita o nome certo; entre chaves avisa", () => {
    const d = data({
      agents: [agent("a", { config: {
        channelIds: ["ch-1"],
        variables: [{ key: "Endereço", value: "Rua A" }, { key: "Endereco", value: "Rua B" }, { key: "Horário", value: "9h" }],
        entry: { openingMessage: "Estamos na @Endereço das @Horario." },
      } })],
    });
    const out = find(d, "campo_variante_acento");
    expect(out.find((f) => f.path === "entry.openingMessage")).toMatchObject({ severity: "bloqueia", evidence: "Horario" });
    expect(out.find((f) => f.path === "entry.openingMessage")?.message).toContain("“Horário”");
    expect(out.find((f) => f.path === "variables[1].key")).toMatchObject({ severity: "avisa", evidence: "variables[0].key" });
    expect(codes(d)).not.toContain("campo_inexistente");
  });
});

describe("5. tabulação", () => {
  it("assunto, padrão e byTheme apontando para folha inexistente bloqueiam; permitida inexistente avisa", () => {
    const d = data({
      agents: [agent("a", { config: {
        channelIds: ["ch-1"],
        themes: [{ id: "t1", name: "Troca", instructions: "x", tabulationId: "tab-sumiu" }, { id: "t2", name: "Prazo", instructions: "x", tabulationId: "tab-1" }],
        tabulation: { enabled: true, fallbackId: "tab-x", byTheme: { t2: "tab-y" }, allowedIds: ["tab-1", "tab-z"] },
      } })],
    });
    const out = find(d, "tabulacao_inexistente");
    expect(out.map((f) => [f.path, f.severity])).toEqual([
      ["themes[0].tabulationId", "bloqueia"],
      ["tabulation.fallbackId", "bloqueia"],
      ["tabulation.byTheme.t2", "bloqueia"],
      ["tabulation.allowedIds[1]", "avisa"],
    ]);
    expect(out[2].message).toContain("Prazo");
  });

  it("tabulação desligada não valida padrão nem byTheme (só o assunto)", () => {
    const d = data({ agents: [agent("a", { config: { channelIds: ["ch-1"], tabulation: { enabled: false, fallbackId: "tab-x" } } })] });
    expect(codes(d)).not.toContain("tabulacao_inexistente");
  });
});

describe("6. fluxos de automação no encerramento", () => {
  const talking = { id: "f1", name: "Pesquisa pós-atendimento", triggerType: "conversation_tabulated", active: true, steps: [{ type: "send_whatsapp_message", config: {} }] };
  const crmOnly = { id: "f2", name: "Mover etapa", triggerType: "conversation_tabulated", active: true, steps: [{ type: "move_stage", config: {} }] };

  it("chave desligada: fluxo que fala com o cliente não roda pelo agente → aviso", () => {
    const d = data({ agents: [agent("a", { config: { channelIds: ["ch-1"] } })], automations: [talking, crmOnly], runOnAiClose: false });
    const out = find(d, "fluxo_encerramento_nao_roda_pelo_agente");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "avisa", path: "closure", evidence: "f1" });
    expect(out[0].message).toContain("Pesquisa pós-atendimento");
    expect(codes(d)).not.toContain("fluxo_fala_com_cliente_no_encerramento");
  });

  it("chave ligada: fluxo fala em cima do pós-encerramento do agente → aviso", () => {
    const d = data({ agents: [agent("a", { config: { channelIds: ["ch-1"] } })], automations: [talking], runOnAiClose: true });
    expect(find(d, "fluxo_fala_com_cliente_no_encerramento")[0]).toMatchObject({ severity: "avisa", evidence: "f1" });
  });

  it("fluxo só de CRM, desligado ou de outro gatilho não gera aviso", () => {
    const d = data({
      agents: [agent("a", { config: { channelIds: ["ch-1"] } })],
      automations: [crmOnly, { ...talking, id: "f3", active: false }, { ...talking, id: "f4", triggerType: "deal_created" }],
    });
    expect(codes(d).filter((c) => c.startsWith("fluxo_"))).toEqual([]);
  });
});

describe("ordem e mapa de roteamento", () => {
  it("achados que bloqueiam vêm antes dos avisos", () => {
    const d = data({
      agents: [agent("a", { config: { channelIds: ["ch-1"], themes: [
        { id: "t1", name: "Saudação", instructions: "x", when: ["bom dia"] },
        { id: "t2", name: "Troca", instructions: "x", handoffDestination: { type: "department", id: "dep-sumiu" } },
      ] } })],
    });
    expect(validateAgentConfig("a", d).map((f) => f.severity)).toEqual(["bloqueia", "avisa"]);
  });

  it("mapa: nós de agentes e destinos, arestas assunto → destino, destino sumido marcado", () => {
    const d = data({
      agents: [
        agent("a", { config: { channelIds: ["ch-1"], themes: [
          { id: "t1", name: "Troca", instructions: "x", directHandoff: true, handoffDestination: { type: "ai_agent", id: "b" } },
          { id: "t2", name: "Prazo", instructions: "x", handoffDestination: { type: "user", id: "u-1" } },
          { id: "t3", name: "Entrega", instructions: "x", handoffDestination: { type: "department", id: "dep-sumiu" } },
        ], rules: [{ id: "r1", name: "Pessoa", actions: [{ type: "handoff", destination: { type: "distribution_rule", id: "dr-1" } }] }] } }),
        agent("b", { config: {} }),
      ],
    });
    const map = buildRoutingMap(d);
    const byKey = Object.fromEntries(map.nodes.map((n) => [`${n.kind}:${n.id}`, n]));
    expect(byKey["ai_agent:a"]).toMatchObject({ name: "a", firstAttendance: true, channelCount: 1 });
    expect(byKey["ai_agent:b"]).toMatchObject({ firstAttendance: true });
    expect(byKey["department:dep-vendas"]).toMatchObject({ name: "Vendas" });
    expect(byKey["department:dep-sumiu"]).toMatchObject({ missing: true });
    expect(byKey["user:u-1"]).toMatchObject({ name: "Ana" });
    expect(byKey["distribution_rule:dr-1"]).toMatchObject({ name: "Rodízio" });
    const edges = map.edges.filter((e) => e.from === "ai_agent:a").map((e) => [e.kind, e.label, e.to, e.direct]);
    expect(edges).toEqual([
      ["default", "Destino padrão", "department:dep-vendas", true],
      ["theme", "Troca", "ai_agent:b", true],
      ["theme", "Prazo", "user:u-1", false],
      ["theme", "Entrega", "department:dep-sumiu", false],
      ["rule", "Pessoa", "distribution_rule:dr-1", true],
    ]);
  });
});
