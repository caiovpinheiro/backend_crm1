/**
 * Bloco Condição: "Canal = WhatsApp" com número escolhido (Channel.id).
 */
import { describe, expect, it } from "vitest";

import {
  evaluateChannelNumberRule,
  normalizeConditionConfig,
} from "@/lib/automation-condition";

describe("normalizeConditionConfig — número do canal", () => {
  it("guarda channelId e channelLabel só na regra de canal", () => {
    const cfg = normalizeConditionConfig({
      branches: [
        {
          rules: [
            {
              field: "conversation.channel",
              op: "eq",
              value: "whatsapp",
              channelId: "ch-2",
              channelLabel: "Comercial 2",
            },
            { field: "contact.name", op: "eq", value: "x", channelId: "ch-2" },
          ],
        },
      ],
    });
    expect(cfg.branches[0]!.rules[0]).toEqual({
      field: "conversation.channel",
      op: "eq",
      value: "whatsapp",
      channelId: "ch-2",
      channelLabel: "Comercial 2",
    });
    expect(cfg.branches[0]!.rules[1]).not.toHaveProperty("channelId");
  });
});

describe("evaluateChannelNumberRule", () => {
  const rule = { field: "conversation.channel", op: "eq" as const, channelId: "ch-2" };

  it("igual a: tipo e número da conversa precisam bater", () => {
    expect(evaluateChannelNumberRule(rule, true, "ch-2")).toBe(true);
    expect(evaluateChannelNumberRule(rule, true, "ch-1")).toBe(false);
    expect(evaluateChannelNumberRule(rule, false, "ch-2")).toBe(false);
    expect(evaluateChannelNumberRule(rule, true, null)).toBe(false);
  });

  it("diferente de: qualquer conversa fora daquele número", () => {
    const ne = { ...rule, op: "ne" as const };
    expect(evaluateChannelNumberRule(ne, true, "ch-2")).toBe(false);
    expect(evaluateChannelNumberRule(ne, true, "ch-1")).toBe(true);
    expect(evaluateChannelNumberRule(ne, false, "ch-2")).toBe(true);
  });

  it("sem número (qualquer) ou outro campo: segue a comparação normal", () => {
    expect(evaluateChannelNumberRule({ ...rule, channelId: undefined }, true, "ch-1")).toBeNull();
    expect(evaluateChannelNumberRule({ ...rule, field: "contact.name" }, true, "ch-2")).toBeNull();
    expect(evaluateChannelNumberRule({ ...rule, op: "includes" as never }, true, "ch-1")).toBeNull();
  });
});
