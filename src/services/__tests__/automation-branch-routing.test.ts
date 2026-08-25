/**
 * Testes do roteamento de ramos na RETOMADA de automações
 * (`automation-context.ts`): resposta do cliente e timeout.
 *
 * Regressão coberta — incidente INICIO-PIPE (Cruzeiro EaD, 03/ago/26): o
 * fallback linear `steps[index + 1]` era aplicado mesmo em automações
 * desenhadas no canvas. Como `automation.steps` é ordenado por `position`
 * (ordem de CRIAÇÃO no editor, não do fluxo), o timeout de um menu de
 * botões pulava pro passo do RAMO VIZINHO — o bot mandou vídeo/link e
 * moveu o lead pra "Em Atendimento" sem o cliente ter clicado em nada.
 */
import { describe, expect, it } from "vitest";

import {
  hasExplicitEdges,
  linearFallbackStepId,
  matchInteractiveOption,
  matchStaleInteractiveOption,
  readStepRef,
  shouldPersistDelay,
  decideInteractiveMenuInbound,
  isFlowKindButton,
  readAwaitingFlow,
} from "@/services/automation-context";

/** Recorte fiel da automação "inicio - pipe" que expôs o bug. */
const INICIO_PIPE_STEPS = [
  {
    id: "step0-boas-vindas",
    config: { nextStepId: "step2-menu", __hasExplicitEdges: true },
  },
  {
    id: "step1-distribuicao",
    config: { nextStepId: "step6-consultor", __hasExplicitEdges: true },
  },
  {
    // Menu principal: timeout desenhado no canvas aponta pro encerramento,
    // mas `timeoutAction` não foi gravado pelo editor.
    id: "step2-menu",
    config: {
      nextStepId: "step3-video",
      elseGotoStepId: "step19-repetir-menu",
      timeoutGotoStepId: "step22-encerrar-inatividade",
      timeoutMs: 900_000,
      __hasExplicitEdges: true,
      buttons: [
        { title: "Acesso a Plataforma", gotoStepId: "step3-video" },
        { title: "Financeiro", gotoStepId: "step12-financeiro" },
        { title: "Falar com equipe", gotoStepId: "step1-distribuicao" },
      ],
    },
  },
  {
    id: "step3-video",
    config: { nextStepId: "step4-link", __hasExplicitEdges: true },
  },
  {
    id: "step4-link",
    config: { nextStepId: "step5-mais-duvidas", __hasExplicitEdges: true },
  },
  {
    id: "step5-mais-duvidas",
    config: {
      nextStepId: "__none__",
      elseGotoStepId: "step21-repetir-duvidas",
      timeoutGotoStepId: "step22-encerrar-inatividade",
      timeoutMs: 900_000,
      __hasExplicitEdges: true,
      buttons: [
        { title: "Preciso de ajuda", gotoStepId: "step1-distribuicao" },
        { title: "Não!", gotoStepId: "step9-despedida" },
        { title: "Voltar para o início", gotoStepId: "step2-menu" },
      ],
    },
  },
  {
    id: "step6-consultor",
    config: { nextStepId: "step7-move-stage", __hasExplicitEdges: true },
  },
  {
    id: "step22-encerrar-inatividade",
    config: { nextStepId: "step23-finish-conversa", __hasExplicitEdges: true },
  },
];

describe("readStepRef", () => {
  it("lê a referência quando preenchida", () => {
    expect(readStepRef({ timeoutGotoStepId: "step22" }, "timeoutGotoStepId")).toBe(
      "step22",
    );
  });

  it("trata string vazia como ausente", () => {
    expect(readStepRef({ timeoutGotoStepId: "" }, "timeoutGotoStepId")).toBeNull();
  });

  it("trata o marcador __none__ (fim de ramo do canvas) como ausente", () => {
    expect(readStepRef({ nextStepId: "__none__" }, "nextStepId")).toBeNull();
  });

  it("ignora tipos não-string e configs inválidos", () => {
    expect(readStepRef({ nextStepId: 42 }, "nextStepId")).toBeNull();
    expect(readStepRef(null, "nextStepId")).toBeNull();
    expect(readStepRef("nao-e-objeto", "nextStepId")).toBeNull();
  });
});

describe("hasExplicitEdges", () => {
  it("detecta steps desenhados no canvas", () => {
    expect(hasExplicitEdges({ __hasExplicitEdges: true })).toBe(true);
  });

  it("steps legados (pré-canvas) não têm o marcador", () => {
    expect(hasExplicitEdges({})).toBe(false);
    expect(hasExplicitEdges({ __hasExplicitEdges: false })).toBe(false);
    expect(hasExplicitEdges(null)).toBe(false);
  });
});

