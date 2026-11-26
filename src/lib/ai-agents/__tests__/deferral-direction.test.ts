import { describe, expect, it } from "vitest";
import { asksAgentToContactLater, isDeferralText } from "../tabulation-classify-policy";

describe("adiamento: quem vai chamar depois", () => {
  it("o cliente pede que o atendente chame → não é adiamento (não encerra)", () => {
    for (const t of [
      "Faz assim, me chama mais tarde",
      "me chama depois",
      "me chame amanhã",
      "me liga depois",
      "me manda depois",
      "pode me chamar à noite",
      "chama mais tarde",
    ]) {
      expect(asksAgentToContactLater(t), t).toBe(true);
      expect(isDeferralText(t), t).toBe(false);
    }
  });

  it("o cliente diz que ele vai chamar → continua adiamento (encerra)", () => {
    for (const t of [
      "eu te chamo depois",
      "te chamo depois",
      "Estou no trabalho, chamo depois",
      "eu falo com você depois",
      "quando eu puder te chamo",
      "depois eu vejo",
    ]) {
      expect(asksAgentToContactLater(t), t).toBe(false);
      expect(isDeferralText(t), t).toBe(true);
    }
  });
});
