import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { toWhatsAppText } from "../actions";

describe("toWhatsAppText", () => {
  it("link markdown vira 'texto: url' (WhatsApp não tem link com texto)", () => {
    expect(toWhatsAppText("Acesse [aqui](https://exemplo.com/portal) e siga.")).toBe(
      "Acesse aqui: https://exemplo.com/portal e siga.",
    );
  });

  it("link cujo texto já é a url fica só a url", () => {
    expect(toWhatsAppText("[https://exemplo.com](https://exemplo.com)")).toBe("https://exemplo.com");
  });

  it("negrito/itálico/títulos no padrão do WhatsApp", () => {
    expect(toWhatsAppText("### Passos\n**Atenção**: faça __agora__")).toBe("Passos\n*Atenção*: faça _agora_");
  });

  it("texto comum passa intacto", () => {
    expect(toWhatsAppText("Olá! Tudo bem? *já* está em negrito.")).toBe("Olá! Tudo bem? *já* está em negrito.");
  });
});
