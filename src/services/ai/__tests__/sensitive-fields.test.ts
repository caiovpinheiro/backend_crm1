import { describe, expect, it } from "vitest";

import {
  academicLookupForModel,
  enrollmentContextForModel,
} from "@/services/ai/sensitive-fields";
import type { AcademicRecordLike } from "@/services/ai/academic-record-policy";

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

const ana: AcademicRecordLike = {
  cpf: "11122233344",
  nome: "ANA MARIA SOUZA",
  curso: "Pedagogia",
  polo: "Guarulhos",
  serie: "3",
  situacao: "EM CURSO",
  rgm: "202312345",
};

const anaSegundoCurso: AcademicRecordLike = {
  ...ana,
  curso: "Letras",
  serie: "1",
  rgm: "202398765",
};

/** Mesmo telefone, outra pessoa — o caso do celular da mãe. */
const bruno: AcademicRecordLike = {
  cpf: "99988877766",
  nome: "BRUNO SOUZA",
  curso: "Direito",
  polo: "Osasco",
  situacao: "EM CURSO",
  rgm: "202355555",
};

describe("academicLookupForModel — allowlist do operador", () => {
  it("sem campo liberado o payload é o de hoje: nada além do bit de acesso", () => {
    const out = academicLookupForModel({
      records: [ana],
      readableFields: [],
      transferMessage,
    });
    expect(out.podeAcessarPortal).toBe(true);
    expect(out.matriculas).toBeUndefined();
    const serialized = JSON.stringify(out).toLowerCase();
    expect(serialized).not.toContain("pedagogia");
    expect(serialized).not.toContain("guarulhos");
  });

  it("campo liberado chega ao modelo; o resto vira só rótulo", () => {
    const out = academicLookupForModel({
      records: [ana],
      readableFields: ["polo", "curso"],
      transferMessage,
    });
    const valores = out.matriculas?.[0]?.campos.map((c) => c.valor) ?? [];
    expect(valores).toContain("Guarulhos");
    expect(valores).toContain("Pedagogia");

    // Situação e RGM não foram liberados: existem, mas só como rótulo.
    expect(out.camposOcultos).toContain("Situação da matrícula");
    expect(JSON.stringify(out)).not.toContain("202312345");
    expect(JSON.stringify(out)).not.toContain("EM CURSO");
  });

  it("CPF e data de nascimento não saem nem com o curinga global", () => {
    const out = academicLookupForModel({
      records: [{ ...ana, dataNascimento: new Date("1990-05-02") } as AcademicRecordLike],
      readableFields: ["*"],
      transferMessage,
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("11122233344");
    expect(serialized).not.toContain("1990");
  });
});

describe("academicLookupForModel — identidade", () => {
  it("mesma pessoa com dois cursos: manda perguntar de qual curso é", () => {
    const out = academicLookupForModel({
      records: [ana, anaSegundoCurso],
      readableFields: ["curso"],
      transferMessage,
    });
    expect(out.identidade).toBe("varias_matriculas");
    expect(out.matriculas).toHaveLength(2);
    expect(out.hint).toContain("2 matrículas");
  });

  it("pessoas diferentes no mesmo contato: nenhum dado sai", () => {
    const out = academicLookupForModel({
      records: [ana, bruno],
      readableFields: ["*"],
      transferMessage,
    });
    expect(out.identidade).toBe("confirmar_identidade");
    expect(out.matriculas).toBeUndefined();
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("Pedagogia");
    expect(serialized).not.toContain("Direito");
  });

  it("não pede CPF para desempatar — pede o nome completo", () => {
    const out = academicLookupForModel({
      records: [ana, bruno],
      readableFields: ["curso"],
      transferMessage,
    });
    expect(out.hint).toContain("NOME COMPLETO");
    expect(out.hint).toContain("PROIBIDO pedir CPF");
  });

  it("nome confirmado desempata e libera só os dados daquela pessoa", () => {
    const out = academicLookupForModel({
      records: [ana, bruno],
      readableFields: ["curso", "polo"],
      transferMessage,
      nomeCompleto: "ana maria souza",
    });
    expect(out.identidade).toBeUndefined();
    const serialized = JSON.stringify(out);
    expect(serialized).toContain("Pedagogia");
    expect(serialized).not.toContain("Direito");
    expect(serialized).not.toContain("Osasco");
  });

  it("nome que não casa com ninguém não libera o registro do outro", () => {
    const out = academicLookupForModel({
      records: [ana, bruno],
      readableFields: ["*"],
      transferMessage,
      nomeCompleto: "carlos pereira",
    });
    expect(out.found).toBe(false);
    expect(out.matriculas).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("Pedagogia");
  });
});
