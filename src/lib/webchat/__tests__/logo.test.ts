import { describe, expect, it } from "vitest";

import { normalizeWebchatConfig, defaultWebchatConfig, WebchatConfigError } from "@/lib/webchat/config";
import {
  assertWebchatLogoOfOrg,
  publicWebchatAvatarUrl,
  webchatLogoFileOf,
} from "@/lib/webchat/logo";

const channel = { publicKey: "wc_chave", organizationId: "org_a" };

describe("publicWebchatAvatarUrl", () => {
  it("imagem de marca da organização vai pela rota pública, sem expor org nem arquivo", () => {
    const url = publicWebchatAvatarUrl("/api/storage/org_a/branding/logo_1.png", channel);
    expect(url).toMatch(/^\/api\/public\/webchat\/logo\?key=wc_chave&v=[0-9a-f]{12}$/);
    expect(url).not.toContain("org_a");
    expect(url).not.toContain("logo_1");
  });

  it("o v muda quando o arquivo muda", () => {
    const a = publicWebchatAvatarUrl("/api/storage/org_a/branding/logo_1.png", channel);
    const b = publicWebchatAvatarUrl("/api/storage/org_a/branding/logo_2.png", channel);
    expect(a).not.toBe(b);
  });

  it("aceita URL absoluta do próprio storage", () => {
    expect(
      publicWebchatAvatarUrl("https://crm.test/api/storage/org_a/branding/logo_1.png", channel),
    ).toContain("/api/public/webchat/logo?key=");
  });

  it("URL https externa segue como está; sem logo continua null", () => {
    expect(publicWebchatAvatarUrl("https://cdn.test/logo.png", channel)).toBe("https://cdn.test/logo.png");
    expect(publicWebchatAvatarUrl(null, channel)).toBeNull();
  });

  it.each([
    "/api/storage/org_b/branding/logo_1.png",
    "/api/storage/org_a/attachments/contrato.png",
    "/api/storage/org_a/keeps/nota.png",
    "/api/storage/org_a/branding/logo.svg",
    "/api/storage/org_a/branding/..%2F..%2Fsegredo.png",
  ])("%s não chega ao visitante", (avatar) => {
    expect(publicWebchatAvatarUrl(avatar, channel)).toBeNull();
    expect(webchatLogoFileOf(avatar, "org_a").fileName).toBeNull();
  });
});

describe("gravar a logo no canal", () => {
  const base = defaultWebchatConfig("wc_chave");
  const save = (avatarUrl: unknown) => normalizeWebchatConfig({ theme: { avatarUrl } }, base);

  it("aceita imagem enviada e URL https", () => {
    expect(save("/api/storage/org_a/branding/webchat_logo_1.png").theme.avatarUrl).toBe(
      "/api/storage/org_a/branding/webchat_logo_1.png",
    );
    expect(save("https://cdn.test/logo.png").theme.avatarUrl).toBe("https://cdn.test/logo.png");
  });

  it("null volta a herdar", () => {
    expect(save(null).theme.avatarUrl).toBeUndefined();
  });

  it.each([
    "http://cdn.test/logo.png",
    "/api/storage/org_a/attachments/a.png",
    "/api/storage/org_a/branding/a.svg",
    "/api/storage/org_a/branding/../attachments/a.png",
    "/api/uploads/a.png",
    "javascript:alert(1)",
  ])("recusa %s", (avatarUrl) => {
    expect(() => save(avatarUrl)).toThrow(WebchatConfigError);
  });

  it("caminho de outra organização é recusado na gravação", () => {
    expect(() => assertWebchatLogoOfOrg("/api/storage/org_b/branding/a.png", "org_a")).toThrow(WebchatConfigError);
    expect(() => assertWebchatLogoOfOrg("/api/storage/org_a/branding/a.png", "org_a")).not.toThrow();
    expect(() => assertWebchatLogoOfOrg("https://cdn.test/a.png", "org_a")).not.toThrow();
    expect(() => assertWebchatLogoOfOrg(undefined, "org_a")).not.toThrow();
  });
});
