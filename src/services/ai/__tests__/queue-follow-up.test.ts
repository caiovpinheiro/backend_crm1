import { describe, expect, it } from "vitest";

import {
  buildQueueAlreadyNoticedHint,
  buildQueueFollowUpMessage,
  isNearDuplicateBotText,
  messageLooksLikeHumanQueueNotice,
} from "@/services/ai/human-queue-policy";

const QUEUE_NOTICE =
  "Já te encaminhei para o setor de Retenção. Eles seguem com você por " +
  "aqui — pode levar um pouquinho, mas seu pedido já está com o setor, tá?";

describe("follow-up de fila", () => {
  it("não é lido como aviso de fila", () => {
    // Dois avisos de fila são near-duplicate por definição. Se o follow-up
    // entrar nesse vocabulário, a trava de eco o descarta e a correção
    // vira no-op: o cliente continua sem resposta.
    expect(messageLooksLikeHumanQueueNotice(buildQueueFollowUpMessage())).toBe(
      false,
    );
  });

  it("passa depois de um aviso de fila já enviado", () => {
    expect(
      isNearDuplicateBotText(buildQueueFollowUpMessage(), QUEUE_NOTICE),
    ).toBe(false);
  });

  it("é barrado contra ele mesmo — throttle de uma vez por janela", () => {
    const followUp = buildQueueFollowUpMessage();
    expect(isNearDuplicateBotText(followUp, followUp)).toBe(true);
  });

  it("respeita o texto do tenant", () => {
    expect(
      buildQueueFollowUpMessage({
        queueFollowUpMessage: "  Me conta o que você precisa.  ",
      }),
    ).toBe("Me conta o que você precisa.");
  });

  it("o hint de repetição proíbe reanunciar", () => {
    expect(buildQueueAlreadyNoticedHint()).toMatch(/NÃO repita/);
  });
});
