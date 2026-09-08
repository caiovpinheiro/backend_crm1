import { describe, expect, it } from "vitest";

import { stripUnofficialUrls } from "../outbound-url-guard";

describe("stripUnofficialUrls", () => {
  it("preserva os links oficiais do pack", () => {
    const text = [
      "Tutorial: https://youtu.be/vFJP7a1EMsU",
      "Portal: https://novoportal.cruzeirodosul.edu.br/",
      "Android: https://play.google.com/store/apps/details?id=br.com.cruzeirodosulvirtual",
      "iOS: https://apps.apple.com/us/app/duda-aplicativo-do-estudante/id6451416655",
      "Certificado: https://app.cruzeiroead.com.br/",
    ].join("\n");

    const out = stripUnofficialUrls(text);

    expect(out.removed).toEqual([]);
    expect(out.text).toBe(text);
  });

  it("preserva subdomínio da instituição que não está nas constantes", () => {
    const text = "Veja em https://www.cruzeirodosulvirtual.com.br/nossos-polos/";
    expect(stripUnofficialUrls(text).removed).toEqual([]);
  });

  it("remove o reset de senha da Microsoft que o agente inventou", () => {
    const out = stripUnofficialUrls(
      "Redefina em https://passwordreset.microsoftonline.com/ seguindo as instruções.",
    );

    expect(out.removed).toEqual(["passwordreset.microsoftonline.com"]);
    expect(out.text).not.toContain("microsoftonline");
    expect(out.text).toContain("seguindo as instruções.");
  });

  it("mantém a pontuação da frase quando o link estava no fim", () => {
    const out = stripUnofficialUrls("Acesse https://exemplo-inventado.com.");
    expect(out.text).toBe("Acesse.");
    expect(out.removed).toEqual(["exemplo-inventado.com"]);
  });

  it("libera domínio de terceiro que veio do contexto do operador", () => {
    const url = "https://forms.gle/abc123";
    const out = stripUnofficialUrls(
      `Preencha em ${url}`,
      `BASE DE CONHECIMENTO\n[1] Formulário\nLink: ${url}`,
    );

    expect(out.removed).toEqual([]);
    expect(out.text).toContain(url);
  });

  it("não mexe em texto sem URL", () => {
    const text = "Bom dia! Como posso ajudar?";
    expect(stripUnofficialUrls(text)).toEqual({ text, removed: [] });
  });
});
