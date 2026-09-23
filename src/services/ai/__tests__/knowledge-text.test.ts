import { describe, expect, it } from "vitest";

import { unwrapMessagePayloadText } from "@/services/ai/knowledge-text";

describe("unwrapMessagePayloadText", () => {
  it("extrai o body do payload de modelo de mensagem com quebras reais", () => {
    const raw =
      '{"type":"text","body":"📄 Como emitir sua Declaração de Matrícula\\nSiga o passo a passo:\\n1️⃣ Acesse sua Área do Aluno\\n2️⃣ Clique em Emissão de Documentos"}';
    expect(unwrapMessagePayloadText(raw)).toBe(
      "📄 Como emitir sua Declaração de Matrícula\nSiga o passo a passo:\n1️⃣ Acesse sua Área do Aluno\n2️⃣ Clique em Emissão de Documentos",
    );
  });

  it("trecho cortado (JSON que não fecha) também é limpo", () => {
    const raw = '{"type":"text","body":"Para instalar o aplicativo DUDA 👉\\n✔️ Acesse a loja \\"Play Store\\"';
    expect(unwrapMessagePayloadText(raw)).toBe('Para instalar o aplicativo DUDA 👉\n✔️ Acesse a loja "Play Store"');
  });

  it("texto comum passa intacto", () => {
    expect(unwrapMessagePayloadText("FAQ de matrícula\n1. Acesse o portal")).toBe("FAQ de matrícula\n1. Acesse o portal");
    expect(unwrapMessagePayloadText('{"outro":"json"}')).toBe('{"outro":"json"}');
  });
});
