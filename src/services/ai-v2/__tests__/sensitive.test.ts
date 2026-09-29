import { describe, expect, it } from "vitest";
import { isValidCpf, maskSensitive, maskSensitiveDeep, SensitiveVault, SECRET_REMOVED } from "../sensitive";

// CPFs/CNPJ gerados só para teste (dígitos verificadores válidos).
const CPF = "529.982.247-25";
const CPF_RAW = "52998224725";
const CNPJ = "11.222.333/0001-81";

describe("maskSensitive", () => {
  it("valida CPF pelo dígito verificador", () => {
    expect(isValidCpf(CPF)).toBe(true);
    expect(isValidCpf("529.982.247-26")).toBe(false);
  });

  it("mascara CPF formatado, CPF solto válido e CNPJ", () => {
    const r = maskSensitive(`meu cpf ${CPF}, da empresa ${CNPJ}, outro ${CPF_RAW}`);
    expect(r.text).not.toContain("982");
    expect(r.text).not.toContain("222.333");
    expect(r.kinds).toEqual(expect.arrayContaining(["cpf", "cnpj"]));
  });

  it("não mascara telefone nem número qualquer de 11 dígitos inválido como CPF", () => {
    const r = maskSensitive("me liga no 11987654321, protocolo 12345678901");
    expect(r.text).toContain("11987654321");
  });

  it("mascara CPF com rótulo mesmo inválido", () => {
    expect(maskSensitive("CPF: 111.222.333-44").text).not.toContain("333");
    expect(maskSensitive("cpf 11122233344").text).not.toContain("33344");
  });

  it("remove senha com separador ou com dígito/símbolo", () => {
    for (const t of [
      "Senha: Abc@1234",
      "senha: jul2401@",
      "Senha padrão - Fer@4193503",
      "Alteramos a sua senha para @123Mudar",
      "minha senha é Maria2020",
    ]) {
      const r = maskSensitive(t);
      expect(r.text, t).toContain(SECRET_REMOVED);
      expect(r.kinds, t).toContain("senha");
    }
  });

  it("não confunde frase sobre senha com senha", () => {
    for (const t of ["senha incorreta", "senha inválida", "a senha não funciona", "não consigo recuperar minha senha, ele não acha", "passo a passo", "esqueci a senha"]) {
      expect(maskSensitive(t).text, t).toBe(t);
    }
  });

  it("mascara e-mail e RG com rótulo", () => {
    const r = maskSensitive("email fulano.tal@exemplo.com.br RG: 52.209.058-8");
    expect(r.text).toContain("f***@exemplo.com.br");
    expect(r.text).not.toContain("209.058");
  });

  it("remove número de cartão", () => {
    expect(maskSensitive("cartão 4111 1111 1111 1111").text).toContain("[cartão removido]");
  });

  it("mascara em profundidade", () => {
    const r = maskSensitiveDeep({ a: [`x ${CPF}`], b: { c: "Senha: Xy@123" }, n: 3 });
    expect(JSON.stringify(r)).not.toContain("982.247");
    expect(JSON.stringify(r)).not.toContain("Xy@123");
    expect(r.n).toBe(3);
  });
});

describe("SensitiveVault", () => {
  it("troca por marcador, repete o mesmo marcador e restaura o valor", () => {
    const v = new SensitiveVault();
    const a = v.tokenize(`meu cpf é ${CPF}`);
    const b = v.tokenize(`de novo: ${CPF_RAW}`);
    expect(a).toContain("[CPF 1]");
    expect(b).toContain("[CPF 1]");
    expect(v.restore("buscar [CPF 1]")).toBe(`buscar ${CPF}`);
    expect(v.display("seu CPF [CPF 1]")).toBe("seu CPF ***25");
  });

  it("senha nunca é restaurável", () => {
    const v = new SensitiveVault();
    const t = v.tokenize("Senha: Abc@1234");
    expect(t).not.toContain("Abc@1234");
    expect(v.restore(t)).not.toContain("Abc@1234");
    expect(v.kinds.has("senha")).toBe(true);
  });

  it("restaura em profundidade (argumentos e variáveis)", () => {
    const v = new SensitiveVault();
    v.tokenize("e-mail ana@exemplo.com");
    expect(v.restoreDeep({ q: "[E-MAIL 1]", list: ["[E-MAIL 1]"] })).toEqual({ q: "ana@exemplo.com", list: ["ana@exemplo.com"] });
  });
});

describe("guarda de saída com dado sensível", () => {
  it("remove senha e mascara documento, mantém e-mail", async () => {
    const { guardV2Output } = await import("../output-guard");
    const r = guardV2Output(`Seu e-mail: cliente@exemplo.com Senha: Abc@1234. CPF ${CPF}`, []);
    expect(r.text).toContain("cliente@exemplo.com");
    expect(r.text).not.toContain("Abc@1234");
    expect(r.text).not.toContain("982.247");
    expect(r.warnings.join(" ")).toContain("sensível");
  });
});

describe("senha: frases que não são senha", () => {
  it("palavra seguida de dois-pontos e marcador já aplicado não viram senha", () => {
    expect(maskSensitive("Para redefinir sua senha do portal: acesse o portal").text).toBe("Para redefinir sua senha do portal: acesse o portal");
    const once = maskSensitive("Senha: Abc@1234").text;
    expect(maskSensitive(once).text).toBe(once);
    expect(once).not.toContain("removida] removida]");
  });
});
