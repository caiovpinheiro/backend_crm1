import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { answerToPostCloseQuestion, classifyPostCloseMessage, isGreetingOnlyMessage, isNewRequest, postCloseHandoffMessage, postCloseQuestion, postCloseShortReply } from "@/services/ai-v2/closure";
import { isConfusionMessage, rephraseAfterConfusion } from "@/services/ai-v2/confusion";
import { decideV2Idle } from "@/services/ai-v2/inactivity";
import { pickV2TabulationId } from "@/services/ai-v2/tabulation";
import { isShortFollowUp, themeThresholds } from "@/services/ai-v2/theme-semantic";
import { knowledgeMinSimilarity } from "@/services/ai-v2/similarity-presets";
import { describeV2ContextForTrace } from "@/services/ai-v2/context";
import { isGreetingOnlyReply } from "@/services/ai-v2/reply-ending";

const cfg = (extra: Record<string, unknown> = {}): V2AgentConfig =>
  normalizeV2Config({
    name: "A",
    tone: "t",
    themes: [{ id: "t1", name: "Assunto 1", instructions: "x", tabulationId: "tab-t1" }, { id: "t2", name: "Assunto 2", instructions: "y" }],
    ...extra,
  } as never);

describe("cliente confuso", () => {
  it("reconhece só confusão, não pergunta nova", () => {
    for (const m of ["?", "??", " ? ", "não entendi", "Não entendi nada", "como assim?", "hein?"]) expect(isConfusionMessage(m)).toBe(true);
    for (const m of ["qual o prazo?", "não entendi o prazo da entrega", "", "ok"]) expect(isConfusionMessage(m)).toBe(false);
    for (const m of ["Desculpe, estou confusa", "fiquei super perdida no app", "to meio perdido", "não estou entendendo nada"]) {
      expect(isConfusionMessage(m)).toBe(true);
      expect(isConfusionMessage(m, { includeState: false })).toBe(false);
    }
    for (const m of ["estou confusa com o valor da parcela, quanto é?", "fiquei perdida, onde clico para incluir o item?"]) expect(isConfusionMessage(m)).toBe(false);
  });

  it("refaz a última pergunta do agente, ou pede o que ficou confuso", () => {
    expect(rephraseAfterConfusion("Entendi. Qual documento você precisa enviar?")).toBe("Desculpa, acho que não fui claro. Qual documento você precisa enviar?");
    expect(rephraseAfterConfusion("O prazo é de 5 dias.")).toContain("O que ficou confuso?");
    expect(rephraseAfterConfusion(null)).toContain("O que ficou confuso?");
  });
});

describe("pergunta depois de encerrar", () => {
  it("textos da config ou padrão; rótulo até 20 caracteres", () => {
    expect(postCloseQuestion(cfg())).toEqual({ message: "Você precisa de ajuda com algo novo?", yes: "Preciso de ajuda", no: "Só agradecer" });
    const own = cfg({ closure: { postCloseQuestion: { message: "Mais alguma coisa?", yesLabel: "Sim, tenho outra dúvida aqui", noLabel: "Não" }, postCloseMessages: { courtesy: "Disponha!" } } });
    expect(postCloseQuestion(own)).toEqual({ message: "Mais alguma coisa?", yes: "Sim, tenho outra dúv", no: "Não" });
    expect(postCloseShortReply(own)).toBe("Disponha!");
  });

  it("depois da pergunta, a resposta decide e nunca se pergunta de novo", () => {
    const c = cfg();
    const pending = ["Preciso de ajuda", "Só agradecer"];
    expect(answerToPostCloseQuestion(c, pending, "Preciso de ajuda")).toBe("new_demand");
    expect(answerToPostCloseQuestion(c, pending, "Só agradecer")).toBe("courtesy");
    // Escreveu outra coisa ("Oi" de novo): é pedido novo, não repete a pergunta.
    expect(answerToPostCloseQuestion(c, pending, null)).toBe("new_demand");
    // Opções pendentes de outra pergunta: não é com ela.
    expect(answerToPostCloseQuestion(c, ["A", "B"], null)).toBeNull();
    expect(answerToPostCloseQuestion(c, [], null)).toBeNull();
  });
});

