import { randomBytes } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { decryptChannelConfig, encryptChannelConfig } from "@/lib/channels/config";
import {
  generateWebchatSecret,
  pickWebchatSecretFields,
  readWebchatSecret,
  stripWebchatSecrets,
  webchatSecretsStatus,
  withRotatedWebchatSecret,
} from "@/lib/webchat/secrets";

beforeAll(() => {
  process.env.KEYRING_SECRET = randomBytes(32).toString("base64");
});

describe("segredos do webchat v2", () => {
  it("gera com prefixo por tipo e valores diferentes", () => {
    const a = generateWebchatSecret("identity");
    const b = generateWebchatSecret("identity");
    expect(a).toMatch(/^wcid_[A-Za-z0-9_-]{43}$/);
    expect(generateWebchatSecret("s2s")).toMatch(/^wcsk_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("rotação grava encriptado, carimba a data e devolve o valor em claro uma vez", () => {
    const now = new Date("2026-10-28T12:00:00.000Z");
    const { config, plain, rotatedAt } = withRotatedWebchatSecret({ publicKey: "wc_x" }, "identity", now);
    expect(rotatedAt).toBe(now.toISOString());
    expect(config.identitySecret).toMatch(/^enc:v1:/);
    expect(config.identitySecret).not.toContain(plain);
    expect(config.identitySecretRotatedAt).toBe(now.toISOString());
    expect(readWebchatSecret(config, "identity")).toBe(plain);
    expect(readWebchatSecret(config, "s2s")).toBeNull();
  });

  it("status só diz sim/não e a data; strip remove todo campo de segredo", () => {
    const one = withRotatedWebchatSecret({ publicKey: "wc_x", greeting: "oi" }, "s2s").config;
    expect(webchatSecretsStatus(one)).toEqual({
      identity: { configured: false, rotatedAt: null },
      s2s: { configured: true, rotatedAt: one.s2sSecretRotatedAt },
    });
    const stripped = stripWebchatSecrets(one);
    expect(stripped).toEqual({ publicKey: "wc_x", greeting: "oi" });
    expect(JSON.stringify(stripped)).not.toContain("enc:v1:");
  });

  it("pick preserva só os campos de segredo", () => {
    const cfg = withRotatedWebchatSecret({ publicKey: "wc_x" }, "identity").config;
    expect(Object.keys(pickWebchatSecretFields(cfg)).sort()).toEqual([
      "identitySecret",
      "identitySecretRotatedAt",
    ]);
  });

  it("os dois segredos são campos sensíveis do provider WEBCHAT", () => {
    const enc = encryptChannelConfig("WEBCHAT", { identitySecret: "wcid_a", s2sSecret: "wcsk_b", x: 1 });
    expect(enc.identitySecret).toMatch(/^enc:v1:/);
    expect(enc.s2sSecret).toMatch(/^enc:v1:/);
    expect(enc.x).toBe(1);
    expect(decryptChannelConfig("WEBCHAT", enc)).toEqual({ identitySecret: "wcid_a", s2sSecret: "wcsk_b", x: 1 });
  });
});
