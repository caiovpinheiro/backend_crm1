import { describe, expect, it } from "vitest";

import { applyReplyEnding, classifyReply, effectiveReplyEnding, hasReplyEnding } from "../reply-ending";

const ending = {
  procedure: { enabled: true, phrases: ["Faz esses passos e me avisa se funcionou.", "Conseguiu fazer?"] },
  info: { enabled: true, phrases: ["Ficou alguma dúvida?"] },
};
const steps = "Para acessar:\n1. Abra o app.\n2. Toque em Entrar.\n3. Digite o código.";

describe("fecho das respostas", () => {
  it("passo a passo × informação", () => {
    expect(classifyReply(steps)).toBe("procedure");
    expect(classifyReply("1️⃣ Abra o app\n2️⃣ Entre")).toBe("procedure");
    expect(classifyReply("As aulas começam em 01/10.")).toBe("info");
  });

  it("acrescenta a frase do tipo e alterna entre as frases", () => {
    expect(applyReplyEnding({ reply: steps, ending, turnSeed: 0 }).added).toBe("Faz esses passos e me avisa se funcionou.");
    expect(applyReplyEnding({ reply: steps, ending, turnSeed: 1 }).added).toBe("Conseguiu fazer?");
    const info = applyReplyEnding({ reply: "As aulas começam em 01/10.", ending });
    expect(info.text).toBe("As aulas começam em 01/10.\n\nFicou alguma dúvida?");
  });

  it("não soma pergunta a resposta que já pergunta, nem repete a da mensagem anterior", () => {
    expect(applyReplyEnding({ reply: "Qual o seu e-mail? 🙂", ending }).added).toBeNull();
    expect(applyReplyEnding({ reply: "As aulas começam em 01/10.", ending, lastAgentMessage: "Prazo é dia 5.\n\nFicou alguma dúvida?" }).added).toBeNull();
  });

  it("sem frases ou desligado, nada muda; assunto próprio vale sobre o agente", () => {
    expect(applyReplyEnding({ reply: steps, ending: { procedure: { enabled: false, phrases: ["x"] }, info: { enabled: false, phrases: [] } } }).added).toBeNull();
    const config = { replyEnding: ending } as never;
    const own = { replyEnding: { inherit: false, procedure: { enabled: false, phrases: [] }, info: { enabled: true, phrases: ["Posso ajudar em algo mais?"] } } } as never;
    expect(effectiveReplyEnding(config, own)?.info.phrases).toEqual(["Posso ajudar em algo mais?"]);
    expect(effectiveReplyEnding(config, { replyEnding: { inherit: true } } as never)).toBe(ending);
    expect(hasReplyEnding(undefined)).toBe(false);
    expect(hasReplyEnding(ending as never)).toBe(true);
  });
});
