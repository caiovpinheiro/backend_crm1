/**
 * "digitando…" do contato (Baileys): política de assinatura de presença e
 * publicação do `typing` — socket falso, relógio falso, sem Redis/DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publish, prismaCalls, countingClient } = vi.hoisted(() => {
  const prismaCalls = { count: 0 };
  // Qualquer `prisma.<model>.<op>()` (ou `$queryRaw` etc.) conta.
  const countingClient = () =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string" || prop === "then") return undefined;
          if (prop.startsWith("$")) {
            return () => {
              prismaCalls.count++;
              return Promise.resolve(null);
            };
          }
          return new Proxy(
            {},
            {
              get(_m, op) {
                if (typeof op !== "string" || op === "then") return undefined;
                return () => {
                  prismaCalls.count++;
                  return Promise.resolve(null);
                };
              },
            },
          );
        },
      },
    );
  return { publish: vi.fn(), prismaCalls, countingClient };
});

vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish } }));
vi.mock("@/lib/prisma", () => ({ prisma: countingClient() }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: countingClient() }));

import { __resetTypingThrottleForTests, TYPING_TTL_MS } from "@/lib/realtime-events";
import {
  __resetContactTypingForTests,
  attachContactTyping,
  ContactTypingTracker,
  detachContactTyping,
  noteContactActivity,
  readContactTypingConfig,
  type ContactTypingConfig,
  type ContactTypingSocket,
} from "./contact-typing";
import { clearChannelMap, registerLidMapping } from "./lid-resolver";

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const CHANNEL = "ch_1";

type PresenceUpdate = {
  id: string;
  presences: Record<string, { lastKnownPresence: string }>;
};

function fakeSocket() {
  const handlers = new Map<string, Array<(arg: unknown) => void>>();
  const presenceSubscribe = vi.fn((_jid: string) => Promise.resolve());
  const sock = {
    ev: {
      on: (event: string, fn: (arg: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      },
    },
    presenceSubscribe,
  };
  return {
    sock: sock as unknown as ContactTypingSocket,
    presenceSubscribe,
    listenerCount: (event: string) => handlers.get(event)?.length ?? 0,
    emitPresence: (jid: string, state: string, participant = jid) => {
      const update: PresenceUpdate = {
        id: jid,
        presences: { [participant]: { lastKnownPresence: state } },
      };
      for (const fn of handlers.get("presence.update") ?? []) fn(update);
    },
  };
}

const config = (over: Partial<ContactTypingConfig> = {}): ContactTypingConfig => ({
  enabled: true,
  ttlMs: 10 * 60_000,
  maxSubscriptions: 50,
  maxSubscribesPerMinute: 10,
  ...over,
});

const jidOf = (n: number) => `55119${String(n).padStart(8, "0")}@s.whatsapp.net`;

const activity = (n: number, over: Record<string, unknown> = {}) => ({
  jid: jidOf(n),
  organizationId: "org_1",
  conversationId: `conv_${n}`,
  contactId: `contact_${n}`,
  conversationStatus: "OPEN",
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  publish.mockReset();
  prismaCalls.count = 0;
  __resetTypingThrottleForTests();
  __resetContactTypingForTests();
  clearChannelMap(CHANNEL);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readContactTypingConfig", () => {
  it("default ligado e conservador; `0` desliga", () => {
    expect(readContactTypingConfig({})).toEqual({
      enabled: true,
      ttlMs: 600_000,
      maxSubscriptions: 50,
      maxSubscribesPerMinute: 10,
    });
    for (const off of ["0", "false", "off", " OFF "]) {
      expect(readContactTypingConfig({ BAILEYS_CONTACT_TYPING: off }).enabled).toBe(false);
    }
    expect(readContactTypingConfig({ BAILEYS_CONTACT_TYPING: "1" }).enabled).toBe(true);
  });

  it("lê os limites da env e prende em faixas seguras", () => {
    expect(
      readContactTypingConfig({
        BAILEYS_CONTACT_TYPING_TTL_MS: "120000",
        BAILEYS_CONTACT_TYPING_MAX_SUBSCRIPTIONS: "20",
        BAILEYS_CONTACT_TYPING_MAX_SUBSCRIBES_PER_MIN: "5",
      }),
    ).toMatchObject({ ttlMs: 120_000, maxSubscriptions: 20, maxSubscribesPerMinute: 5 });
    expect(
      readContactTypingConfig({
        BAILEYS_CONTACT_TYPING_TTL_MS: "1",
        BAILEYS_CONTACT_TYPING_MAX_SUBSCRIPTIONS: "999999",
        BAILEYS_CONTACT_TYPING_MAX_SUBSCRIBES_PER_MIN: "abc",
      }),
    ).toMatchObject({ ttlMs: 30_000, maxSubscriptions: 500, maxSubscribesPerMinute: 10 });
  });
});

describe("assinatura de presença", () => {
  it("não assina nada ao ligar no socket (nunca em massa na conexão)", () => {
    const s = fakeSocket();
    new ContactTypingTracker(CHANNEL, config()).attach(s.sock);
    expect(s.listenerCount("presence.update")).toBe(1);
    expect(s.presenceSubscribe).not.toHaveBeenCalled();
  });

  it("assina só o JID de conversa ABERTA com mensagem recente; renovar não reassina", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);

    expect(tracker.noteActivity(activity(1))).toBe("subscribed");
    expect(s.presenceSubscribe).toHaveBeenCalledTimes(1);
    expect(s.presenceSubscribe).toHaveBeenCalledWith(jidOf(1));

    vi.advanceTimersByTime(60_000);
    expect(tracker.noteActivity(activity(1))).toBe("renewed");
    expect(s.presenceSubscribe).toHaveBeenCalledTimes(1);

    for (const status of ["RESOLVED", "PENDING", "SNOOZED"]) {
      expect(tracker.noteActivity(activity(2, { conversationStatus: status }))).toBe("not_open");
    }
    expect(s.presenceSubscribe).toHaveBeenCalledTimes(1);
    expect(tracker.size).toBe(1);
  });

  it("conversa que deixou de estar aberta derruba o registro do JID", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    tracker.noteActivity(activity(1));
    expect(tracker.noteActivity(activity(1, { conversationStatus: "RESOLVED" }))).toBe("not_open");
    expect(tracker.size).toBe(0);
    s.emitPresence(jidOf(1), "composing");
    expect(publish).not.toHaveBeenCalled();
  });

  it("envio frio do CRM (contato nunca escreveu no ticket) não assina; resposta assina", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(tracker.noteActivity(activity(n, { contactHasWritten: false }))).toBe("cold");
    }
    expect(s.presenceSubscribe).not.toHaveBeenCalled();
    expect(tracker.size).toBe(0);
    expect(tracker.noteActivity(activity(1, { contactHasWritten: true }))).toBe("subscribed");
    expect(s.presenceSubscribe).toHaveBeenCalledTimes(1);
  });

  it("grupo, broadcast e newsletter são ignorados", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    for (const jid of ["12036@g.us", "status@broadcast", "123@newsletter", ""]) {
      expect(tracker.noteActivity(activity(1, { jid }))).toBe("ignored");
    }
    expect(s.presenceSubscribe).not.toHaveBeenCalled();

    tracker.noteActivity(activity(1));
    s.emitPresence("12036@g.us", "composing", jidOf(1));
    expect(publish).not.toHaveBeenCalled();
  });

  it("teto de JIDs vivos por sessão: cheio não assina; vaga expirada libera", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(
      CHANNEL,
      config({ maxSubscriptions: 3, maxSubscribesPerMinute: 60, ttlMs: 60_000 }),
    );
    tracker.attach(s.sock);
    for (const n of [1, 2, 3]) expect(tracker.noteActivity(activity(n))).toBe("subscribed");
    expect(tracker.noteActivity(activity(4))).toBe("cap");
    expect(s.presenceSubscribe).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(59_000);
    expect(tracker.noteActivity(activity(4))).toBe("cap");
    // Os vivos não são derrubados pelo teto e seguem renováveis.
    expect(tracker.noteActivity(activity(1))).toBe("renewed");
    vi.advanceTimersByTime(1_000); // 2 e 3 expiraram; 1 foi renovado
    expect(tracker.noteActivity(activity(4))).toBe("subscribed");
    expect(tracker.size).toBe(2);
    expect(s.presenceSubscribe).toHaveBeenCalledTimes(4);
  });

  it("TTL: sem mensagem nova a presença do JID deixa de publicar; mensagem nova reassina", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config({ ttlMs: 60_000 }));
    tracker.attach(s.sock);
    tracker.noteActivity(activity(1));

    vi.advanceTimersByTime(59_999);
    s.emitPresence(jidOf(1), "composing");
    expect(publish).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    s.emitPresence(jidOf(1), "composing");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(tracker.size).toBe(0);

    expect(tracker.noteActivity(activity(1))).toBe("subscribed");
    expect(s.presenceSubscribe).toHaveBeenCalledTimes(2);
  });

  it("ritmo: no máximo N assinaturas por minuto por sessão", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config({ maxSubscribesPerMinute: 2 }));
    tracker.attach(s.sock);
    expect(tracker.noteActivity(activity(1))).toBe("subscribed");
    expect(tracker.noteActivity(activity(2))).toBe("subscribed");
    expect(tracker.noteActivity(activity(3))).toBe("rate");
    expect(tracker.size).toBe(2);
    vi.advanceTimersByTime(60_000);
    expect(tracker.noteActivity(activity(3))).toBe("subscribed");
    expect(s.presenceSubscribe).toHaveBeenCalledTimes(3);
  });

  it("falha do presenceSubscribe solta a vaga", async () => {
    const s = fakeSocket();
    s.presenceSubscribe.mockRejectedValueOnce(new Error("socket fechado"));
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    expect(tracker.noteActivity(activity(1))).toBe("subscribed");
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.size).toBe(0);
  });

  it("socket novo (reconexão) zera a tabela e não reassina em massa", () => {
    const a = fakeSocket();
    const b = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(a.sock);
    tracker.noteActivity(activity(1));
    tracker.noteActivity(activity(2));

    tracker.attach(b.sock);
    expect(tracker.size).toBe(0);
    expect(b.presenceSubscribe).not.toHaveBeenCalled();
    // Listener do socket antigo não publica mais.
    tracker.noteActivity(activity(1));
    a.emitPresence(jidOf(1), "composing");
    expect(publish).not.toHaveBeenCalled();
    b.emitPresence(jidOf(1), "composing");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("interruptor desligado: não registra listener, não assina, não publica", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config({ enabled: false }));
    tracker.attach(s.sock);
    expect(s.listenerCount("presence.update")).toBe(0);
    expect(tracker.noteActivity(activity(1))).toBe("disabled");
    expect(s.presenceSubscribe).not.toHaveBeenCalled();
    expect(
      tracker.handlePresenceUpdate({
        id: jidOf(1),
        presences: { [jidOf(1)]: { lastKnownPresence: "composing" } },
      }),
    ).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(tracker.size).toBe(0);
  });
});

describe("presença → evento `typing` do contato", () => {
  it("`composing` vira `typing` do contato uma vez por janela de 3s", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    tracker.noteActivity(activity(1));

    s.emitPresence(jidOf(1), "composing");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("typing", {
      organizationId: "org_1",
      conversationId: "conv_1",
      contactId: "contact_1",
      userId: null,
      userName: null,
      source: "contact",
      until: new Date(T0 + TYPING_TTL_MS).toISOString(),
    });

    vi.advanceTimersByTime(1_000);
    s.emitPresence(jidOf(1), "composing");
    vi.advanceTimersByTime(1_999);
    s.emitPresence(jidOf(1), "recording");
    expect(publish).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1); // 3 000 ms exatos
    s.emitPresence(jidOf(1), "recording");
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][1]).toMatchObject({
      source: "contact",
      until: new Date(T0 + 3_000 + TYPING_TTL_MS).toISOString(),
    });
  });

  it("`paused`, `available` e `unavailable` não publicam", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    tracker.noteActivity(activity(1));
    for (const state of ["paused", "available", "unavailable"]) {
      s.emitPresence(jidOf(1), state);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("JID sem registro (não assinado por nós) não publica", () => {
    const s = fakeSocket();
    new ContactTypingTracker(CHANNEL, config()).attach(s.sock);
    s.emitPresence(jidOf(9), "composing");
    expect(publish).not.toHaveBeenCalled();
  });

  it("sufixo de aparelho no JID casa com o registro", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    tracker.noteActivity(activity(1));
    s.emitPresence(jidOf(1).replace("@", ":7@"), "composing");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("LID: registro pelo LID com telefone resolvido casa presença por qualquer um dos dois", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    const lid = "139620998221871@lid";
    expect(tracker.noteActivity(activity(1, { jid: lid, resolvedJid: jidOf(1) }))).toBe(
      "subscribed",
    );
    // Assina pelo JID em que a mensagem veio.
    expect(s.presenceSubscribe).toHaveBeenCalledWith(lid);

    s.emitPresence(lid, "composing");
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_000);
    s.emitPresence(jidOf(1), "composing");
    expect(publish).toHaveBeenCalledTimes(2);
    // Mensagem seguinte já com o telefone: mesmo registro, sem reassinar.
    expect(tracker.noteActivity(activity(1))).toBe("renewed");
    expect(tracker.size).toBe(1);
  });

  it("LID: registro pelo telefone e presença pelo LID resolve pelo lid-resolver em memória", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    tracker.noteActivity(activity(1));
    const lid = "139620998221871@lid";

    s.emitPresence(lid, "composing");
    expect(publish).not.toHaveBeenCalled(); // LID ainda desconhecido

    registerLidMapping(CHANNEL, lid, jidOf(1)); // persiste em background
    prismaCalls.count = 0;
    s.emitPresence(lid, "composing");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][1]).toMatchObject({ conversationId: "conv_1" });
  });

  it("o contato tem janela de throttle própria (não disputa com agente)", async () => {
    const { publishTypingEvent } = await import("@/lib/realtime-events");
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    tracker.noteActivity(activity(1));

    expect(
      publishTypingEvent({
        organizationId: "org_1",
        conversationId: "conv_1",
        contactId: "contact_1",
        userId: "user_a",
        userName: "Ana",
      }),
    ).toBe(true);
    s.emitPresence(jidOf(1), "composing");
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map((c) => (c[1] as { source: string }).source)).toEqual([
      "agent",
      "contact",
    ]);
  });

  it("privacidade: o payload leva só ids — nada de nome, telefone ou JID", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    tracker.noteActivity(activity(1));
    s.emitPresence(jidOf(1), "composing");
    const payload = publish.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["contactId", "conversationId", "organizationId", "source", "until", "userId", "userName"].sort(),
    );
    expect(payload.userName).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(jidOf(1).split("@")[0]);
  });

  it("caminho quente sem Prisma: assinar, renovar e N presenças = 0 consultas", () => {
    const s = fakeSocket();
    const tracker = new ContactTypingTracker(CHANNEL, config());
    tracker.attach(s.sock);
    for (const n of [1, 2, 3]) tracker.noteActivity(activity(n));
    tracker.noteActivity(activity(1));
    for (let i = 0; i < 30; i++) {
      for (const n of [1, 2, 3, 4]) {
        s.emitPresence(jidOf(n), i % 2 ? "composing" : "paused");
      }
      vi.advanceTimersByTime(1_000);
    }
    expect(publish.mock.calls.length).toBeGreaterThan(3);
    expect(prismaCalls.count).toBe(0);
  });
});

describe("registro por canal", () => {
  it("noteContactActivity sem sessão ligada é no-op", () => {
    expect(noteContactActivity("ch_x", activity(1))).toBe("disabled");
  });

  it("attach → atividade → presença; detach para de publicar", () => {
    const s = fakeSocket();
    attachContactTyping(CHANNEL, s.sock);
    expect(noteContactActivity(CHANNEL, activity(1))).toBe("subscribed");
    expect(noteContactActivity("ch_outro", activity(1))).toBe("disabled");
    s.emitPresence(jidOf(1), "composing");
    expect(publish).toHaveBeenCalledTimes(1);

    detachContactTyping(CHANNEL);
    vi.advanceTimersByTime(3_000);
    s.emitPresence(jidOf(1), "composing");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(noteContactActivity(CHANNEL, activity(1))).toBe("disabled");
  });
});