describe("tabulação", () => {
  it("desligada não tabula; assunto > por assunto > padrão; respeita o momento", () => {
    expect(pickV2TabulationId(cfg(), null, "close")).toBeNull();
    const on = cfg({ tabulation: { enabled: true, when: "on_close", fallbackId: "tab-padrao", byTheme: { t2: "tab-t2" } } });
    expect(pickV2TabulationId(on, on.themes[0], "close")).toBe("tab-t1");
    expect(pickV2TabulationId(on, on.themes[1], "close")).toBe("tab-t2");
    expect(pickV2TabulationId(on, null, "close")).toBe("tab-padrao");
    expect(pickV2TabulationId(on, null, "transfer")).toBeNull();
    const always = cfg({ tabulation: { enabled: true, when: "always", fallbackId: "tab-padrao" } });
    expect(pickV2TabulationId(always, null, "transfer")).toBe("tab-padrao");
  });
});

describe("inatividade", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60 * 1000);
  const base = { lastInboundAt: ago(40), now, sent: 0, lastFollowUpAt: null };

  it("desligada: nada", () => {
    expect(decideV2Idle({ ...base, inactivity: { enabled: false, closeAfter: 30 }, anchorAt: ago(100) })).toEqual({ action: "none" });
  });

  it("sem lembrete: encerra no prazo", () => {
    const inactivity = { enabled: true, nudgeAfter: 0, closeAfter: 30 };
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(29) })).toEqual({ action: "none" });
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(31) })).toEqual({ action: "close" });
  });

  it("aviso único antigo: avisa, e encerra contando do aviso o que falta", () => {
    const inactivity = { enabled: true, nudgeAfter: 20, closeAfter: 30 };
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(21) })).toEqual({ action: "followup", index: 0 });
    // Aviso mandado com atraso (há 5 min, âncora há 31): ainda faltam 5 dos 10 minutos.
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(31), sent: 1, lastFollowUpAt: ago(5) })).toEqual({ action: "none" });
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(31), sent: 1, lastFollowUpAt: ago(11) })).toEqual({ action: "close" });
  });

  it("três lembretes em sequência e depois o encerramento", () => {
    const inactivity = { enabled: true, closeAfter: 60, followUps: [{ after: 10 }, { after: 25 }, { after: 45 }] };
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(11) })).toEqual({ action: "followup", index: 0 });
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(20), sent: 1, lastFollowUpAt: ago(9) })).toEqual({ action: "none" });
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(26), sent: 1, lastFollowUpAt: ago(15) })).toEqual({ action: "followup", index: 1 });
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(46), sent: 2, lastFollowUpAt: ago(20) })).toEqual({ action: "followup", index: 2 });
    expect(decideV2Idle({ ...base, inactivity, anchorAt: ago(61), sent: 3, lastFollowUpAt: ago(16) })).toEqual({ action: "close" });
  });

  it("fora da janela de 24h não manda lembrete (só encerra no prazo)", () => {
    const inactivity = { enabled: true, nudgeAfter: 20, closeAfter: 30 };
    expect(decideV2Idle({ ...base, lastInboundAt: ago(60 * 25), inactivity, anchorAt: ago(21) })).toEqual({ action: "none" });
  });
});

