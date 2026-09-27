import { describe, expect, it } from "vitest";

import { notAFactClaim } from "../claim-check";
import { unsupportedFacts } from "../ground-reply";

describe("checagem — marcações que não são afirmação de fato", () => {
  it("admitir que não sabe, avisar transferência e repetir o cliente não barram a resposta", () => {
    expect(notAFactClaim("Eu não consigo confirmar se a aula será no polo de São Miguel")).toBe(true);
    expect(notAFactClaim("Sobre aulas ao vivo, não tenho essa informação para confirmar")).toBe(true);
    expect(notAFactClaim("O valor da avaliação não está informado para mim.")).toBe(true);
    expect(notAFactClaim("vou encaminhar seu atendimento ao setor responsável por retenção para dar continuidade à solicitação")).toBe(true);
    expect(notAFactClaim("Você enviou um comprovante de *40 horas* ontem e o sistema recusou o de *60 horas*")).toBe(true);
  });

  it("afirmação de fato continua sendo conferida", () => {
    expect(notAFactClaim("Sim, você pode acompanhar as aulas pelo notebook.")).toBe(false);
    expect(notAFactClaim("boleto vence no dia seguinte à solicitação")).toBe(false);
    expect(notAFactClaim("A instalação é gratuita")).toBe(false);
  });

  it("prazo escrito abreviado pelo cliente vale por extenso", () => {
    expect(unsupportedFacts("Para completar as 120 horas, envie outro comprovante.", ["preciso completar 120h"])).toEqual([]);
    expect(unsupportedFacts("O limite é de 40 horas.", ["não de 40h"])).toEqual([]);
    expect(unsupportedFacts("O limite é de 50 horas.", ["não de 40h"])).toEqual(["50 horas"]);
  });
});