describe("linearFallbackStepId", () => {
  it("BLOQUEIA o fallback linear em steps com arestas explícitas", () => {
    // Este é o coração do bug: sem a guarda, o timeout do menu (position 2)
    // caía em "step3-video" (position 3), que é o ramo "Acesso a Plataforma".
    expect(linearFallbackStepId(INICIO_PIPE_STEPS, "step2-menu")).toBeNull();
    expect(linearFallbackStepId(INICIO_PIPE_STEPS, "step5-mais-duvidas")).toBeNull();
  });

  it("permite o fallback linear em automações legadas", () => {
    const legacy = [
      { id: "a", config: {} },
      { id: "b", config: {} },
      { id: "c", config: {} },
    ];
    expect(linearFallbackStepId(legacy, "a")).toBe("b");
    expect(linearFallbackStepId(legacy, "b")).toBe("c");
  });

  it("devolve null no último step de um fluxo legado", () => {
    const legacy = [
      { id: "a", config: {} },
      { id: "b", config: {} },
    ];
    expect(linearFallbackStepId(legacy, "b")).toBeNull();
  });

  it("devolve null quando o step não existe mais na automação", () => {
    expect(linearFallbackStepId(INICIO_PIPE_STEPS, "step-apagado")).toBeNull();
  });
});

describe("roteamento de timeout — regressão INICIO-PIPE", () => {
  /**
   * Reproduz a decisão de `processTimeout` para `question` /
   * `send_whatsapp_interactive`: aresta desenhada tem prioridade sobre
   * `timeoutAction`, e o fallback linear só vale em fluxos legados.
   */
  function resolveTimeoutTarget(
    steps: { id: string; config: unknown }[],
    currentStepId: string,
  ): string | null {
    const step = steps.find((s) => s.id === currentStepId);
    return (
      readStepRef(step?.config, "timeoutGotoStepId") ??
      linearFallbackStepId(steps, currentStepId)
    );
  }

  it("segue timeoutGotoStepId mesmo sem timeoutAction:'goto' gravado", () => {
    expect(resolveTimeoutTarget(INICIO_PIPE_STEPS, "step2-menu")).toBe(
      "step22-encerrar-inatividade",
    );
  });

  it("não vaza para o ramo vizinho da array (bug original)", () => {
    // Antes da correção o resultado era "step3-video" (ramo "Acesso a
    // Plataforma") no primeiro timeout e "step6-consultor" (ramo "Falar
    // com equipe") no segundo.
    expect(resolveTimeoutTarget(INICIO_PIPE_STEPS, "step2-menu")).not.toBe(
      "step3-video",
    );
    expect(resolveTimeoutTarget(INICIO_PIPE_STEPS, "step5-mais-duvidas")).not.toBe(
      "step6-consultor",
    );
  });

  it("ambos os menus do fluxo convergem para o encerramento por inatividade", () => {
    expect(resolveTimeoutTarget(INICIO_PIPE_STEPS, "step5-mais-duvidas")).toBe(
      "step22-encerrar-inatividade",
    );
  });

  it("encerra o fluxo quando o canvas não conectou a aresta de timeout", () => {
    const semTimeout = [
      {
        id: "menu",
        config: { __hasExplicitEdges: true, buttons: [{ title: "A", gotoStepId: "x" }] },
      },
      { id: "ramo-vizinho", config: { __hasExplicitEdges: true } },
    ];
    expect(resolveTimeoutTarget(semTimeout, "menu")).toBeNull();
  });
});