describe("lembretes: texto conforme a última mensagem e o escrito pelo agente", () => {
  it("passo a passo → “conseguiu?”; pergunta → “ainda está aí?”; outra → texto geral", async () => {
    const { followUpFixedText, idleKindOf, FOLLOWUP_PROCEDURE_DEFAULT, FOLLOWUP_QUESTION_DEFAULT } = await import("@/services/ai-v2/inactivity");
    const cfg = { replyEnding: undefined, themes: [] } as never;
    expect(idleKindOf("Faça assim:\n1. Abra o app.\n2. Toque em Pedidos.", cfg)).toBe("procedure");
    expect(idleKindOf("Qual é o número do pedido?", cfg)).toBe("question");
    expect(idleKindOf("O prazo de entrega é de três dias úteis.", cfg)).toBe("other");
    const step = { after: 10, mode: "by_reply" as const };
    expect(followUpFixedText(step, "procedure")).toBe(FOLLOWUP_PROCEDURE_DEFAULT);
    expect(followUpFixedText(step, "question")).toBe(FOLLOWUP_QUESTION_DEFAULT);
    expect(followUpFixedText({ ...step, procedureMessage: "Deu certo?" }, "procedure")).toBe("Deu certo?");
    expect(followUpFixedText({ after: 10, mode: "fixed", message: "Oi?" }, "procedure")).toBe("Oi?");
  });

  it("texto escrito pelo agente só vale curto e sem número, data ou link", async () => {
    const { acceptableGeneratedFollowUp } = await import("@/services/ai-v2/inactivity");
    expect(acceptableGeneratedFollowUp("Conseguiu abrir a tela de pedidos? Se travou em algum passo, me conta.")).toBe("Conseguiu abrir a tela de pedidos? Se travou em algum passo, me conta.");
    expect(acceptableGeneratedFollowUp("O prazo é dia 15, conseguiu?")).toBeNull();
    expect(acceptableGeneratedFollowUp("Veja em https://x.exemplo.com")).toBeNull();
    expect(acceptableGeneratedFollowUp("")).toBeNull();
  });

  it("config: até 3 lembretes; lembrete depois do encerramento não vale", async () => {
    const { followUpSteps } = await import("@/services/ai-v2/inactivity");
    expect(followUpSteps({ enabled: true, closeAfter: 30, followUps: [{ after: 40 }, { after: 10 }, { after: 20 }] }).map((s) => s.after)).toEqual([10, 20]);
    expect(followUpSteps({ enabled: true, closeAfter: 30, nudgeAfter: 15, nudgeMessage: "Oi?" })).toEqual([{ after: 15, mode: "fixed", message: "Oi?" }]);
  });
});

describe("reconhecimento de assunto", () => {
  it("réguas pela opção (rígido / equilibrado / flexível); números não vêm da config", () => {
    expect(themeThresholds(cfg())).toEqual({ minSimilarity: 0.4, switchSimilarity: 0.5, switchMargin: 0.05, shortMessageWords: 2 });
    const strict = themeThresholds(cfg({ themeRecognition: { preset: "strict" } }));
    const loose = themeThresholds(cfg({ themeRecognition: { preset: "loose" } }));
    expect(strict.minSimilarity).toBeGreaterThan(0.4);
    expect(strict.switchMargin).toBeGreaterThan(0.05);
    expect(loose.minSimilarity).toBeLessThan(0.4);
    // Número solto na config é ignorado.
    expect(themeThresholds(cfg({ themeRecognition: { minSimilarity: 0.9 } }))).toEqual(themeThresholds(cfg()));
  });

  it("trechos dos materiais pela opção", () => {
    expect(knowledgeMinSimilarity(cfg())).toBe(0);
    expect(knowledgeMinSimilarity(cfg({ knowledgeSearch: { preset: "related" } }))).toBeGreaterThan(0);
    expect(knowledgeMinSimilarity(cfg({ knowledgeSearch: { preset: "close" } }))).toBeGreaterThan(knowledgeMinSimilarity(cfg({ knowledgeSearch: { preset: "related" } })));
  });

  it("acompanhamento curto mantém o assunto; assunto em duas palavras pode trocar", () => {
    expect(isShortFollowUp("ok", 2)).toBe(true);
    expect(isShortFollowUp("consegue me enviar?", 2)).toBe(true);
    expect(isShortFollowUp("segunda chamada", 2)).toBe(false);
    expect(isShortFollowUp("segunda chamada", 3)).toBe(true);
  });
});

describe("depois de encerrar: classificação e mensagens por caso", () => {
  const c = cfg();
  it("agradecimento, confirmação e despedida", () => {
    for (const m of ["combinado", "valeu", "Não, obrigado(a)!", "👏 Deu Certo!", "não entendi, foi resolvido", "ok 👍", "👍", "consegui, obrigado", "era só isso"]) {
      expect(classifyPostCloseMessage(c, m)).toBe("courtesy");
    }
  });
  it("pedido novo", () => {
    for (const m of ["Preciso de ajuda", "não consegui acessar", "quero trocar meu plano", "sim"]) {
      expect(classifyPostCloseMessage(c, m)).toBe("new_demand");
    }
  });
  it("cumprimento e \"??\" são ambíguos (nunca agradecimento)", () => {
    for (const m of ["bom dia", "Oi", "oi, tudo bem?", "??"]) expect(classifyPostCloseMessage(c, m)).toBe("ambiguous");
  });
  it("\"deu certo\" não é pedido novo (o encerramento do modelo vale)", () => {
    expect(isNewRequest(c, "👏 Deu Certo!")).toBe(false);
    expect(isNewRequest(c, "e quando sai a nota?")).toBe(true);
  });
  it("mensagem por caso, com a geral e o padrão como reserva", () => {
    const own = cfg({ closure: { shortReplyMessage: "Geral", postCloseMessages: { new_demand: "Vou te passar para a equipe." } }, handoff: { defaultDestination: { type: "department" }, message: "Transferindo." } });
    // A resposta única antiga não vale mais: sem mensagem própria, o padrão.
    expect(postCloseShortReply(own, "courtesy")).toContain("Por nada");
    expect(postCloseShortReply(own, "new_demand")).toBe("Vou te passar para a equipe.");
    expect(postCloseHandoffMessage(own, "new_demand")).toBe("Vou te passar para a equipe.");
    expect(postCloseHandoffMessage(own, "ambiguous")).toBe("Transferindo.");
    expect(postCloseShortReply(cfg(), "courtesy")).toContain("Por nada");
  });
});

