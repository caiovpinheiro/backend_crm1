import { describe, expect, it } from "vitest";

import { normalizeOrganizationLogoUrl, UNSAFE_LOGO_URL_MESSAGE } from "./organization-logo-url";

const ORG = "clxxxxxxxxxxxxxxxxxxxxxxxxx";

function normalize(input: string | null, current?: string | null) {
  return normalizeOrganizationLogoUrl(input, {
    organizationId: ORG,
    currentLogoUrl: current,
  });
}

describe("normalizeOrganizationLogoUrl", () => {
  it("trata vazio como remoção", () => {
    expect(normalize(null)).toBeNull();
    expect(normalize("")).toBeNull();
    expect(normalize("   ")).toBeNull();
  });

  it("preserva o logo já gravado mesmo que não passasse na regra nova", () => {
    const legacy = "data:image/svg+xml;base64,PHN2ZyBvbG9hZD1hbGVydCgxKTwvc3ZnPg==";
    expect(normalize(legacy, legacy)).toBe(legacy);
  });

  it("aceita URL de storage branding da própria org com extensão raster", () => {
    const url = `/api/storage/${ORG}/branding/logo_abc.jpg`;
    expect(normalize(url)).toBe(url);
  });

  it("rejeita storage de outro bucket ou outra org", () => {
    expect(() => normalize(`/api/storage/${ORG}/avatars/foto.png`)).toThrow(
      UNSAFE_LOGO_URL_MESSAGE,
    );
    expect(() =>
      normalize("/api/storage/clotherorgidxxxxxxxxxxxx/branding/logo.png"),
    ).toThrow(UNSAFE_LOGO_URL_MESSAGE);
  });

  it("rejeita SVG, HTML, data URL e javascript em valor novo", () => {
    expect(() => normalize("javascript:alert(1)")).toThrow(UNSAFE_LOGO_URL_MESSAGE);
    expect(() => normalize("data:image/svg+xml,<svg></svg>")).toThrow(
      UNSAFE_LOGO_URL_MESSAGE,
    );
    expect(() => normalize("https://cdn.example.com/logo.svg")).toThrow(
      UNSAFE_LOGO_URL_MESSAGE,
    );
    expect(() => normalize("https://cdn.example.com/page.html")).toThrow(
      UNSAFE_LOGO_URL_MESSAGE,
    );
    expect(() =>
      normalize(`/api/storage/${ORG}/branding/logo.svg`),
    ).toThrow(UNSAFE_LOGO_URL_MESSAGE);
  });

  it("aceita https de imagem raster (colar URL)", () => {
    expect(normalize("https://cdn.example.com/brand/logo.png")).toBe(
      "https://cdn.example.com/brand/logo.png",
    );
  });
});
