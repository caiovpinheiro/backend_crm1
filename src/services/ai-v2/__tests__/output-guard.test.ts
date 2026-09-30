import { describe, expect, it } from "vitest";
import { guardV2Output, removeUnauthorizedUrls, scrubNonCitableFields } from "@/services/ai-v2/output-guard";

describe("guardV2Output — scrub de campos só 'Ler'", () => {
  it("remove valor de campo não citável da resposta e registra aviso", () => {
    const result = guardV2Output(
      "Olá João, seu saldo é R$ 1.234,56. Posso ajudar?",
      [],
      {
        contact: { name: "João", balance: "R$ 1.234,56" },
        citableContact: { name: "João" },
        selectedDeal: null,
        citableDeal: null,
      },
    );
    expect(result.text).not.toContain("R$ 1.234,56");
    // A frase com o dado interno sai inteira; o marcador nunca chega ao cliente.
    expect(result.text).toBe("Posso ajudar?");
    expect(result.text).not.toContain("[informação interna não compartilhada]");
    expect(result.warnings.some((w) => w.includes("'Ler'"))).toBe(true);
    expect(result.scrubbedFields).toContain("R$ 1.234,56");
  });

  it("não remove campo marcado como 'Citar'", () => {
    const result = guardV2Output(
      "Seu nome é João e sua cidade é São Paulo.",
      [],
      {
        contact: { name: "João", city: "São Paulo" },
        citableContact: { name: "João", city: "São Paulo" },
        selectedDeal: null,
        citableDeal: null,
      },
    );
    expect(result.text).toBe("Seu nome é João e sua cidade é São Paulo.");
    expect(result.scrubbedFields).toBeUndefined();
  });

  it("insiste e não revela campo só 'Ler' mesmo com mensagem de urgência", () => {
    const result = guardV2Output(
      "Tudo bem, é urgente: o valor é R$ 5.000,00.",
      [],
      {
        contact: { value: "R$ 5.000,00" },
        citableContact: {},
        selectedDeal: null,
        citableDeal: null,
      },
    );
    expect(result.text).not.toContain("R$ 5.000,00");
    expect(result.text).not.toContain("[informação interna não compartilhada]");
    expect(result.scrubbedFields).toContain("R$ 5.000,00");
  });

  it("senha configurada como 'pode dizer' para este cliente sai; outra senha continua removida", () => {
    const ctx = { contact: { "Código de acesso": "Ana@123678" }, citableContact: { "Código de acesso": "Ana@123678" }, selectedDeal: null, citableDeal: null };
    expect(guardV2Output("Sua senha de acesso é *Ana@123678*.", [], ctx).text).toContain("Ana@123678");
    expect(guardV2Output("Sua senha é Xyz@987654.", [], ctx).text).not.toContain("Xyz@987654");
  });
});

describe("campo só-leitura — informação pública e marcador nunca visível", () => {
  const ctx = {
    contact: { Nome: "Ana" },
    citableContact: { Nome: "Ana" },
    selectedDeal: { Plano: "Premium", Código: "X9-771" },
    citableDeal: {},
  };

  it("valor que também está no material lido não é tratado como dado interno", () => {
    const out = scrubNonCitableFields("Para clientes do plano Premium, a entrega é gratuita.", { ...ctx, publicTexts: ["No plano Premium a entrega é gratuita."] });
    expect(out.text).toBe("Para clientes do plano Premium, a entrega é gratuita.");
    expect(out.scrubbedFields).toEqual([]);
  });

  it("dado interno no meio da frase: a frase sai inteira, o marcador nunca chega ao cliente", () => {
    const out = scrubNonCitableFields("Ana, recebi seu pedido. O seu código interno é X9-771 no sistema. Qualquer dúvida, me chama.", ctx);
    expect(out.text).toBe("Ana, recebi seu pedido. Qualquer dúvida, me chama.");
    expect(out.text).not.toContain("[informação interna");
    expect(out.scrubbedFields).toEqual(["X9-771"]);
  });
});

describe("filtro de links — endereço inteiro e conteúdo da empresa", () => {
  const allowed = ["loja.exemplo.com"];

  it("link não liberado sai inteiro, com os parâmetros; a pontuação da frase fica", () => {
    const r = removeUnauthorizedUrls("Baixe em https://apps.outra.com/app?id=br.exemplo.app. Depois entre.", allowed);
    expect(r.text).toBe("Baixe em . Depois entre.");
    expect(r.removed).toEqual(["https://apps.outra.com/app?id=br.exemplo.app"]);
  });

  it("link liberado com parâmetros não é cortado no '?'", () => {
    const r = removeUnauthorizedUrls("Acesse https://loja.exemplo.com/p?x=1&y=2!", allowed);
    expect(r.text).toBe("Acesse https://loja.exemplo.com/p?x=1&y=2!");
  });

  it("link que está no conteúdo da empresa (mensagem pronta, material) sai mesmo fora dos endereços liberados", () => {
    const out = guardV2Output(
      "Android: https://apps.outra.com/app?id=br.exemplo.app\niPhone: https://store.outra.com/app/id123",
      allowed,
      { contact: null, citableContact: null, selectedDeal: null, citableDeal: null, ownerTexts: ["Android: https://apps.outra.com/app?id=br.exemplo.app / iPhone: https://store.outra.com/app/id123"] },
    );
    expect(out.text).toContain("https://apps.outra.com/app?id=br.exemplo.app");
    expect(out.text).toContain("https://store.outra.com/app/id123");
    expect(out.warnings.some((w) => w.includes("URLs removidas"))).toBe(false);
  });
});