describe("delay persistido — incidente 11/ago/26 (worker travado por delay de 7d)", () => {
  /**
   * Reproduz a decisão de `processTimeout` para o step `delay`: a espera
   * persistida (timeoutAt) expira e o fluxo segue a aresta `nextStepId`;
   * o fallback linear só vale em fluxo legado (pré-canvas).
   */
  function resolveDelayTarget(
    steps: { id: string; config: unknown }[],
    currentStepId: string,
  ): string | null {
    const step = steps.find((s) => s.id === currentStepId);
    return (
      readStepRef(step?.config, "nextStepId") ??
      linearFallbackStepId(steps, currentStepId)
    );
  }

  it("delay curto roda inline; delay longo é persistido", () => {
    // threshold default 30s (AUTOMATION_DELAY_INLINE_MAX_MS)
    expect(shouldPersistDelay(5_000, 30_000)).toBe(false);
    expect(shouldPersistDelay(30_000, 30_000)).toBe(false);
    expect(shouldPersistDelay(60_000, 30_000)).toBe(true);
    expect(shouldPersistDelay(604_800_000, 30_000)).toBe(true); // 7 dias
    expect(shouldPersistDelay(10_000, 0)).toBe(true); // threshold 0 = sempre persiste
  });

  it("ao expirar, segue o nextStepId desenhado no canvas", () => {
    const steps = [
      {
        id: "delay-7d",
        config: { ms: 604_800_000, nextStepId: "tpl_prop_2", __hasExplicitEdges: true },
      },
      { id: "tpl_prop_2", config: { __hasExplicitEdges: true } },
    ];
    expect(resolveDelayTarget(steps, "delay-7d")).toBe("tpl_prop_2");
  });

  it("nextStepId __none__ (fim de ramo) encerra o fluxo", () => {
    const steps = [
      {
        id: "delay",
        config: { ms: 60_000, nextStepId: "__none__", __hasExplicitEdges: true },
      },
      { id: "outro", config: { __hasExplicitEdges: true } },
    ];
    expect(resolveDelayTarget(steps, "delay")).toBeNull();
  });

  it("delay sem aresta NÃO vaza pro próximo da array em canvas", () => {
    const steps = [
      { id: "delay", config: { ms: 60_000, __hasExplicitEdges: true } },
      { id: "ramo-vizinho", config: { __hasExplicitEdges: true } },
    ];
    expect(resolveDelayTarget(steps, "delay")).toBeNull();
  });

  it("fluxo legado (sem __hasExplicitEdges) cai no próximo da array", () => {
    const legacy = [
      { id: "delay", config: { ms: 60_000 } },
      { id: "proxima-msg", config: {} },
    ];
    expect(resolveDelayTarget(legacy, "delay")).toBe("proxima-msg");
  });
});

describe("roteamento de botão — botão válido sem aresta conectada", () => {
  /**
   * Reproduz a decisão de `processIncomingMessage` quando o cliente
   * escolhe uma opção do menu: aresta do botão → saída padrão do passo →
   * saída "nenhuma opção". Clicar certo nunca pode ser tratado como
   * resposta inválida.
   */
  function resolveButtonTarget(
    config: Record<string, unknown>,
    resposta: string,
    interactiveId?: string | null,
  ): string | null {
    const buttons = ((config.buttons ?? config.rows) ?? []) as {
      title?: string;
      text?: string;
      id?: string;
      gotoStepId?: string;
    }[];
    const matched = matchInteractiveOption(buttons, resposta, interactiveId);
    const elseGoto = readStepRef(config, "elseGotoStepId");
    const defaultOut = readStepRef(config, "nextStepId");
    if (matched) {
      return readStepRef(matched, "gotoStepId") ?? defaultOut ?? elseGoto;
    }
    return elseGoto;
  }

  /** Recorte real de "Follow-up de envio de vaga" (Dna Work), passo pos 7. */
  const MOTIVO_SAIDA = {
    __hasExplicitEdges: true,
    nextStepId: "ee610fcb-encerramento",
    elseGotoStepId: "",
    timeoutGotoStepId: "",
    buttons: [
      { title: "✅ Consegui um emprego", gotoStepId: "" },
      { title: "⏸️ Vou pausar a busca por ora", gotoStepId: "ee610fcb-encerramento" },
      { title: "🐢 O processo demorou muito", gotoStepId: "ee610fcb-encerramento" },
    ],
  };

  it("botão conectado segue a própria aresta", () => {
    expect(resolveButtonTarget(MOTIVO_SAIDA, "⏸️ Vou pausar a busca por ora")).toBe(
      "ee610fcb-encerramento",
    );
  });

  it("botão SEM aresta herda a saída padrão do passo (não fica órfão)", () => {
    expect(resolveButtonTarget(MOTIVO_SAIDA, "✅ Consegui um emprego")).toBe(
      "ee610fcb-encerramento",
    );
  });

  it("o match de botão é case-insensitive e tolera espaços", () => {
    expect(resolveButtonTarget(MOTIVO_SAIDA, "  ⏸️ VOU PAUSAR A BUSCA POR ORA  ")).toBe(
      "ee610fcb-encerramento",
    );
  });

  it("texto livre sem saída 'nenhuma opção' não escolhe destino nenhum", () => {
    // O chamador mantém o contexto parado no mesmo passo nesse caso.
    expect(resolveButtonTarget(MOTIVO_SAIDA, "quero falar com alguém")).toBeNull();
  });

  it("texto livre usa a saída 'nenhuma opção' quando conectada", () => {
    const menuComElse = {
      ...MOTIVO_SAIDA,
      elseGotoStepId: "repetir-menu",
    };
    expect(resolveButtonTarget(menuComElse, "blablabla")).toBe("repetir-menu");
  });

  it("botão sem aresta e passo sem saída padrão cai em 'nenhuma opção'", () => {
    const semDefault = {
      __hasExplicitEdges: true,
      nextStepId: "__none__",
      elseGotoStepId: "repetir-menu",
      buttons: [{ title: "Órfão", gotoStepId: "" }],
    };
    expect(resolveButtonTarget(semDefault, "Órfão")).toBe("repetir-menu");
  });

  it("lista com título template casa pelo interactiveId (list_reply.id)", () => {
    // Envio interpola {{contact.name}} → "João"; config cru não bate no título.
    const lista = {
      __hasExplicitEdges: true,
      nextStepId: "__none__",
      elseGotoStepId: "",
      rows: [
        {
          id: "row-nome",
          title: "{{contact.name}}",
          gotoStepId: "proximo-passo",
        },
      ],
    };
    expect(resolveButtonTarget(lista, "João")).toBeNull();
    expect(resolveButtonTarget(lista, "João", "row-nome")).toBe("proximo-passo");
  });

  it("lista com título template e id ausente casa pelo fallback row_N do executor", () => {
    // Executor envia r.id || `row_${i}` — JSON salvo sem id ainda retoma o ramo.
    const lista = {
      __hasExplicitEdges: true,
      nextStepId: "__none__",
      elseGotoStepId: "",
      rows: [
        {
          title: "{{contact.name}}",
          gotoStepId: "tag-pos-lista",
        },
      ],
    };
    expect(resolveButtonTarget(lista, "Maria")).toBeNull();
    expect(resolveButtonTarget(lista, "Maria", "row_0")).toBe("tag-pos-lista");
  });
});

