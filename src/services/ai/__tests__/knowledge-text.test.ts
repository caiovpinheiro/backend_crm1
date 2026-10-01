import { describe, expect, it } from "vitest";

import { unwrapMessagePayloadText } from "@/services/ai/knowledge-text";

describe("unwrapMessagePayloadText", () => {
  it("extrai o body do payload de modelo de mensagem com quebras reais", () => {
    const raw =
      '{"type":"text","body":"📄 Como emitir seu comprovante\\nSiga o passo a passo:\\n1️⃣ Acesse sua área do cliente\\n2️⃣ Clique em Documentos"}';
    expect(unwrapMessagePayloadText(raw)).toBe(
      "📄 Como emitir seu comprovante\nSiga o passo a passo:\n1️⃣ Acesse sua área do cliente\n2️⃣ Clique em Documentos",
    );
  });

  it("trecho cortado (JSON que não fecha) também é limpo", () => {
    const raw = '{"type":"text","body":"Para instalar o aplicativo 👉\\n✔️ Acesse a loja \\"Play Store\\"';
    expect(unwrapMessagePayloadText(raw)).toBe('Para instalar o aplicativo 👉\n✔️ Acesse a loja "Play Store"');
  });

  it("texto comum passa intacto", () => {
    expect(unwrapMessagePayloadText("FAQ de cadastro\n1. Acesse o portal")).toBe("FAQ de cadastro\n1. Acesse o portal");
    expect(unwrapMessagePayloadText('{"outro":"json"}')).toBe('{"outro":"json"}');
  });
});
