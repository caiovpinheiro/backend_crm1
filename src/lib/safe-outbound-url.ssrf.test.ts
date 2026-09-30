import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import { assertSafeOutboundUrl, assertSafeOutboundUrlSync, isBlockedIp } from "./safe-outbound-url";

const BLOCKED = /interno|privado|inválida|porta|não resolvido/i;

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OUTBOUND_ALLOWED_PORTS;
});

describe("assertSafeOutboundUrl (V6)", () => {
  it("bloqueia loopback e link-local sem DNS", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1/x")).rejects.toThrow(BLOCKED);
    await expect(assertSafeOutboundUrl("http://169.254.169.254/latest")).rejects.toThrow(BLOCKED);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("aceita https com hostname público na validação de protocolo/host", async () => {
    await expect(assertSafeOutboundUrl("https://example.com/logo.png")).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("recusa protocolos que não sejam http(s) e credenciais na URL", async () => {
    await expect(assertSafeOutboundUrl("ftp://example.com/x")).rejects.toThrow(/http/);
    await expect(assertSafeOutboundUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(assertSafeOutboundUrl("https://user:pw@example.com/x")).rejects.toThrow(/credenciais/);
  });

  it("recusa hostname público que resolve para IP interno", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(assertSafeOutboundUrl("https://rebind.example.com/")).rejects.toThrow(BLOCKED);
  });

  it("recusa quando o DNS falha ou estoura o timeout", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSafeOutboundUrl("https://nope.example.com/")).rejects.toThrow(/não resolvido/);

    lookupMock.mockImplementation(() => new Promise(() => undefined)); // nunca resolve
    await expect(
      assertSafeOutboundUrl("https://slow.example.com/", { dnsTimeoutMs: 20 }),
    ).rejects.toThrow(/não resolvido/);
  });
});

describe("faixas IPv4 reservadas", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ])("bloqueia %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "198.20.0.1", "223.255.255.255"])(
    "permite %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it("bloqueia IPv4 em notação alternativa via URL (normalizada pelo WHATWG URL)", () => {
    expect(() => assertSafeOutboundUrlSync("http://0x7f000001/")).toThrow(BLOCKED);
    expect(() => assertSafeOutboundUrlSync("http://2130706433/")).toThrow(BLOCKED);
    expect(() => assertSafeOutboundUrlSync("http://127.1/")).toThrow(BLOCKED);
  });
});

describe("faixas IPv6 reservadas", () => {
  it.each([
    "::1",
    "::",
    "0:0:0:0:0:0:0:1",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped (decimal)
    "::ffff:7f00:1", // IPv4-mapped (hex, como o WHATWG URL serializa)
    "::ffff:10.0.0.1",
    "::ffff:0:a9fe:a9fe", // IPv4-translated 169.254.169.254
    "::127.0.0.1", // IPv4-compatible (obsoleto)
    "64:ff9b::7f00:1", // NAT64 → 127.0.0.1
    "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254
    "64:ff9b:1::1", // NAT64 local
    "2002:7f00:1::1", // 6to4 → 127.0.0.1
    "2002:c0a8:101::1", // 6to4 → 192.168.1.1
    "2001:db8::1",
    "100::1",
    "not:an:ip",
  ])("bloqueia %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    "2606:2800:220:1:248:1893:25c8:1946",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808", // NAT64 → 8.8.8.8
    "2002:808:808::1", // 6to4 → 8.8.8.8
  ])("permite %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it("bloqueia literal IPv6 na URL, inclusive mapped serializado em hex", async () => {
    await expect(assertSafeOutboundUrl("http://[::1]/")).rejects.toThrow(BLOCKED);
    await expect(assertSafeOutboundUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(BLOCKED);
    await expect(assertSafeOutboundUrl("http://[64:ff9b::a9fe:a9fe]/")).rejects.toThrow(BLOCKED);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("hostnames internos", () => {
  it.each([
    "http://localhost/",
    "http://LOCALHOST./",
    "http://foo.localhost/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://svc.internal/",
    "http://printer.local/",
    "http://nas.lan/",
    "http://router.home.arpa/",
  ])("bloqueia %s sem DNS", async (url) => {
    await expect(assertSafeOutboundUrl(url)).rejects.toThrow(BLOCKED);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("allowlist de portas", () => {
  it("permite 80/443 (explícitas ou implícitas) e recusa outras", async () => {
    await expect(assertSafeOutboundUrl("http://example.com/")).resolves.toBeUndefined();
    await expect(assertSafeOutboundUrl("https://example.com:443/")).resolves.toBeUndefined();
    await expect(assertSafeOutboundUrl("http://example.com:8080/")).rejects.toThrow(/porta 8080/);
    await expect(assertSafeOutboundUrl("https://example.com:5678/")).rejects.toThrow(/porta 5678/);
    await expect(assertSafeOutboundUrl("http://example.com:22/")).rejects.toThrow(/porta 22/);
  });

  it("OUTBOUND_ALLOWED_PORTS substitui a lista padrão", async () => {
    process.env.OUTBOUND_ALLOWED_PORTS = "443, 5678";
    await expect(assertSafeOutboundUrl("https://example.com:5678/")).resolves.toBeUndefined();
    await expect(assertSafeOutboundUrl("http://example.com/")).rejects.toThrow(/porta 80/);
  });

  it("opts.allowedPorts estende a lista", async () => {
    await expect(
      assertSafeOutboundUrl("https://example.com:8443/", { allowedPorts: [8443] }),
    ).resolves.toBeUndefined();
  });
});
