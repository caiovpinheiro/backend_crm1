import { describe, expect, it } from "vitest";

import { v2AgentConfigSchema } from "@/lib/ai-v2/config";
import { SYSTEM_MESSAGE_DEFAULTS, systemMessage } from "@/lib/ai-v2/system-messages";
import { buildV2Interactive } from "../interactive";
import { guardV2Output } from "../output-guard";
import { QUEUE_NOTICES, pickQueueNotice, queuedMessageFor } from "../queue-notice";
import { outsideHoursNote } from "../rules";
import { mediaResendPlan } from "../sent-materials";

const at = new Date("2026-09-27T00:30:00Z");

describe("mensagens automáticas do motor — cada empresa escolhe o texto", () => {
  it("vazio usa o padrão; texto da empresa substitui e preenche {{anexo}}", () => {
    expect(systemMessage({}, "materialAlreadySent")).toBe(SYSTEM_MESSAGE_DEFAULTS.materialAlreadySent);
    expect(systemMessage({ systemMessages: { materialAlreadySent: "  " } }, "materialAlreadySent")).toBe(SYSTEM_MESSAGE_DEFAULTS.materialAlreadySent);
    expect(systemMessage({ systemMessages: { mediaResent: "Mandei {{anexo}} de novo." } }, "mediaResent", { anexo: "o vídeo" })).toBe("Mandei o vídeo de novo.");
  });

  it("a config aceita e guarda os textos", () => {
    const parsed = v2AgentConfigSchema.parse({ name: "A", tone: "cordial", systemMessages: { humanRequestAsk: "Sobre o que é?", queueCall: "Oi, sigo aqui." } });
    expect(parsed.systemMessages).toEqual({ humanRequestAsk: "Sobre o que é?", queueCall: "Oi, sigo aqui." });
  });

  it("reenvio de anexo usa o texto da empresa", () => {
    const plan = mediaResendPlan([{ status: "failed", error: null, type: "video", at }], { systemMessages: { mediaResentAfterFailure: "{{anexo}} falhou; mando de novo." } });
    expect(plan?.reply).toBe("o vídeo falhou; mando de novo.");
    expect(mediaResendPlan([{ status: "sent", error: null, type: "image", at }])?.reply).toContain("a imagem");
  });

  it("aviso de fila: variante da empresa por tipo; fora do horário, texto próprio", () => {
    const configured = "Você está na fila.";
    const call = pickQueueNotice({ message: "alguém?", configured, lastReply: configured, lastReplyAt: new Date(at.getTime() - 60_000), now: at, overrides: { call: "Oi! A equipe já vai te responder." } });
    expect(call).toEqual({ text: "Oi! A equipe já vai te responder.", kind: "call" });
    const standard = pickQueueNotice({ message: "alguém?", configured, lastReply: configured, lastReplyAt: new Date(at.getTime() - 60_000), now: at });
    expect(QUEUE_NOTICES.call).toContain(standard?.text);
    expect(queuedMessageFor("", false, "Fora do horário: respondemos amanhã.")).toBe("Fora do horário: respondemos amanhã.");
    expect(queuedMessageFor("Texto da empresa", false, "Fora do horário")).toBe("Texto da empresa");
  });

  it("nota fora do horário: texto da empresa com {{horario}}", () => {
    const config = {
      businessHours: {
        enabled: true,
        timezone: "America/Sao_Paulo",
        weekdays: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })),
        offHoursMessage: "Atendemos {{horario}}. Deixe sua mensagem.",
      },
    } as never;
    expect(outsideHoursNote(config, new Date("2026-09-27T10:05:00-03:00"))).toBe("Atendemos segunda a sexta, 09:00 às 17:00. Deixe sua mensagem.");
  });

  it("lista de opções usa o texto da empresa no botão e no corpo curto", () => {
    const labels = ["Primeira opção", "Segunda opção", "Terceira opção", "Quarta opção"];
    const built = buildV2Interactive("x".repeat(2000), labels, { prompt: "Selecione:", button: "Opções" });
    expect(built.payload?.listButton).toBe("Opções");
    expect(built.payload?.body).toBe("Selecione:");
  });

  it("promessa de retorno sem transferência vira o texto da empresa", () => {
    const out = guardV2Output("Vou verificar e volto com a resposta.", [], undefined, "Vou chamar alguém do time agora.");
    expect(out.forceHandoff).toBe(true);
    expect(out.text).toBe("Vou chamar alguém do time agora.");
  });
});
