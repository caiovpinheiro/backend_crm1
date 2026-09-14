/**
 * Testes do matcher `stage_changed` do motor de automações.
 *
 * `evaluateTrigger` é função pura (sem prisma/contexto), então testamos o
 * casamento config × payload direto. Cobre a correção do alias `stageId`
 * como `toStageId` — telas de funil/pipeline salvam a etapa-alvo em
 * `stageId`, e antes disso o gatilho "quando entra na fase X" não casava.
 */
import { describe, expect, it } from "vitest";

import { evaluateTrigger } from "@/services/automations";

function ctx(data: Record<string, unknown>) {
  return { event: "stage_changed", data } as const;
}

describe("evaluateTrigger — stage_changed", () => {
  it("sem config: qualquer mudança de fase dispara", () => {
    expect(
      evaluateTrigger("stage_changed", {}, ctx({ fromStageId: "a", toStageId: "b" })),
    ).toBe(true);
  });

  it("toStageId no config casa com toStageId do payload", () => {
    expect(
      evaluateTrigger("stage_changed", { toStageId: "b" }, ctx({ fromStageId: "a", toStageId: "b" })),
    ).toBe(true);
  });

  it("toStageId no config diverge → não dispara", () => {
    expect(
      evaluateTrigger("stage_changed", { toStageId: "z" }, ctx({ fromStageId: "a", toStageId: "b" })),
    ).toBe(false);
  });

  it("alias stageId (config) é tratado como toStageId", () => {
    expect(
      evaluateTrigger("stage_changed", { stageId: "b" }, ctx({ fromStageId: "a", toStageId: "b" })),
    ).toBe(true);
    expect(
      evaluateTrigger("stage_changed", { stageId: "z" }, ctx({ fromStageId: "a", toStageId: "b" })),
    ).toBe(false);
  });

  it("alias stageId no payload casa com toStageId do config", () => {
    expect(
      evaluateTrigger("stage_changed", { toStageId: "b" }, ctx({ stageId: "b" })),
    ).toBe(true);
  });

  it("fromStageId no config filtra pela origem", () => {
    expect(
      evaluateTrigger("stage_changed", { fromStageId: "a" }, ctx({ fromStageId: "a", toStageId: "b" })),
    ).toBe(true);
    expect(
      evaluateTrigger("stage_changed", { fromStageId: "x" }, ctx({ fromStageId: "a", toStageId: "b" })),
    ).toBe(false);
  });

  it("from + to combinados: ambos precisam casar", () => {
    const cfg = { fromStageId: "a", toStageId: "b" };
    expect(evaluateTrigger("stage_changed", cfg, ctx({ fromStageId: "a", toStageId: "b" }))).toBe(true);
    expect(evaluateTrigger("stage_changed", cfg, ctx({ fromStageId: "a", toStageId: "c" }))).toBe(false);
    expect(evaluateTrigger("stage_changed", cfg, ctx({ fromStageId: "x", toStageId: "b" }))).toBe(false);
  });
});

describe("evaluateTrigger — message_received channelId", () => {
  function msg(data: Record<string, unknown>) {
    return { event: "message_received" as const, data };
  }

  it("sem filtro: qualquer conexão dispara", () => {
    expect(
      evaluateTrigger("message_received", {}, msg({ channelId: "ch-a" })),
    ).toBe(true);
  });

  it("channelId único casa só com aquela conexão", () => {
    expect(
      evaluateTrigger("message_received", { channelId: "ch-a" }, msg({ channelId: "ch-a" })),
    ).toBe(true);
    expect(
      evaluateTrigger("message_received", { channelId: "ch-a" }, msg({ channelId: "ch-b" })),
    ).toBe(false);
  });

  it("channelIds: dispara se o payload está na lista", () => {
    const cfg = { channelIds: ["ch-a", "ch-c"] };
    expect(evaluateTrigger("message_received", cfg, msg({ channelId: "ch-a" }))).toBe(true);
    expect(evaluateTrigger("message_received", cfg, msg({ channelId: "ch-b" }))).toBe(false);
  });

  it("com channelIds ignora o tipo legado (whatsapp vs WhatsApp)", () => {
    const cfg = { channel: "email", channelIds: ["ch-a"] };
    expect(evaluateTrigger("message_received", cfg, msg({ channel: "WhatsApp", channelId: "ch-a" }))).toBe(true);
  });

  it("message_sent filtra pela mesma conexão", () => {
    expect(
      evaluateTrigger("message_sent", { channelIds: ["ch-a"] }, {
        event: "message_sent",
        data: { channelId: "ch-a" },
      }),
    ).toBe(true);
    expect(
      evaluateTrigger("message_sent", { channelIds: ["ch-a"] }, {
        event: "message_sent",
        data: { channelId: "ch-b" },
      }),
    ).toBe(false);
  });

  it("filtro de conexão sem channelId no payload não dispara", () => {
    expect(
      evaluateTrigger("message_received", { channelId: "ch-a" }, msg({ channel: "WhatsApp" })),
    ).toBe(false);
  });
});

describe("evaluateTrigger — conversation_created skipIfAckOrGreeting", () => {
  function created(data: Record<string, unknown>) {
    return { event: "conversation_created" as const, data };
  }

  it("default (off) dispara mesmo com ack", () => {
    expect(
      evaluateTrigger(
        "conversation_created",
        { channelScope: "all" },
        created({ channel: "whatsapp", content: "ok" }),
      ),
    ).toBe(true);
  });

  it("opt-in pula ack/cumprimento", () => {
    const cfg = { channelScope: "all", skipIfAckOrGreeting: true };
    expect(
      evaluateTrigger(
        "conversation_created",
        cfg,
        created({ channel: "whatsapp", content: "Está tudo certo" }),
      ),
    ).toBe(false);
    expect(
      evaluateTrigger(
        "conversation_created",
        cfg,
        created({ channel: "whatsapp", isAckOrGreeting: true }),
      ),
    ).toBe(false);
    expect(
      evaluateTrigger(
        "conversation_created",
        cfg,
        created({ channel: "whatsapp", content: "como recupero a senha?" }),
      ),
    ).toBe(true);
  });
});

describe("evaluateTrigger — conversation_created skipIfNoInbound", () => {
  function created(data: Record<string, unknown>) {
    return { event: "conversation_created" as const, data };
  }

  it("default (off) dispara em ticket aberto só para template", () => {
    expect(
      evaluateTrigger(
        "conversation_created",
        { channelScope: "all" },
        created({ channel: "whatsapp", source: "auto_ensure" }),
      ),
    ).toBe(true);
  });

  it("opt-in ignora ensure/outbound e exige inbound", () => {
    const cfg = { channelScope: "all", skipIfNoInbound: true };
    expect(
      evaluateTrigger(
        "conversation_created",
        cfg,
        created({ channel: "whatsapp", source: "auto_ensure" }),
      ),
    ).toBe(false);
    expect(
      evaluateTrigger(
        "conversation_created",
        cfg,
        created({ channel: "whatsapp", openedWithoutMessage: true, content: "oi" }),
      ),
    ).toBe(false);
    expect(
      evaluateTrigger(
        "conversation_created",
        cfg,
        created({ channel: "whatsapp", content: "preciso de ajuda" }),
      ),
    ).toBe(true);
  });
});
