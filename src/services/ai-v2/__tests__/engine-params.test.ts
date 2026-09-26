import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { answerToPostCloseQuestion, classifyPostCloseMessage, isNewRequest, postCloseHandoffMessage, postCloseQuestion, postCloseShortReply } from "@/services/ai-v2/closure";
import { isConfusionMessage, rephraseAfterConfusion } from "@/services/ai-v2/confusion";
import { NUDGE_MESSAGE_DEFAULT, decideV2Idle } from "@/services/ai-v2/inactivity";
import { pickV2TabulationId } from "@/services/ai-v2/tabulation";
import { isShortFollowUp, themeThresholds } from "@/services/ai-v2/theme-semantic";

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
    for (const m of ["qual o prazo?", "não entendi o prazo da prova", "", "ok"]) expect(isConfusionMessage(m)).toBe(false);
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
    const own = cfg({ closure: { postCloseQuestion: { message: "Mais alguma coisa?", yesLabel: "Sim, tenho outra dúvida aqui", noLabel: "Não" }, shortReplyMessage: "Disponha!" } });
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
  const base = { nudgeText: NUDGE_MESSAGE_DEFAULT, lastInboundAt: ago(40), now };

  it("desligada: nada", () => {
    expect(decideV2Idle({ ...base, inactivity: { enabled: false, closeAfter: 30 }, lastOutAt: ago(100), lastOutText: "x" })).toBe("none");
  });

  it("sem aviso: encerra no prazo", () => {
    const inactivity = { enabled: true, nudgeAfter: 0, closeAfter: 30 };
    expect(decideV2Idle({ ...base, inactivity, lastOutAt: ago(29), lastOutText: "x" })).toBe("none");
    expect(decideV2Idle({ ...base, inactivity, lastOutAt: ago(31), lastOutText: "x" })).toBe("close");
  });

  it("com aviso: avisa, e encerra contando do aviso o que falta", () => {
    const inactivity = { enabled: true, nudgeAfter: 20, closeAfter: 30 };
    expect(decideV2Idle({ ...base, inactivity, lastOutAt: ago(21), lastOutText: "Resposta" })).toBe("nudge");
    expect(decideV2Idle({ ...base, inactivity, lastOutAt: ago(5), lastOutText: NUDGE_MESSAGE_DEFAULT })).toBe("none");
    expect(decideV2Idle({ ...base, inactivity, lastOutAt: ago(11), lastOutText: NUDGE_MESSAGE_DEFAULT })).toBe("close");
  });

  it("fora da janela de 24h não avisa (só encerra no prazo)", () => {
    const inactivity = { enabled: true, nudgeAfter: 20, closeAfter: 30 };
    expect(decideV2Idle({ ...base, lastInboundAt: ago(60 * 25), inactivity, lastOutAt: ago(21), lastOutText: "Resposta" })).toBe("none");
  });
});

describe("reconhecimento de assunto", () => {
  it("réguas da config ou padrão", () => {
    expect(themeThresholds(cfg())).toEqual({ minSimilarity: 0.4, switchSimilarity: 0.5, switchMargin: 0.05, shortMessageWords: 2 });
    expect(themeThresholds(cfg({ themeRecognition: { minSimilarity: 0.55, switchMargin: 0.1, shortMessageWords: 3 } }))).toMatchObject({
      minSimilarity: 0.55,
      switchMargin: 0.1,
      shortMessageWords: 3,
    });
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
    for (const m of ["Preciso de ajuda", "não consegui acessar", "quero trocar meu curso", "sim"]) {
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
    expect(postCloseShortReply(own, "courtesy")).toBe("Geral");
    expect(postCloseShortReply(own, "new_demand")).toBe("Vou te passar para a equipe.");
    expect(postCloseHandoffMessage(own, "new_demand")).toBe("Vou te passar para a equipe.");
    expect(postCloseHandoffMessage(own, "ambiguous")).toBe("Transferindo.");
    expect(postCloseShortReply(cfg(), "courtesy")).toContain("Por nada");
  });
});
