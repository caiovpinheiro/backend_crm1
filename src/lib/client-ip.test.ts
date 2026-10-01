/**
 * IP do cliente para rate-limit: o começo de `X-Forwarded-For` é do
 * cliente e não pode escolher o balde (bypass do pentest de out/2026).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getClientIp, getTrustedProxyHops } from "@/lib/client-ip";

const CLIENT = "203.0.113.50";
const FORGED = "198.51.100.99";
const FRONTEND = "10.0.1.7";

function req(headers: Record<string, string>): Request {
  return new Request("https://api.test/api/auth/tenant-lookup", {
    method: "POST",
    headers,
  });
}

const saved = {
  hops: process.env.TRUSTED_PROXY_HOPS,
  cidrs: process.env.TRUSTED_PROXY_CIDRS,
};

beforeEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
  delete process.env.TRUSTED_PROXY_CIDRS;
});

afterEach(() => {
  if (saved.hops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = saved.hops;
  if (saved.cidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
  else process.env.TRUSTED_PROXY_CIDRS = saved.cidrs;
});

describe("getClientIp — default (TRUSTED_PROXY_HOPS=1)", () => {
  it("chamada direta na API: usa o valor anexado pelo proxy, não o forjado", () => {
    expect(getClientIp(req({ "x-forwarded-for": `${FORGED}, ${CLIENT}` }))).toBe(CLIENT);
  });

  it("trocar o valor forjado não muda o balde", () => {
    const a = getClientIp(req({ "x-forwarded-for": `1.1.1.1, ${CLIENT}` }));
    const b = getClientIp(req({ "x-forwarded-for": `2.2.2.2, 3.3.3.3, ${CLIENT}` }));
    expect(a).toBe(CLIENT);
    expect(b).toBe(CLIENT);
  });

  it("via frontend: pula o IP interno do frontend e devolve o cliente", () => {
    expect(
      getClientIp(req({ "x-forwarded-for": `${FORGED}, ${CLIENT}, ${FRONTEND}` })),
    ).toBe(CLIENT);
  });

  it("forjar um IP privado à esquerda não faz o cliente real ser pulado", () => {
    expect(getClientIp(req({ "x-forwarded-for": `10.9.9.9, ${CLIENT}` }))).toBe(CLIENT);
  });

  it("não pula mais saltos do que o configurado", () => {
    // 2 saltos internos com hops=1: para no segundo (interno), nunca lê o forjado.
    expect(
      getClientIp(req({ "x-forwarded-for": `${FORGED}, 10.0.0.9, ${FRONTEND}` })),
    ).toBe("10.0.0.9");
  });

  it("um único valor: é o que o proxy viu", () => {
    expect(getClientIp(req({ "x-forwarded-for": CLIENT }))).toBe(CLIENT);
    expect(getClientIp(req({ "x-forwarded-for": FRONTEND }))).toBe(FRONTEND);
  });

  it("normaliza porta, colchetes e IPv4 mapeado em IPv6", () => {
    expect(getClientIp(req({ "x-forwarded-for": `${CLIENT}:51234` }))).toBe(CLIENT);
    expect(getClientIp(req({ "x-forwarded-for": "[2001:DB8::1]:443" }))).toBe("2001:db8::1");
    expect(getClientIp(req({ "x-forwarded-for": `::ffff:${CLIENT}` }))).toBe(CLIENT);
  });

  it("IPv6 interno (loopback / unique-local) conta como proxy confiável", () => {
    expect(getClientIp(req({ "x-forwarded-for": `${CLIENT}, fd00::7` }))).toBe(CLIENT);
    expect(getClientIp(req({ "x-forwarded-for": `${CLIENT}, ::1` }))).toBe(CLIENT);
  });

  it("sem XFF usa X-Real-IP; sem nada, 0.0.0.0", () => {
    expect(getClientIp(req({ "x-real-ip": CLIENT }))).toBe(CLIENT);
    expect(getClientIp(req({}))).toBe("0.0.0.0");
  });
});

describe("getClientIp — TRUSTED_PROXY_HOPS / TRUSTED_PROXY_CIDRS", () => {
  it("hops=0: sempre o último valor, mesmo que interno", () => {
    process.env.TRUSTED_PROXY_HOPS = "0";
    expect(getClientIp(req({ "x-forwarded-for": `${CLIENT}, ${FRONTEND}` }))).toBe(FRONTEND);
  });

  it("hops=2: pula até dois saltos internos e para no cliente", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(
      getClientIp(req({ "x-forwarded-for": `${FORGED}, ${CLIENT}, 10.0.0.9, ${FRONTEND}` })),
    ).toBe(CLIENT);
    // Mesmo com hops alto, um valor público nunca é pulado.
    expect(getClientIp(req({ "x-forwarded-for": `${FORGED}, ${CLIENT}` }))).toBe(CLIENT);
  });

  it("proxy confiável com IP público só é pulado se estiver em TRUSTED_PROXY_CIDRS", () => {
    const cdn = "192.0.2.44";
    expect(getClientIp(req({ "x-forwarded-for": `${CLIENT}, ${cdn}` }))).toBe(cdn);
    process.env.TRUSTED_PROXY_CIDRS = "192.0.2.0/24";
    expect(getClientIp(req({ "x-forwarded-for": `${CLIENT}, ${cdn}` }))).toBe(CLIENT);
    process.env.TRUSTED_PROXY_CIDRS = " 192.0.2.44 ";
    expect(getClientIp(req({ "x-forwarded-for": `${CLIENT}, ${cdn}` }))).toBe(CLIENT);
  });

  it("valor inválido de TRUSTED_PROXY_HOPS cai no default 1", () => {
    for (const bad of ["abc", "-1", "1.5", ""]) {
      process.env.TRUSTED_PROXY_HOPS = bad;
      expect(getTrustedProxyHops()).toBe(1);
    }
    process.env.TRUSTED_PROXY_HOPS = "999";
    expect(getTrustedProxyHops()).toBe(10);
  });
});

describe("getClientIp — reexport de @/lib/rate-limit", () => {
  it("é o mesmo helper usado por login, lookup, reset e signup", async () => {
    const rl = await import("@/lib/rate-limit");
    expect(rl.getClientIp).toBe(getClientIp);
  });
});
