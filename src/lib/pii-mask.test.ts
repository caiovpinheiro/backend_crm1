/**
 * SEC2-5 — máscaras de telefone/e-mail para logs.
 */
import { describe, expect, it } from "vitest";

import { maskEmail, maskPhone } from "./pii-mask";

describe("maskPhone", () => {
  it("mantém só os 4 últimos dígitos", () => {
    expect(maskPhone("+55 (11) 91234-5678")).toBe("***5678");
    expect(maskPhone("5511912345678")).toBe("***5678");
  });
  it("tolera vazio/curto", () => {
    expect(maskPhone("")).toBe("***");
    expect(maskPhone(null)).toBe("");
    expect(maskPhone("12")).toBe("***12");
  });
});

describe("maskEmail", () => {
  it("mascara usuário e domínio, preserva TLD", () => {
    expect(maskEmail("joao.silva@exemplo.com.br")).toBe("jo***@e***.com.br");
    expect(maskEmail("a@b.io")).toBe("a***@b***.io");
  });
  it("sem @ mascara quase tudo", () => {
    expect(maskEmail("naoeemail")).toBe("na***");
    expect(maskEmail(undefined)).toBe("");
  });
});
