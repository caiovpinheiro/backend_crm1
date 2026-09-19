import { beforeAll, describe, expect, it } from "vitest";

import { runWithContext } from "@/lib/request-context";
import { primeAcademicTenantConfig } from "@/verticals/academic/tenant-config";
import { stripUnofficialUrls as strip } from "../outbound-url-guard";

// URLs e domínios liberados são config da org (R1): o guard precisa de um
// contexto de organização para saber o que é oficial.
const ORG = "org_guard_test";

function stripUnofficialUrls(
  ...args: Parameters<typeof strip>
): ReturnType<typeof strip> {
  return runWithContext(
    { organizationId: ORG, userId: "u1", isSuperAdmin: false },
    () => strip(...args),
  ) as ReturnType<typeof strip>;
}

describe("stripUnofficialUrls", () => {
  beforeAll(() => {
    primeAcademicTenantConfig(ORG, {
      portalUrl: "https://novoportal.cruzeirodosul.edu.br/",
      inauguralCertificateUrl: "https://app.cruzeiroead.com.br/",
      firstAccessVideoUrl: "https://youtu.be/vFJP7a1EMsU",
      appAndroidUrl:
        "https://play.google.com/store/apps/details?id=br.com.cruzeirodosulvirtual",
      appIosUrl:
        "https://apps.apple.com/us/app/duda-aplicativo-do-estudante/id6451416655",
      allowedUrlSuffixes: [
        "cruzeirodosul.edu.br",
        "cruzeirodosulvirtual.com.br",
        "cruzeiroead.com.br",
      ],
    });
  });

  it("preserva os links oficiais da config da org", () => {
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

  it("preserva subdomínio da instituição que não está nas URLs configuradas", () => {
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
