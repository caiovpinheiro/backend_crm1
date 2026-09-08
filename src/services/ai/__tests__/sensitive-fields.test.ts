import { describe, expect, it } from "vitest";

import { enrollmentContextForModel } from "@/services/ai/sensitive-fields";

const transferMessage = "Vou te transferir para um consultor.";

describe("enrollmentContextForModel", () => {
  it("sintoma original: matrícula cancelada não vira 'seu curso está cancelado'", () => {
    const out = enrollmentContextForModel({
      situacoes: ["CANCELADO"],
      transferMessage,
    });

    // O motivo real fica retido: o modelo só sabe que não dá acesso.
    expect(out.podeAcessarPortal).toBe(false);
    expect(out.orientacao).toBe("encaminhar_secretaria");

    const serialized = JSON.stringify(out).toLowerCase();
    expect(serialized).not.toContain("cancelado");
    expect(serialized).not.toContain("situacao");
  });

  it("nenhum campo sensível é serializado para o modelo", () => {
    const out = enrollmentContextForModel({
      situacoes: ["EM CURSO"],
      transferMessage,
    });
    const keys = Object.keys(out);
    for (const forbidden of [
      "nome",
      "curso",
      "polo",
      "serie",
      "ciclo",
      "situacao",
      "instituicao",
      "tipoMatricula",
      "dataMatricula",
      "matriculas",
      "cpf",
      "rgm",
      "senha",
      "financeiro",
      "nota",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("não há mais instrução em caixa alta no payload", () => {
    for (const situacoes of [[], ["EM CURSO"], ["TRANCADO"]]) {
      const out = enrollmentContextForModel({ situacoes, transferMessage });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("NÃO DIVULGUE");
      expect(serialized).not.toContain("USO INTERNO");
      expect(serialized).not.toContain("NUNCA");
    }
  });

  it("aluno ativo é atendido normalmente", () => {
    for (const s of ["EM CURSO", "ATIVO", "CURSANDO"]) {
      const out = enrollmentContextForModel({
        situacoes: [s],
        transferMessage,
      });
      expect(out.found).toBe(true);
      expect(out.podeAcessarPortal).toBe(true);
      expect(out.orientacao).toBe("atender_normalmente");
    }
  });

  it("sem registro não bloqueia o atendimento", () => {
    const out = enrollmentContextForModel({ situacoes: [], transferMessage });
    expect(out.found).toBe(false);
    expect(out.orientacao).toBe("atender_normalmente");
  });

  it("basta uma matrícula ativa entre várias para liberar o portal", () => {
    const out = enrollmentContextForModel({
      situacoes: ["CANCELADO", "EM CURSO"],
      transferMessage,
    });
    expect(out.podeAcessarPortal).toBe(true);
  });

  it("a mensagem de transferência configurada continua chegando ao modelo", () => {
    const out = enrollmentContextForModel({
      situacoes: ["TRANCADO"],
      transferMessage: "copy customizada da org",
    });
    expect(out.transferMessage).toBe("copy customizada da org");
  });
});
