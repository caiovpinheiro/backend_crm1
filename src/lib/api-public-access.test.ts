import { describe, expect, it } from "vitest";

import {
  bearerRequiresPublicApiMessage,
  isBearerAllowedOnThisProcess,
  publicApiBaseUrl,
  resolveAppMode,
} from "@/lib/api-public-access";

describe("api-public-access", () => {
  it("resolve APP_MODE default api", () => {
    expect(resolveAppMode({})).toBe("api");
    expect(resolveAppMode({ APP_MODE: "api-public" })).toBe("api-public");
  });

  it("aceita Bearer em api-public, dev e escape hatch", () => {
    expect(
      isBearerAllowedOnThisProcess({ APP_MODE: "api-public", NODE_ENV: "production" }),
    ).toBe(true);
    expect(
      isBearerAllowedOnThisProcess({ APP_MODE: "api", NODE_ENV: "development" }),
    ).toBe(true);
    expect(
      isBearerAllowedOnThisProcess({
        APP_MODE: "api",
        NODE_ENV: "production",
        ALLOW_BEARER_ON_PRIVATE_API: "1",
      }),
    ).toBe(true);
    expect(
      isBearerAllowedOnThisProcess({ APP_MODE: "api", NODE_ENV: "production" }),
    ).toBe(false);
  });

  it("monta a URL pública sem barra final", () => {
    expect(publicApiBaseUrl({})).toBe("https://integrations.bwipo.com");
    expect(publicApiBaseUrl({ API_PUBLIC_BASE_URL: "https://x.example/" })).toBe(
      "https://x.example",
    );
    expect(bearerRequiresPublicApiMessage({})).toContain("https://integrations.bwipo.com");
  });
});
