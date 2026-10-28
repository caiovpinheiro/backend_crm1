/**
 * Webchat v2 no serviço de canais: segredos nunca saem para o painel, o PUT
 * do config mescla `v2` e preserva os segredos gravados (o cliente não
 * consegue sobrescrever nem apagar), e a rotação devolve o valor uma vez.
 */
import { randomBytes } from "node:crypto";

import type { Channel } from "@prisma/client";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  audits: [] as unknown[],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: {
      findUnique: vi.fn(async () => h.row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.updates.push(data);
        h.row = { ...(h.row ?? {}), ...data };
        return h.row;
      }),
    },
    organization: { findUnique: vi.fn(async () => ({ primaryColor: "#112233", logoUrl: null })) },
  },
}));
vi.mock("@/lib/cache", () => ({ cache: { del: vi.fn(async () => {}) } }));
vi.mock("@/lib/cache/keys", () => ({
  channelKey: (id: string) => `channel:${id}`,
  invalidateChannelLookups: vi.fn(async () => {}),
}));
vi.mock("@/lib/cache/response-cache", () => ({
  bumpResponseFamilies: vi.fn(async () => {}),
  RESPONSE_FAMILIES: { channels: "channels" },
}));
vi.mock("@/lib/audit/log", () => ({ logAudit: vi.fn(async (a: unknown) => void h.audits.push(a)) }));

import { readWebchatSecret } from "@/lib/webchat/secrets";
import {
  redactWebchatChannel,
  rotateWebchatChannelSecret,
  updateChannel,
  withWebchatDefaults,
} from "@/services/channels";

const PUBLIC_KEY = "wc_ABCDEFGHIJKLMNOPQRSTUVWX";

beforeAll(() => {
  process.env.KEYRING_SECRET = randomBytes(32).toString("base64");
});

beforeEach(() => {
  h.updates.length = 0;
  h.audits.length = 0;
  h.row = {
    id: "ch-1",
    organizationId: "org-1",
    provider: "WEBCHAT",
    type: "WEBCHAT",
    status: "CONNECTED",
    publicKey: PUBLIC_KEY,
    config: { publicKey: PUBLIC_KEY, allowedOrigins: [], identification: "none" },
  };
});

describe("rotateWebchatChannelSecret", () => {
  it("gera, grava encriptado e devolve o valor em claro uma vez", async () => {
    const res = await rotateWebchatChannelSecret("ch-1", "identity");
    expect(res?.secret).toMatch(/^wcid_/);
    expect(res?.status.identity.configured).toBe(true);
    expect(res?.status.s2s.configured).toBe(false);
    const saved = h.updates[0].config as Record<string, unknown>;
    expect(saved.identitySecret).toMatch(/^enc:v1:/);
    expect(readWebchatSecret(saved, "identity")).toBe(res?.secret);
    // Auditoria sem o valor.
    expect(JSON.stringify(h.audits)).not.toContain(res!.secret);
  });

  it("girar troca o valor (o anterior deixa de valer)", async () => {
    const first = await rotateWebchatChannelSecret("ch-1", "s2s");
    const second = await rotateWebchatChannelSecret("ch-1", "s2s");
    expect(second?.secret).not.toBe(first?.secret);
    expect(readWebchatSecret(h.row?.config, "s2s")).toBe(second?.secret);
  });

  it("canal que não é WEBCHAT → null", async () => {
    h.row = { ...h.row!, provider: "META_CLOUD_API" };
    expect(await rotateWebchatChannelSecret("ch-1", "identity")).toBeNull();
    expect(h.updates).toHaveLength(0);
  });
});

describe("updateChannel (WEBCHAT) com v2", () => {
  it("mescla v2 parcial e preserva segredos; cliente não sobrescreve segredo", async () => {
    const rotated = await rotateWebchatChannelSecret("ch-1", "identity");
    h.updates.length = 0;
    await updateChannel("ch-1", {
      config: {
        greeting: "Oi",
        identitySecret: "wcid_tentativa-do-cliente",
        s2sSecret: "wcsk_tentativa",
        v2: { context: { labels: { etapa: "Etapa" }, anonymous: true } },
      },
    });
    const saved = h.updates[0].config as Record<string, unknown>;
    expect(saved.greeting).toBe("Oi");
    expect(readWebchatSecret(saved, "identity")).toBe(rotated?.secret);
    expect(saved.s2sSecret).toBeUndefined();
    const v2 = saved.v2 as { context: { labels: Record<string, string>; anonymous: boolean; maxKeys: number } };
    expect(v2.context.labels).toEqual({ etapa: "Etapa" });
    expect(v2.context.anonymous).toBe(true);
    expect(v2.context.maxKeys).toBe(30);

    // Segundo PUT sem v2: o v2 gravado continua.
    h.updates.length = 0;
    await updateChannel("ch-1", { config: { greeting: "Olá" } });
    const again = h.updates[0].config as { v2: typeof v2 };
    expect(again.v2.context.labels).toEqual({ etapa: "Etapa" });
  });

  it("v2 inválido → erro de validação", async () => {
    await expect(
      updateChannel("ch-1", { config: { v2: { events: { retentionDays: 0 } } } }),
    ).rejects.toThrow(/retentionDays/);
  });
});

describe("respostas ao painel", () => {
  it("redact tira os segredos do config e devolve só o status", async () => {
    await rotateWebchatChannelSecret("ch-1", "s2s");
    const out = redactWebchatChannel(h.row as { provider: "WEBCHAT"; config: unknown });
    expect(JSON.stringify(out)).not.toContain("enc:v1:");
    expect(out.webchatSecrets?.s2s.configured).toBe(true);
    expect(typeof out.webchatSecrets?.s2s.rotatedAt).toBe("string");

    const withDefaults = await withWebchatDefaults(h.row as unknown as Channel);
    expect(JSON.stringify(withDefaults)).not.toContain("enc:v1:");
    expect(withDefaults.webchatSecrets?.s2s.configured).toBe(true);
  });

  it("outros provedores passam intactos", () => {
    const meta = { provider: "META_CLOUD_API" as const, config: { accessToken: "enc:v1:x" } };
    expect(redactWebchatChannel(meta)).toBe(meta);
  });
});

describe("erro de v2 vira 400 nas rotas", () => {
  it("WebchatV2ConfigError é um WebchatConfigError", async () => {
    const { WebchatConfigError } = await import("@/lib/webchat/config");
    const err = await updateChannel("ch-1", { config: { v2: { context: { maxKeys: -1 } } } }).catch((e) => e);
    expect(err).toBeInstanceOf(WebchatConfigError);
  });
});
