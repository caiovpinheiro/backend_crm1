import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { RESEND_WINDOW_MS, announcesSending, appliedRuleIdsFromRows, pickPromisedModelId, resendWindowStart, sentMessageModelIds } from "@/services/ai-v2/sent-materials";

describe("materiais já enviados", () => {
  it("só conta mensagem pronta enviada com sucesso", () => {
    const ids = sentMessageModelIds([
      { executedActions: [{ action: { type: "send_message_model", modelId: "a" }, ok: true }] },
      { executedActions: [{ action: { type: "send_message_model", modelId: "b" }, ok: false }] },
      { executedActions: [{ action: { type: "add_tag", modelId: "c" }, ok: true }] },
      { executedActions: null },
    ]);
    expect([...ids]).toEqual(["a"]);
  });

  it("janela: 30 min, ou desde o último #reset se for mais recente", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(resendWindowStart(now, null).getTime()).toBe(now - RESEND_WINDOW_MS);
    const reset = new Date(now - 5 * 60 * 1000);
    expect(resendWindowStart(now, reset).getTime()).toBe(reset.getTime());
    expect(resendWindowStart(now, new Date(now - 2 * 60 * 60 * 1000)).getTime()).toBe(now - RESEND_WINDOW_MS);
  });
});

describe("promessa de envio → mensagem pronta do assunto", () => {
  it("só promessa em primeira pessoa anuncia envio; ordem ao cliente, 'abaixo de' e tela 'Enviando…' não", () => {
    for (const t of ["Vou te enviar o passo a passo visual.", "Segue abaixo o tutorial.", "Estou te mandando o vídeo agora.", "Te envio aqui o modelo."]) {
      expect(announcesSending(t), t).toBe(true);
    }
    for (const t of [
      "Envie um arquivo por vez, sempre em PDF e com até 1 MB.",
      "Confira se o comprovante está abaixo de 1 MB.",
      "Se a tela continuar em “Enviando comprovante…”, tente anexar um arquivo menor.",
      "Preciso encaminhar o caso ao time.",
    ]) {
      expect(announcesSending(t), t).toBe(false);
    }
  });

  it("uma palavra em comum não escolhe mensagem pronta; nome que casa escolhe; empate não chuta", () => {
    const models = [
      { id: "aval", name: "Avaliação do atendimento", content: "Você poderia avaliar meu atendimento? É rápido e não precisa de cadastro." },
      { id: "popup", name: "Bloquear pop-ups", content: "O navegador pode estar bloqueando pop-ups. Siga as orientações para permitir." },
      { id: "horas", name: "Horas complementares", content: "As atividades complementares são obrigatórias. Confira na sua área, em consulta de comprovantes." },
    ];
    const reply = "Vou te enviar a orientação. Se não concluir, preciso encaminhar o caso ao atendimento.";
    expect(pickPromisedModelId(reply, "não estou conseguindo anexar o comprovante", models)).toBeNull();
    expect(pickPromisedModelId("Vou te enviar o passo a passo das horas complementares.", "como envio meus comprovantes de horas complementares?", models)).toBe("horas");
    const twins = [
      { id: "a", name: "Tutorial de acesso", content: "Como acessar a plataforma." },
      { id: "b", name: "Tutorial de acesso (vídeo)", content: "Como acessar a plataforma em vídeo." },
    ];
    expect(pickPromisedModelId("Vou te enviar o tutorial de acesso.", "não consigo acessar", twins)).toBeNull();
  });
});

describe("atalhos que já responderam na conversa", () => {
  it("conta só o atalho cuja resposta fixa saiu de fato", () => {
    const out = appliedRuleIdsFromRows([
      { ruleId: "r1", executedActions: [{ action: { type: "send_message", message: "x" }, ok: true }] },
      { ruleId: "r2", executedActions: [{ action: { type: "send_message" }, ok: false, error: "vazia" }] },
      { ruleId: "r3", executedActions: [{ action: { type: "add_tag" }, ok: true }] },
      { ruleId: null, executedActions: [{ action: { type: "send_message" }, ok: true }] },
      { ruleId: "r4", executedActions: [{ action: { type: "send_message_model", modelId: "m" }, ok: true }] },
    ]);
    expect([...out].sort()).toEqual(["r1", "r4"]);
  });
});
