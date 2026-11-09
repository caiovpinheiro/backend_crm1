/**
 * BaileysManager: quais canais o boot reabre, desligamento sem mudar
 * status, e um processo por número (trava).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  channels: [] as Array<{ id: string; organizationId: string; status: string; sessionData: unknown; provider?: string }>,
  creds: [] as Array<{ channelId: string; value: unknown }>,
  sessions: [] as Array<{ channelId: string; connect: ReturnType<typeof import("vitest").vi.fn>; stop: ReturnType<typeof import("vitest").vi.fn>; disconnect: ReturnType<typeof import("vitest").vi.fn> }>,
  connectFails: 0,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("./sync-groups", () => ({ syncChannelGroups: vi.fn() }));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    channel: {
      findMany: vi.fn(async () => h.channels),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const c = h.channels.find((x) => x.id === where.id);
        return c ? { organizationId: c.organizationId, provider: c.provider ?? "BAILEYS_MD" } : null;
      }),
    },
    baileysAuthKey: { findMany: vi.fn(async () => h.creds) },
  },
}));
vi.mock("./baileys-session", () => ({
  BaileysSession: class {
    socket: unknown = null;
    isDestroyed = false;
    connect = vi.fn(async () => {
      if (h.connectFails > 0) {
        h.connectFails--;
        throw new Error("db fora");
      }
      this.socket = {};
    });
    connectNow = vi.fn(async () => {
      this.socket = {};
    });
    stop = vi.fn(async () => {
      this.isDestroyed = true;
      this.socket = null;
    });
    disconnect = vi.fn(async () => {});
    logout = vi.fn(async () => {});
    constructor(public channelId: string) {
      h.sessions.push(this as never);
    }
  },
}));

import { BaileysManager, LOCK_WAIT_RETRY_MS, shouldReconnectOnBoot } from "./baileys-manager";
import type { SessionLock } from "./session-lock";

const REGISTERED = { me: { id: "5511944690752:5@s.whatsapp.net" } };

function fakeLock(owned: Set<string>, heldByOther: Set<string>) {
  return {
    acquire: vi.fn(async (id: string) => {
      if (heldByOther.has(id)) return false;
      owned.add(id);
      return true;
    }),
    renew: vi.fn(async (id: string) => owned.has(id) && !heldByOther.has(id)),
    release: vi.fn(async (id: string) => {
      owned.delete(id);
    }),
    holder: vi.fn(async () => "outro-processo"),
  } as unknown as SessionLock & { acquire: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.channels = [];
  h.creds = [];
  h.sessions = [];
  h.connectFails = 0;
});
afterEach(() => vi.useRealTimers());

describe("shouldReconnectOnBoot", () => {
  it("canal com credencial pareada volta mesmo gravado como DISCONNECTED (deploy antigo)", () => {
    expect(shouldReconnectOnBoot({ status: "DISCONNECTED", sessionData: null, credsValue: REGISTERED })).toBe(true);
    expect(shouldReconnectOnBoot({ status: "FAILED", sessionData: null, credsValue: REGISTERED })).toBe(true);
  });
  it("sem credencial pareada só volta se estava conectando/conectado", () => {
    expect(shouldReconnectOnBoot({ status: "DISCONNECTED", sessionData: null, credsValue: null })).toBe(false);
    expect(shouldReconnectOnBoot({ status: "QR_READY", sessionData: null, credsValue: {} })).toBe(false);
    expect(shouldReconnectOnBoot({ status: "CONNECTING", sessionData: null, credsValue: null })).toBe(true);
  });
  it("canal que pediu QR (needs_qr) não volta sozinho", () => {
    expect(
      shouldReconnectOnBoot({
        status: "FAILED",
        sessionData: { lastDisconnect: { action: "needs_qr" } },
        credsValue: REGISTERED,
      }),
    ).toBe(false);
  });
});

describe("BaileysManager", () => {
  it("boot reabre o canal pareado que um deploy anterior deixou DISCONNECTED", async () => {
    h.channels = [
      { id: "will", organizationId: "o", status: "DISCONNECTED", sessionData: null },
      { id: "sem-qr", organizationId: "o", status: "DISCONNECTED", sessionData: null },
    ];
    h.creds = [{ channelId: "will", value: REGISTERED }];
    const m = new BaileysManager(fakeLock(new Set(), new Set()));
    await m.startAll();
    expect(h.sessions.map((s) => s.channelId)).toEqual(["will"]);
    expect(h.sessions[0]!.connect).toHaveBeenCalled();
  });

  it("desligar o processo para a sessão sem mudar status e solta a trava", async () => {
    h.channels = [{ id: "will", organizationId: "o", status: "CONNECTED", sessionData: null }];
    h.creds = [{ channelId: "will", value: REGISTERED }];
    const owned = new Set<string>();
    const lock = fakeLock(owned, new Set());
    const m = new BaileysManager(lock);
    await m.startAll();
    await m.shutdownAll();
    expect(h.sessions[0]!.stop).toHaveBeenCalled();
    expect(h.sessions[0]!.disconnect).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledWith("will");
  });

  it("trava com o worker antigo: espera e conecta quando ele solta", async () => {
    h.channels = [{ id: "will", organizationId: "o", status: "CONNECTED", sessionData: null }];
    h.creds = [{ channelId: "will", value: REGISTERED }];
    const other = new Set(["will"]);
    const m = new BaileysManager(fakeLock(new Set(), other));
    await m.startAll();
    expect(h.sessions).toHaveLength(0);
    other.delete("will"); // worker antigo terminou o desligamento
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_RETRY_MS + 1);
    expect(h.sessions).toHaveLength(1);
  });

  it("conectar de novo o mesmo canal não cria segunda sessão", async () => {
    h.channels = [{ id: "will", organizationId: "o", status: "CONNECTED", sessionData: null }];
    const m = new BaileysManager(fakeLock(new Set(), new Set()));
    await m.connect("will");
    await m.connect("will");
    expect(h.sessions).toHaveLength(1);
  });

  it("erro antes de abrir o socket não vira FAILED: tenta de novo", async () => {
    h.channels = [{ id: "will", organizationId: "o", status: "CONNECTED", sessionData: null }];
    h.connectFails = 1;
    const m = new BaileysManager(fakeLock(new Set(), new Set()));
    await m.connect("will");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]!.connect).toHaveBeenCalled();
  });

  it("trava tomada por outro processo: larga a sessão local", async () => {
    h.channels = [{ id: "will", organizationId: "o", status: "CONNECTED", sessionData: null }];
    const owned = new Set<string>();
    const other = new Set<string>();
    const m = new BaileysManager(fakeLock(owned, other));
    await m.connect("will");
    other.add("will");
    await m.renewAll();
    expect(h.sessions[0]!.stop).toHaveBeenCalled();
    expect(m.getSession("will")).toBeUndefined();
  });
});
