import { describe, expect, it } from "vitest";

import {
  WEBCHAT_FALLBACK_PRIMARY,
  WebchatConfigError,
  defaultWebchatConfig,
  normalizeWebchatConfig,
  resolveWebchatTheme,
  webchatOrgDefaults,
} from "@/lib/webchat/config";

const KEY = "wc_ABCDEFGHIJKLMNOPQRSTUVWX";

describe("tema do webchat herda a marca da org", () => {
  it("canal novo nasce sem primary/avatarUrl (herdando)", () => {
    const cfg = defaultWebchatConfig(KEY);
    expect(cfg.theme).not.toHaveProperty("primary");
    expect(cfg.theme).not.toHaveProperty("avatarUrl");
  });

  it("PUT com primary/avatarUrl null volta a herdar; cor inválida → erro", () => {
    const custom = normalizeWebchatConfig(
      { theme: { primary: "#FF0000", avatarUrl: "https://cdn.test/a.png" } },
      defaultWebchatConfig(KEY),
    );
    expect(custom.theme).toMatchObject({ primary: "#FF0000", avatarUrl: "https://cdn.test/a.png" });
    const back = normalizeWebchatConfig({ theme: { primary: null, avatarUrl: null } }, custom);
    expect(back.theme).not.toHaveProperty("primary");
    expect(back.theme).not.toHaveProperty("avatarUrl");
    // patch sem a chave mantém o gravado
    expect(normalizeWebchatConfig({ theme: { title: "Oi" } }, custom).theme.primary).toBe("#FF0000");
    expect(() => normalizeWebchatConfig({ theme: { primary: "red" } }, custom)).toThrow(WebchatConfigError);
  });

  it("tema efetivo: canal vence; senão org; senão fallback", () => {
    const org = webchatOrgDefaults({ primaryColor: "#1e3a8a", logoUrl: "https://cdn.test/logo.png" });
    expect(org).toEqual({ primary: "#1e3a8a", avatarUrl: "https://cdn.test/logo.png" });
    expect(webchatOrgDefaults({ primaryColor: null, logoUrl: null })).toEqual({
      primary: WEBCHAT_FALLBACK_PRIMARY,
      avatarUrl: null,
    });
    const inherit = resolveWebchatTheme({ position: "left", title: "T" }, org);
    expect(inherit).toEqual({ primary: "#1e3a8a", avatarUrl: "https://cdn.test/logo.png", position: "left", title: "T" });
    const own = resolveWebchatTheme({ primary: "#00FF00", position: "right", title: "T" }, org);
    expect(own.primary).toBe("#00FF00");
    expect(own.avatarUrl).toBe("https://cdn.test/logo.png");
  });
});
