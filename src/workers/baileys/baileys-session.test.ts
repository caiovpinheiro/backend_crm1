/**
 * BaileysSession: reconexão sem limite, um socket por vez, desligamento
 * sem mudar status e motivo da queda gravado. Socket falso, sem WhatsApp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Boom } from "@hapi/boom";

type Handler = (arg: unknown) => void;
const h = vi.hoisted(() => ({
  sockets: [] as Array<{
    handlers: Map<string, Handler[]>;
    removed: string[];
    ended: boolean;
    user: unknown;
    emit: (ev: string, arg: unknown) => void;
  }>,
  channelUpdates: [] as Array<Record<string, unknown>>,
  authDeletes: 0,
  creds: {} as Record<string, unknown>,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@whiskeysockets/baileys", () => ({
  default: () => {
    const handlers = new Map<string, Handler[]>();
    const sock = {
      handlers,
      removed: [] as string[],
      ended: false,
      user: null as unknown,
      ev: {
        on: (ev: string, fn: Handler) => handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
        off: () => {},
        removeAllListeners: (ev: string) => {
          sock.removed.push(ev);
          handlers.delete(ev);
        },
      },
      end: () => {
        sock.ended = true;
      },
      emit: (ev: string, arg: unknown) => {
        for (const fn of handlers.get(ev) ?? []) fn(arg);
      },
    };
    h.sockets.push(sock);
    return sock;
  },
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
  isJidGroup: () => false,
  makeCacheableSignalKeyStore: (k: unknown) => k,
}));
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:qr" } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.channelUpdates.push(data);
        return {};
      }),
      findUnique: vi.fn(async () => ({ sessionData: { outro: 1 } })),
    },
    baileysAuthKey: {
      deleteMany: vi.fn(async () => {
        h.authDeletes++;
        return { count: 1 };
      }),
    },
  },
}));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { channel: { findUnique: vi.fn(async () => ({ organizationId: "org1" })) } },
}));
vi.mock("@/lib/webhook-context", () => ({ withSystemContext: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/cache/response-families", () => ({
  bumpResponseFamilies: vi.fn(async () => {}),
  RESPONSE_FAMILIES: { channels: "channels" },
}));
vi.mock("@/lib/realtime-events", () => ({ publishChannelUpdated: vi.fn(), publishMessageStatus: vi.fn() }));
vi.mock("./auth-state-postgres", () => ({
  usePostgresAuthState: async () => ({ state: { creds: h.creds, keys: {} }, saveCreds: vi.fn(async () => {}) }),
  credsAreRegistered: (c: { me?: { id?: string } } | null) => Boolean(c?.me?.id),
}));
vi.mock("./message-handler", () => ({ handleBaileysMessage: vi.fn() }));
vi.mock("./sync-groups", () => ({ snapshotFromMeta: vi.fn() }));
vi.mock("@/services/whatsapp-groups", () => ({ upsertChannelGroupSnapshots: vi.fn() }));
vi.mock("./lid-resolver", () => ({
  registerLidMapping: vi.fn(),
  getMapSize: () => 0,
  clearChannelMap: vi.fn(),
  loadPersistedMappings: async () => 0,
  fixLidContacts: async () => 0,
}));
vi.mock("./contact-typing", () => ({ attachContactTyping: vi.fn(), detachContactTyping: vi.fn() }));
vi.mock("@/lib/cache/message-versions", () => ({ noteMessageChange: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueBaileysControl: vi.fn(async () => {}) }));

import { BaileysSession } from "./baileys-session";

function closeWith(code: number | undefined) {
  const sock = h.sockets.at(-1)!;
  const error = code === undefined ? new Error("socket hang up") : new Boom("x", { statusCode: code });
  sock.emit("connection.update", { connection: "close", lastDisconnect: { error } });
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

const statuses = () => h.channelUpdates.map((u) => u.status).filter(Boolean);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  h.sockets = [];
  h.channelUpdates = [];
  h.authDeletes = 0;
  h.creds = { me: { id: "5511944690752:5@s.whatsapp.net" } };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BaileysSession — reconexão", () => {
  it("não desiste depois de 8 quedas: continua reconectando e nunca vira FAILED", async () => {
    const s = new BaileysSession("ch1");
    await s.connect();
    for (let i = 0; i < 12; i++) {
      closeWith(428);
      await flush();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await flush();
    }
    expect(h.sockets.length).toBe(13);
    expect(statuses()).not.toContain("FAILED");
  });

  it("reconectar fecha o socket anterior e remove os listeners dele", async () => {
    const s = new BaileysSession("ch1");
    await s.connect();
    const first = h.sockets[0]!;
    closeWith(428);
    await flush();
    await vi.advanceTimersByTimeAsync(2_001);
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(first.removed).toContain("connection.update");
    expect(first.removed).toContain("messages.upsert");
  });

  it("evento atrasado do socket antigo é ignorado", async () => {
    const s = new BaileysSession("ch1");
    await s.connect();
    const first = h.sockets[0]!;
    const firstConnHandlers = [...(first.handlers.get("connection.update") ?? [])];
    closeWith(428);
    await flush();
    await vi.advanceTimersByTimeAsync(2_001);
    await flush();
    const before = h.channelUpdates.length;
    for (const fn of firstConnHandlers) fn({ connection: "close", lastDisconnect: { error: new Boom("x", { statusCode: 428 }) } });
    await flush();
    expect(h.channelUpdates.length).toBe(before);
  });

  it("deslogado no celular (401) apaga as credenciais e fica DISCONNECTED", async () => {
    const s = new BaileysSession("ch1");
    await s.connect();
    closeWith(401);
    await flush();
    expect(h.authDeletes).toBe(1);
    expect(statuses().at(-1)).toBe("DISCONNECTED");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("grava o motivo da queda em sessionData.lastDisconnect, preservando o resto", async () => {
    const s = new BaileysSession("ch1");
    await s.connect();
    closeWith(440);
    await flush();
    const withLast = h.channelUpdates.find((u) => u.sessionData);
    expect(withLast?.sessionData).toMatchObject({
      outro: 1,
      lastDisconnect: { statusCode: 440, reason: "connectionReplaced", action: "retry", attempt: 1 },
    });
  });

  it("conexão substituída e a trava é de outro processo: não reconecta e avisa o manager", async () => {
    const onLostOwnership = vi.fn();
    const s = new BaileysSession("ch1", { stillOwner: async () => false, onLostOwnership });
    await s.connect();
    closeWith(440);
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(onLostOwnership).toHaveBeenCalled();
    expect(h.sockets).toHaveLength(1);
  });
});

describe("BaileysSession — ainda sem parear (QR)", () => {
  it("QR não lido: fecha e fica DISCONNECTED, sem gerar QR para sempre", async () => {
    h.creds = {};
    const s = new BaileysSession("ch1");
    await s.connect();
    closeWith(408);
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sockets).toHaveLength(1);
    expect(statuses().at(-1)).toBe("DISCONNECTED");
  });

  it("515 logo depois de ler o QR reconecta na hora", async () => {
    h.creds = {};
    const s = new BaileysSession("ch1");
    await s.connect();
    h.creds.me = { id: "5511944690752:5@s.whatsapp.net" }; // pareou
    closeWith(515);
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.sockets).toHaveLength(2);
  });
});

describe("BaileysSession — pedir conectar com a sessão aberta", () => {
  it("regrava CONNECTED (a rota tinha gravado CONNECTING)", async () => {
    const s = new BaileysSession("ch1");
    await s.connect();
    h.sockets[0]!.user = { id: "5511944690752:5@s.whatsapp.net" };
    expect(await s.reaffirmConnected()).toBe(true);
    expect(statuses().at(-1)).toBe("CONNECTED");
  });

  it("socket ainda em handshake: não mexe", async () => {
    const s = new BaileysSession("ch1");
    await s.connect();
    expect(await s.reaffirmConnected()).toBe(false);
  });
});

describe("BaileysSession — desligamento do processo", () => {
  it("stop() fecha o socket sem mudar o status nem reconectar", async () => {
    const s = new BaileysSession("ch1");
    await s.connect();
    const before = h.channelUpdates.length;
    await s.stop();
    closeWith(428); // o end() do socket dispara close
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.channelUpdates.length).toBe(before);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.ended).toBe(true);
  });

  it("stop() cancela uma reconexão agendada", async () => {
    const s = new BaileysSession("ch1");
    await s.connect();
    closeWith(428);
    await flush();
    await s.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sockets).toHaveLength(1);
  });
});
