import { afterEach, describe, expect, it, vi } from "vitest";

import { assertSafeOutboundUrl } from "./safe-outbound-url";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertSafeOutboundUrl (V6)", () => {
  it("bloqueia loopback e link-local sem DNS", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1/x")).rejects.toThrow(
      /interno|privado|inválida/i,
    );
    await expect(assertSafeOutboundUrl("http://169.254.169.254/latest")).rejects.toThrow(
      /interno|privado/i,
    );
  });

  it("aceita https com hostname público na validação de protocolo/host", async () => {
    await expect(assertSafeOutboundUrl("https://example.com/logo.png")).resolves.toBeUndefined();
  });
});
