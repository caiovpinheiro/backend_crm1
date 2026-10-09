import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { RESEND_WINDOW_MS, appliedRuleIdsFromRows, resendWindowStart, sentMessageModelIds } from "@/services/ai-v2/sent-materials";

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
