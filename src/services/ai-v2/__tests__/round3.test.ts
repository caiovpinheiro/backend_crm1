import { describe, expect, it } from "vitest";

import { answersBeforeHandoff, conditionalHandoff } from "../no-source";
import { introBeforeMaterial } from "../sent-materials";
import { businessHoursSummary, outsideHoursNote } from "../rules";

describe("transferência condicional", () => {
  it("toda frase que fala em transferir tem uma condição: espera o cliente", () => {
    expect(conditionalHandoff("Confira o desconto na fatura. Se o valor final continuar diferente do contratado após considerar o desconto válido, preciso encaminhar o caso à equipe para análise.")).toBe(true);
    expect(conditionalHandoff("Se o desconto não aparecer ou o valor continuar divergente, vou encaminhar o caso para a equipe verificar.")).toBe(true);
    expect(conditionalHandoff("Caso não apareça, te transfiro para a equipe.")).toBe(true);
  });
  it("transferência afirmada ou sem falar em transferir: não mexe", () => {
    expect(conditionalHandoff("Vou te encaminhar à equipe para conferir o seu caso.")).toBe(false);
    expect(conditionalHandoff("Vou te encaminhar à equipe. Se precisar de algo, estou aqui.")).toBe(false);
    expect(conditionalHandoff("Não tenho essa informação.")).toBe(false);
    expect(conditionalHandoff("O desconto se aplica até o vencimento; vou te encaminhar ao financeiro.")).toBe(false);
    expect(conditionalHandoff("Vou conferir e, se necessário, te encaminho para a equipe.")).toBe(true);
  });
});

describe("orientação antes da transferência", () => {
  it("regra dada + valor exato que não tem: a regra vale mandar", () => {
    expect(answersBeforeHandoff("A taxa de entrega é cobrada só no primeiro pedido, com desconto sobre o valor cheio. O valor exato da sua eu não tenho aqui, vou te encaminhar para a equipe.")).toBe(true);
    expect(answersBeforeHandoff("Não tenho essa informação aqui. Vou te encaminhar para a equipe, que consegue verificar.")).toBe(false);
  });
});

describe("resposta antes da mensagem pronta", () => {
  it("vira só a introdução", () => {
    const troca = "Entendi, Ana. Para trocar o produto, você precisa abrir o pedido na área do cliente, na aba Trocas. O caminho é:\n\n1. Acesse a área do cliente\n2. Clique em Trocas";
    expect(introBeforeMaterial(troca)).toBe("Entendi, Ana. Para trocar o produto, você precisa abrir o pedido na área do cliente, na aba Trocas.");
    const fatura = "Entendo, Ana. A fatura pode mostrar primeiro o valor integral, antes dos descontos comerciais. Para conferir, observe na própria fatura:\n\n💰 valor integral;\n🏷️ desconto";
    expect(introBeforeMaterial(fatura)).toBe("Entendo, Ana. A fatura pode mostrar primeiro o valor integral, antes dos descontos comerciais.");
    expect(introBeforeMaterial("1. Acesse\n2. Clique")).toBe("");
  });
});

describe("horário de atendimento", () => {
  const config = {
    businessHours: {
      enabled: true,
      timezone: "America/Sao_Paulo",
      weekdays: [
        ...[1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "18:00" })),
        { day: 6, start: "08:00", end: "12:00" },
      ],
    },
  } as never;

  it("resumo agrupa dias seguidos com o mesmo horário", () => {
    expect(businessHoursSummary(config)).toBe("segunda a sexta, 08:00 às 18:00; sábado, 08:00 às 12:00");
  });

  it("fora do horário, o aviso diz quando a equipe volta; dentro, nada", () => {
    const sunday = new Date("2026-09-27T10:05:00-03:00");
    const monday = new Date("2026-09-28T10:05:00-03:00");
    expect(outsideHoursNote(config, sunday)).toContain("segunda a sexta, 08:00 às 18:00");
    expect(outsideHoursNote(config, monday)).toBe("");
    expect(outsideHoursNote({ businessHours: { enabled: false, timezone: "America/Sao_Paulo", weekdays: [] } } as never, sunday)).toBe("");
  });
});