describe("passo dados: o que o agente recebeu do cadastro", () => {
  it("lista rótulos (sem valores) e diz por que a informação montada não saiu", () => {
    const c = cfg({
      contextFields: { contact: [{ key: "doc", label: "Documento", permissions: ["read"] }], deal: [{ key: "mail", label: "E-mail da conta", permissions: ["read", "cite"] }] },
      derivedFields: [
        { id: "a", label: "Código", parts: [{ kind: "field", key: "name", take: "first", count: 3 }, { kind: "field", key: "doc" }] },
        { id: "b", label: "Outro", parts: [{ kind: "field", take: "all" }] },
      ],
    });
    const text = describeV2ContextForTrace(c, {
      contact: { Documento: "123" },
      contactRaw: { name: "Ana", doc: "" },
      citableContact: {},
      selectedDeal: { "E-mail da conta": "x@y.com" },
      selectedDealRaw: { mail: "x@y.com" },
      citableDeal: { "E-mail da conta": "x@y.com" },
      deals: [],
      fields: c.contextFields,
    } as never);
    expect(text).toContain("Contato: usa Documento");
    expect(text).toContain("Negócio: usa E-mail da conta; pode dizer E-mail da conta");
    expect(text).toContain("Código ✗ (Documento vazio)");
    expect(text).toContain("Outro ✗ (parte 1 sem campo)");
    expect(text).not.toContain("x@y.com");
  });

  it("campo configurado sem valor aparece — e avisa quando o nome existe na outra entidade", () => {
    const c = cfg({ contextFields: { contact: [{ key: "cf1", label: "Código da conta", permissions: ["read", "cite"] }], deal: [] } });
    const text = describeV2ContextForTrace(c, {
      contact: { Nome: "Ana" },
      contactRaw: { name: "Ana" },
      citableContact: {},
      selectedDeal: null,
      deals: [],
      fields: c.contextFields,
      emptyFields: [{ entity: "contact", label: "Código da conta", onOtherEntity: true }],
    } as never);
    expect(text).toContain("Configurados sem valor: Código da conta (contato; há campo com esse nome no negócio — configure lá)");
  });

  it("sem cadastro", () => {
    expect(describeV2ContextForTrace(cfg(), { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } } as never)).toContain("Contato: sem cadastro");
  });
});

describe("resposta que é só saudação", () => {
  it("reconhece cumprimento/convite sem conteúdo", () => {
    for (const r of ["Oi, Ana! Boa tarde 😊 Como posso ajudar você hoje?", "Olá! Em que posso te ajudar?", "Bom dia! Me conta o que você precisa."]) {
      expect(isGreetingOnlyReply(r)).toBe(true);
    }
  });
  it("resposta com conteúdo não é saudação", () => {
    for (const r of ["Para emitir a fatura, acesse https://exemplo.com e toque em Pagar.", "O prazo é 19/10. Posso ajudar em algo mais?", ""]) {
      expect(isGreetingOnlyReply(r)).toBe(false);
    }
  });
});

describe("mensagem que é só cumprimento", () => {
  it("cumprimentos (combinados ou não) e pedidos", () => {
    for (const m of ["Oi", "Oi, boa tarde!", "olá, tudo bem?", "Bom dia", "oi oi"]) expect(isGreetingOnlyMessage(m)).toBe(true);
    for (const m of ["Oi, preciso da fatura", "bom dia, qual o prazo?", "valeu", ""]) expect(isGreetingOnlyMessage(m)).toBe(false);
  });
});
