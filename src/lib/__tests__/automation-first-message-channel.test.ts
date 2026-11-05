/**
 * Validação do canal do 1º passo de mensagem ao salvar/ativar automação.
 * Regressão (RB - INICIO LICENCIADO, 05/11): "Selecionar tudo" (ou 2+
 * canais) no picker grava `channelScope`/`channelIds` e limpa `channelId`;
 * a validação só olhava `channelId` e recusava o salvamento.
 */
import { describe, expect, it } from "vitest";

import { validateFirstMessageChannel } from "@/lib/automation-workflow";

const msg = (config: Record<string, unknown>) => [
  { type: "move_stage", config: {} },
  { type: "send_whatsapp_message", config },
];
const opts = { triggerType: "deal_created", triggerConfig: {} };

describe("validateFirstMessageChannel (org com 2+ canais)", () => {
  it("aceita um canal escolhido (channelId)", () => {
    expect(validateFirstMessageChannel(msg({ channelId: "c1", channelScope: "selected", channelIds: ["c1"] }), 2, opts)).toBeNull();
  });

  it("aceita 'Selecionar tudo' marcado no picker", () => {
    expect(validateFirstMessageChannel(msg({ channelId: "", channelScope: "all", channelIds: [] }), 2, opts)).toBeNull();
  });

  it("aceita 2+ canais escolhidos", () => {
    expect(
      validateFirstMessageChannel(msg({ channelId: "", channelScope: "selected", channelIds: ["c1", "c2"] }), 2, opts),
    ).toBeNull();
  });

  it("continua recusando passo sem nenhuma escolha de canal", () => {
    expect(validateFirstMessageChannel(msg({}), 2, opts)).toBe("MISSING_CHANNEL_ON_FIRST_MESSAGE_STEP");
    expect(validateFirstMessageChannel(msg({ channelId: "", channelScope: "selected", channelIds: [] }), 2, opts)).toBe(
      "MISSING_CHANNEL_ON_FIRST_MESSAGE_STEP",
    );
  });

  it("org com 1 canal ou gatilho de entrada: não exige nada (como antes)", () => {
    expect(validateFirstMessageChannel(msg({}), 1, opts)).toBeNull();
    expect(validateFirstMessageChannel(msg({}), 2, { triggerType: "message_received" })).toBeNull();
  });
});