describe("matchInteractiveOption", () => {
  it("casa título, id do config e fallback btn_N / row_N", () => {
    const opts = [
      { title: "Alpha", id: "a1", gotoStepId: "s1" },
      { title: "{{contact.name}}", gotoStepId: "s2" },
    ];
    expect(matchInteractiveOption(opts, "Alpha")?.gotoStepId).toBe("s1");
    expect(matchInteractiveOption(opts, "x", "a1")?.gotoStepId).toBe("s1");
    expect(matchInteractiveOption(opts, "João", "row_1")?.gotoStepId).toBe("s2");
    expect(matchInteractiveOption(opts, "João", "btn_1")?.gotoStepId).toBe("s2");
    expect(matchInteractiveOption(opts, "João", "ROW_1")?.gotoStepId).toBe("s2");
  });
});

describe("matchStaleInteractiveOption — clique em menu anterior (WhatsApp)", () => {
  const BV_STEPS = [
    {
      id: "welcome",
      config: {
        buttons: [
          { id: "btn_0", title: "Sobre o Curso", gotoStepId: "webhook-curso" },
          { id: "btn_1", title: "Receber dados de acesso", gotoStepId: "webhook-acesso" },
          { id: "btn_2", title: "Não, obrigado", gotoStepId: "webhook-nao" },
        ],
      },
    },
    {
      id: "menu-curso",
      config: {
        elseGotoStepId: "repetir-menu",
        buttons: [
          { id: "btn_mrw_0", title: "Acesso ao Portal", gotoStepId: "portal" },
          { id: "btn_mrw_1", title: "Financeiro", gotoStepId: "fin" },
          { id: "btn_mrw_2", title: "Entrega de Documentos", gotoStepId: "docs" },
        ],
      },
    },
    {
      id: "plataforma-acesso",
      config: {
        buttons: [
          { id: "btn_acesso_pc", title: "Portal (computador)", gotoStepId: "acesso-pc" },
          { id: "btn_acesso_app", title: "App Duda (celular)", gotoStepId: "acesso-app" },
        ],
      },
    },
    {
      id: "plataforma-docs",
      config: {
        buttons: [
          { id: "btn_docs_pc", title: "Portal (computador)", gotoStepId: "docs-pc" },
          { id: "btn_docs_app", title: "App Duda (celular)", gotoStepId: "docs-app" },
        ],
      },
    },
  ];

  it("Daniela: no menu do curso, 'Receber dados de acesso' do welcome segue a perna de credencial", () => {
    const hit = matchStaleInteractiveOption(
      BV_STEPS,
      "menu-curso",
      "Receber dados de acesso",
      "btn_1",
    );
    expect(hit?.gotoStepId).toBe("webhook-acesso");
  });

  it("não adivinha título repetido sem id distintivo (Portal em dois menus)", () => {
    expect(
      matchStaleInteractiveOption(BV_STEPS, "menu-curso", "Portal (computador)"),
    ).toBeUndefined();
  });

  it("id explícito do menu antigo desambigua título repetido", () => {
    const hit = matchStaleInteractiveOption(
      BV_STEPS,
      "plataforma-docs",
      "Portal (computador)",
      "btn_acesso_pc",
    );
    expect(hit?.gotoStepId).toBe("acesso-pc");
  });

  it("id genérico btn_N sozinho não casa o welcome errado", () => {
    expect(
      matchStaleInteractiveOption(BV_STEPS, "menu-curso", "blablabla", "btn_0"),
    ).toBeUndefined();
  });

  it("título truncado em 20 chars (Entrega de Documentos) ainda casa", () => {
    const hit = matchStaleInteractiveOption(
      BV_STEPS,
      "welcome",
      "Entrega de Documento",
    );
    expect(hit?.gotoStepId).toBe("docs");
  });
});

