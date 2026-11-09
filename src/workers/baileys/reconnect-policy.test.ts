import { describe, expect, it } from "vitest";

import {
  backoffDelayMs,
  CONNECTION_REPLACED_DELAY_MS,
  decideReconnect,
  disconnectReasonName,
  RECONNECT_MAX_DELAY_MS,
} from "./reconnect-policy";

const mid = () => 0.5; // sem variação (fator 1.0)

describe("decideReconnect — quando a sessão Baileys cai", () => {
  it("queda comum reconecta para sempre, inclusive depois da 8ª tentativa", () => {
    for (const attempt of [1, 8, 9, 50, 500]) {
      const d = decideReconnect({ statusCode: 428, attempt, badSessionStreak: 0, random: mid });
      expect(d.action).toBe("retry");
    }
  });

  it("espera dobra e para em 5 minutos", () => {
    expect(backoffDelayMs(1, mid)).toBe(2_000);
    expect(backoffDelayMs(2, mid)).toBe(4_000);
    expect(backoffDelayMs(5, mid)).toBe(32_000);
    expect(backoffDelayMs(20, mid)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(backoffDelayMs(20, () => 0.999)).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
    expect(backoffDelayMs(1, () => 0)).toBe(1_500);
  });

  it("deslogado no celular (401) apaga a sessão", () => {
    expect(decideReconnect({ statusCode: 401, attempt: 1, badSessionStreak: 0 })).toEqual({
      action: "logout",
      reason: "loggedOut",
    });
  });

  it("aparelho incompatível (411) e proibido (403) pedem QR sem tentar de novo", () => {
    expect(decideReconnect({ statusCode: 411, attempt: 1, badSessionStreak: 0 }).action).toBe("needs_qr");
    expect(decideReconnect({ statusCode: 403, attempt: 1, badSessionStreak: 0 }).action).toBe("needs_qr");
  });

  it("badSession tenta de novo até a 3ª seguida, aí pede QR", () => {
    expect(decideReconnect({ statusCode: 500, attempt: 1, badSessionStreak: 1 }).action).toBe("retry");
    expect(decideReconnect({ statusCode: 500, attempt: 2, badSessionStreak: 2 }).action).toBe("retry");
    expect(decideReconnect({ statusCode: 500, attempt: 3, badSessionStreak: 3 }).action).toBe("needs_qr");
  });

  it("restartRequired (depois do QR) reconecta na hora", () => {
    expect(decideReconnect({ statusCode: 515, attempt: 1, badSessionStreak: 0 })).toEqual({
      action: "retry",
      delayMs: 0,
      reason: "restartRequired",
    });
  });

  it("conexão substituída espera pelo menos 15 s", () => {
    const d = decideReconnect({ statusCode: 440, attempt: 1, badSessionStreak: 0, random: mid });
    expect(d).toMatchObject({ action: "retry", reason: "connectionReplaced" });
    expect((d as { delayMs: number }).delayMs).toBe(CONNECTION_REPLACED_DELAY_MS);
  });

  it("sem código (erro de rede) reconecta", () => {
    expect(decideReconnect({ statusCode: undefined, attempt: 1, badSessionStreak: 0 })).toMatchObject({
      action: "retry",
      reason: "unknown",
    });
  });

  it("nome do motivo para o log", () => {
    expect(disconnectReasonName(440)).toBe("connectionReplaced");
    expect(disconnectReasonName(408)).toBe("connectionLost");
    expect(disconnectReasonName(999)).toBe("code_999");
  });
});
