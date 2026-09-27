import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { guardV2Output, isCommonFieldValue } from "../output-guard";
import { QUEUED_MESSAGE_DEFAULT, QUEUED_MESSAGE_OUTSIDE_HOURS, QUEUE_NOTICES, pickQueueNotice, queuedMessageFor } from "../queue-notice";
import { mediaResendPlan, saysNotReceived } from "../sent-materials";
import { trimUnsupportedSentences } from "../reply-trim";

describe("guarda de saída — campo só-leitura com valor comum", () => {
  it("não mascara 'Sim'/'Não', número pequeno nem palavra curta", () => {
    expect(isCommonFieldValue("Sim")).toBe(true);
    expect(isCommonFieldValue("Não")).toBe(true);
    expect(isCommonFieldValue("12")).toBe(true);
    expect(isCommonFieldValue("Ativo")).toBe(true);
    expect(isCommonFieldValue("R$ 1.234,56")).toBe(false);
    expect(isCommonFieldValue("Plano Ouro Especial")).toBe(false);
    const ctx = { contact: null, citableContact: null, selectedDeal: { pendencia: "Sim", saldo: "R$ 1.234,56" }, citableDeal: null };
    const r = guardV2Output("Sim, Ana! Vou te enviar o tutorial em vídeo agora.", [], ctx);
    expect(r.text).toBe("Sim, Ana! Vou te enviar o tutorial em vídeo agora.");
    expect(r.scrubbedFields).toBeUndefined();
  });

  it("valor interno no começo da frase sai junto com a vírgula; no meio fica o marcador", () => {
    const ctx = { contact: null, citableContact: null, selectedDeal: { plano: "Plano Ouro Especial" }, citableDeal: null };
    expect(guardV2Output("Plano Ouro Especial, Ana! Vou te enviar o tutorial.", [], ctx).text).toBe("Ana! Vou te enviar o tutorial.");
    expect(guardV2Output("Você está no Plano Ouro Especial desde março.", [], ctx).text).toBe("Você está no [informação interna não compartilhada] desde março.");
  });
});

describe("aviso de fila fora do horário", () => {
  it("padrão fora do horário não promete 'em instantes'; o configurado vale sempre", () => {
    expect(queuedMessageFor(null, true)).toBe(QUEUED_MESSAGE_DEFAULT);
    expect(queuedMessageFor("", false)).toBe(QUEUED_MESSAGE_OUTSIDE_HOURS);
    expect(QUEUED_MESSAGE_OUTSIDE_HOURS).not.toMatch(/em instantes/i);
    expect(queuedMessageFor("Texto da empresa", false)).toBe("Texto da empresa");
  });

  it("variantes com 'em instantes' ficam de fora quando fora do horário", () => {
    const now = new Date("2026-09-27T00:30:00Z");
    const r = pickQueueNotice({
      message: "ninguém resolve nada",
      configured: QUEUED_MESSAGE_OUTSIDE_HOURS,
      lastReply: QUEUED_MESSAGE_OUTSIDE_HOURS,
      lastReplyAt: new Date(now.getTime() - 30_000),
      now,
      outsideHours: true,
    });
    expect(r?.kind).toBe("upset");
    expect(r?.text).toBe(QUEUE_NOTICES.upset[1]);
    expect(r?.text).not.toMatch(/em instantes/i);
  });
});

describe("cliente diz que não recebeu o anexo", () => {
  it("reconhece a reclamação", () => {
    expect(saysNotReceived("Não veio o vídeo")).toBe(true);
    expect(saysNotReceived("não recebi nada")).toBe(true);
    expect(saysNotReceived("cadê a imagem?")).toBe(true);
    expect(saysNotReceived("O vídeo não abriu aqui")).toBe(true);
    expect(saysNotReceived("recebi, obrigado")).toBe(false);
    expect(saysNotReceived("não entendi o passo 2")).toBe(false);
  });

  it("reenvia uma vez e diz a verdade quando o envio falhou; na segunda vez chama a equipe", () => {
    const at = new Date();
    expect(mediaResendPlan([])).toBeNull();
    const failedOnce = mediaResendPlan([{ status: "failed", error: "Arquivo não encontrado no storage", type: "video", at }]);
    expect(failedOnce).toMatchObject({ resend: true, handoff: false });
    expect(failedOnce!.reply).toMatch(/não saiu da primeira vez/);
    expect(failedOnce!.reply).not.toMatch(/logo acima/);
    const sentOnce = mediaResendPlan([{ status: "read", error: null, type: "image", at }]);
    expect(sentOnce).toMatchObject({ resend: true, handoff: false });
    expect(sentOnce!.reply).toMatch(/Reenviei a imagem/);
    const twice = mediaResendPlan([{ status: "failed", error: "x", type: "video", at }, { status: "failed", error: "x", type: "video", at }]);
    expect(twice).toMatchObject({ resend: false, handoff: true });
    expect(twice!.reply).toMatch(/Não estou conseguindo enviar o vídeo/);
  });
});

describe("corte — passos com emoji numérico", () => {
  it("não corta passo marcado com 1️⃣ nem com 'Passo 1:'", () => {
    const keycaps = "Para trocar:\n1️⃣ Vá até a loja com a nota fiscal.\n2️⃣ Peça o reembolso em dinheiro na hora.\n3️⃣ Guarde o comprovante.";
    expect(trimUnsupportedSentences(keycaps, ["Peça o reembolso em dinheiro na hora"])).toBeNull();
    const labeled = "Para trocar:\nPasso 1: Vá até a loja com a nota fiscal.\nPasso 2: Peça o reembolso em dinheiro na hora.\nPasso 3: Guarde o comprovante.";
    expect(trimUnsupportedSentences(labeled, ["Peça o reembolso em dinheiro na hora"])).toBeNull();
  });
});
