import { describe, expect, it } from "vitest";

import { claimFoundInSources } from "../claim-check";
import { QUEUE_NOTICES, pickQueueNotice, queueNoticeKind } from "../queue-notice";

const CONFIGURED = "Você já está na fila de atendimento. Em instantes alguém da equipe continua com você por aqui.";
const now = new Date("2026-09-27T00:30:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe("aviso de fila", () => {
  it("entende o que o cliente escreveu", () => {
    expect(queueNoticeKind("Pode cancelar, um lixo esse atendimento")).toBe("cancel");
    expect(queueNoticeKind("Jogando de um lado pro outro, ninguém resolve nada")).toBe("upset");
    expect(queueNoticeKind("???")).toBe("call");
    expect(queueNoticeKind("Alo?\nAlguém?")).toBe("call");
    expect(queueNoticeKind("Qual meu código de cliente?")).toBe("again");
  });

  it("primeiro aviso é o configurado; depois acompanha o cliente e nunca repete o último", () => {
    expect(pickQueueNotice({ message: "Qual meu código de cliente?", configured: CONFIGURED, lastReply: "Vou transferir você.", lastReplyAt: ago(30), now })).toEqual({ text: CONFIGURED, kind: "first" });
    const cancel = pickQueueNotice({ message: "Pode cancelar", configured: CONFIGURED, lastReply: CONFIGURED, lastReplyAt: ago(26), now });
    expect(cancel?.kind).toBe("cancel");
    const upset = pickQueueNotice({ message: "ninguém resolve nada", configured: CONFIGURED, lastReply: cancel!.text, lastReplyAt: ago(15), now });
    expect(upset?.text).toBe(QUEUE_NOTICES.upset[0]);
    const again = pickQueueNotice({ message: "Alguém?", configured: CONFIGURED, lastReply: QUEUE_NOTICES.call[0], lastReplyAt: ago(40), now });
    expect(again?.text).toBe(QUEUE_NOTICES.call[1]);
  });

  it("mensagens neutras em poucos segundos: o aviso anterior vale", () => {
    expect(pickQueueNotice({ message: "e a fatura", configured: CONFIGURED, lastReply: CONFIGURED, lastReplyAt: ago(5), now })).toBeNull();
    expect(pickQueueNotice({ message: "e a fatura", configured: CONFIGURED, lastReply: CONFIGURED, lastReplyAt: ago(60), now })?.kind).toBe("again");
  });
});

describe("marcação do checador que está nas fontes", () => {
  const sources = ["Primeiro acesso: acesse https://portal.exemplo.com/ com o seu e-mail de cadastro e a senha enviada na compra."];
  it("link e palavras no mesmo trecho: descarta a marcação", () => {
    expect(claimFoundInSources("entre em https://portal.exemplo.com/ e use seu e-mail de cadastro e sua senha", sources)).toBe(true);
  });
  it("link diferente ou palavras espalhadas: mantém", () => {
    expect(claimFoundInSources("entre em https://outro.exemplo.com/ e use seu e-mail de cadastro", sources)).toBe(false);
    const far = ["A instalação do equipamento é paga. Temos várias opções de plano para escolher com calma. Consulte a tabela completa no site. O frete é gratuito."];
    expect(claimFoundInSources("a instalação do equipamento é gratuita", far)).toBe(false);
    expect(claimFoundInSources("a instalação do equipamento é paga", far)).toBe(true);
  });
});

describe("cortesia logo depois do aviso", () => {
  it("“obrigada” até 15 min depois do aviso não ganha outro aviso; depois disso, ou sem ser cortesia, ganha", async () => {
    const { pickQueueNotice } = await import("../queue-notice");
    const now = new Date("2026-10-12T17:00:00Z");
    const base = { configured: "Você já está na fila de atendimento.", lastReply: "Vou te passar para a equipe.", now };
    expect(pickQueueNotice({ ...base, message: "Obrigada", courtesy: true, lastReplyAt: new Date("2026-10-12T16:59:00Z") })).toBeNull();
    expect(pickQueueNotice({ ...base, message: "Obrigada", courtesy: true, lastReplyAt: new Date("2026-10-12T16:30:00Z") })).not.toBeNull();
    expect(pickQueueNotice({ ...base, message: "e o prazo?", courtesy: false, lastReplyAt: new Date("2026-10-12T16:59:00Z") })).not.toBeNull();
    const { isShortAckText } = await import("@/lib/ai-agents/tabulation-classify-policy");
    for (const m of ["Obrigada", "Tabom", "ta bom", "ok 👍", "Ta bom muito obrigada"]) expect(isShortAckText(m)).toBe(true);
    expect(isShortAckText("tá, mas e o prazo?")).toBe(false);
  });
});

describe("aviso anterior com o horário colado", () => {
  it("cliente insatisfeito logo depois do aviso (com horário no fim) recebe a variante de insatisfeito, não o primeiro de novo", async () => {
    const { pickQueueNotice } = await import("../queue-notice");
    const configured = "Você já está na fila de atendimento. Sua mensagem fica registrada e alguém da equipe continua com você por aqui no próximo horário de atendimento.";
    const lastReply = `${configured}\n\nNossa equipe atende segunda a sexta, 08:00 às 18:00. Sua mensagem fica registrada e seguimos com você na terça-feira, 13/10, às 08:00.`;
    const r = pickQueueNotice({ message: "vou reclamar no órgão de defesa do consumidor, que absurdo", configured, lastReply, lastReplyAt: new Date(Date.now() - 30_000), outsideHours: true });
    expect(r?.kind).toBe("upset");
    expect(r?.text).not.toBe(configured);
  });
});