describe("decideInteractiveMenuInbound — botão de ação vs Flow", () => {
  const buttons = [
    { id: "btn_0", title: "Sim", kind: "action", gotoStepId: "step-sim" },
    {
      id: "btn_1",
      title: "Trocar endereço",
      kind: "flow",
      flowDefinitionId: "flow-def-1",
      gotoStepId: "step-depois-flow",
    },
  ];

  it("kind flow sem nfm_reply dispara envio do Flow", () => {
    const d = decideInteractiveMenuInbound({
      buttons,
      messageContent: "Trocar endereço",
      interactiveId: "btn_1",
    });
    expect(d.action).toBe("send_flow");
    if (d.action === "send_flow") {
      expect(d.buttonId).toBe("btn_1");
      expect(d.button.flowDefinitionId).toBe("flow-def-1");
    }
  });

  it("kind action segue goto do botão", () => {
    const d = decideInteractiveMenuInbound({
      buttons,
      messageContent: "Sim",
      interactiveId: "btn_0",
    });
    expect(d.action).toBe("goto_button");
    if (d.action === "goto_button") {
      expect(d.button.gotoStepId).toBe("step-sim");
    }
  });

  it("nfm_reply com o mesmo flow_token completa o Flow", () => {
    const d = decideInteractiveMenuInbound({
      buttons,
      messageContent: "Campo: Rua A",
      flowReply: true,
      flowToken: "tok-abc",
      awaitingFlow: {
        stepId: "menu",
        buttonId: "btn_1",
        flowToken: "tok-abc",
        gotoStepId: "step-depois-flow",
      },
    });
    expect(d.action).toBe("complete_flow");
    if (d.action === "complete_flow") expect(d.buttonId).toBe("btn_1");
  });

  it("nfm_reply sem token da Meta ainda completa (omissão conhecida)", () => {
    const d = decideInteractiveMenuInbound({
      buttons,
      messageContent: "Campo: Rua A",
      flowReply: true,
      flowToken: null,
      awaitingFlow: {
        stepId: "menu",
        buttonId: "btn_1",
        flowToken: "tok-abc",
      },
    });
    expect(d.action).toBe("complete_flow");
  });

  it("nfm_reply com token diferente permanece pausado", () => {
    const d = decideInteractiveMenuInbound({
      buttons,
      messageContent: "Campo: outro",
      flowReply: true,
      flowToken: "tok-outro",
      awaitingFlow: {
        stepId: "menu",
        buttonId: "btn_1",
        flowToken: "tok-abc",
      },
    });
    expect(d.action).toBe("stay");
  });

  it("texto formatado do Flow sem awaiting cai em no_match (não casa botão)", () => {
    const d = decideInteractiveMenuInbound({
      buttons,
      messageContent: "Sexo: Masculino",
      flowReply: true,
      flowToken: "x",
    });
    expect(d.action).toBe("no_match");
  });

  it("isFlowKindButton e readAwaitingFlow", () => {
    expect(isFlowKindButton({ kind: "flow" })).toBe(true);
    expect(isFlowKindButton({ kind: "action", flowDefinitionId: "x" })).toBe(false);
    expect(isFlowKindButton({ flowDefinitionId: "x" })).toBe(true);
    expect(
      readAwaitingFlow({
        __awaitingFlow: { stepId: "s", buttonId: "b", flowToken: "t", gotoStepId: "g" },
      }),
    ).toEqual({ stepId: "s", buttonId: "b", flowToken: "t", gotoStepId: "g" });
    expect(readAwaitingFlow({})).toBeNull();
  });
});
