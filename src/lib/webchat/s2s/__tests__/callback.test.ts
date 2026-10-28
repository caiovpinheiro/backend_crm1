/**
 * Callback de situação: assinatura (mesma da entrada), bloqueio de SSRF,
 * tentativas com backoff e "uma vez por ref e status".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  refs: [] as {
    id: string;
    ref: string;
    conversationId: string;
    lastCallbackStatus: string | null;
    conversation: { channel: string; channelId: string | null; status: string };
  }[],
  channels: {} as Record<string, unknown>,
}));

function pending(where: Record<string, unknown>, status: string | null): boolean {
  if ("lastCallbackStatus" in where) return status === where.lastCallbackStatus;
  const or = where.OR as { lastCallbackStatus: string | null }[] | undefined;
  return or ? or.some((o) => o.lastCallbackStatus === status) : true;
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    webchatConversationRef: {
      findMany: async ({ where }: { where: Record<string, unknown> & { conversationId: { in: string[] } } }) =>
        m.refs.filter((r) => where.conversationId.in.includes(r.conversationId) && pending(where, r.lastCallbackStatus)),
      updateMany: async ({ where, data }: { where: Record<string, unknown> & { id: string }; data: { lastCallbackStatus: string } }) => {
        const r = m.refs.find((x) => x.id === where.id && pending(where, x.lastCallbackStatus));
        if (!r) return { count: 0 };
        r.lastCallbackStatus = data.lastCallbackStatus;
        return { count: 1 };
      },
    },
    channel: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        m.channels[where.id] ? { config: m.channels[where.id] } : null,
    },
  },
}));

import { SafeFetchError, safeFetch } from "@/lib/safe-fetch";
import {
  deliverWebchatCallback,
  dispatchWebchatCallbacks,
  signedCallbackHeaders,
  WEBCHAT_CALLBACK_BACKOFF_MS,
  WEBCHAT_CALLBACK_TIMEOUT_MS,
} from "@/lib/webchat/s2s/callback";
import { verifyWebchatS2S } from "@/lib/webchat/signatures";

const SECRET = "wcsk_segredo-de-teste";
const URL_OK = "https://hooks.example.test/crm";
const PAYLOAD = { ref: "REF-1", status: "attended" as const, conversation_id: "conv-1" };

type Call = { url: string; init: RequestInit; opts: unknown };

function fakeFetch(statuses: (number | Error)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}, opts: unknown = {}) => {
    calls.push({ url, init, opts });
    const next = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  }) as unknown as typeof safeFetch;
  return { calls, impl };
}

const noSleep = { sleep: vi.fn(async (_ms: number) => {}) };

beforeEach(() => {
  noSleep.sleep.mockClear();
  m.refs = [];
  m.channels = {};
});

describe("assinatura do callback", () => {
  it("o site confere com o mesmo algoritmo da entrada", () => {
    const raw = JSON.stringify(PAYLOAD);
    const now = Date.parse("2026-10-28T12:00:00Z");
    const h = signedCallbackHeaders(SECRET, raw, now);
    expect(h["X-Timestamp"]).toBe(String(now / 1000));
    expect(h["X-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(
      verifyWebchatS2S({ secret: SECRET, timestamp: h["X-Timestamp"]!, signature: h["X-Signature"]!, rawBody: raw, nowMs: now }),
    ).toEqual({ ok: true });
    expect(
      verifyWebchatS2S({ secret: "wcsk_outro", timestamp: h["X-Timestamp"]!, signature: h["X-Signature"]!, rawBody: raw, nowMs: now }).ok,
    ).toBe(false);
  });

  it("envia POST com corpo { ref, status, conversation_id }, timeout 5 s e sem redirect", async () => {
    const f = fakeFetch([204]);
    expect(await deliverWebchatCallback(URL_OK, SECRET, PAYLOAD, { fetchImpl: f.impl, ...noSleep })).toBe(true);
    expect(f.calls).toHaveLength(1);
    const { init, opts } = f.calls[0]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
    const headers = init.headers as Record<string, string>;
    expect(
      verifyWebchatS2S({ secret: SECRET, timestamp: headers["X-Timestamp"]!, signature: headers["X-Signature"]!, rawBody: init.body as string }),
    ).toEqual({ ok: true });
    expect(opts).toEqual({ timeoutMs: WEBCHAT_CALLBACK_TIMEOUT_MS, maxRedirects: 0 });
  });
});

describe("entrega", () => {
  it("3 tentativas com backoff em erro de rede / não-2xx", async () => {
    const f = fakeFetch([new Error("ECONNRESET"), 503, 500]);
    expect(await deliverWebchatCallback(URL_OK, SECRET, PAYLOAD, { fetchImpl: f.impl, ...noSleep })).toBe(false);
    expect(f.calls).toHaveLength(3);
    expect(noSleep.sleep.mock.calls.map((c) => c[0])).toEqual([...WEBCHAT_CALLBACK_BACKOFF_MS]);
  });

  it("para na primeira tentativa que dá certo", async () => {
    const f = fakeFetch([502, 200]);
    expect(await deliverWebchatCallback(URL_OK, SECRET, PAYLOAD, { fetchImpl: f.impl, ...noSleep })).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("SSRF: destino interno/privado é bloqueado pelo safeFetch real, sem repetir", async () => {
    for (const url of [
      "https://127.0.0.1/cb",
      "https://10.0.0.5/cb",
      "https://169.254.169.254/latest",
      "https://[::1]/cb",
      "https://localhost/cb",
      "https://servico.internal/cb",
    ]) {
      expect(await deliverWebchatCallback(url, SECRET, PAYLOAD, noSleep)).toBe(false);
    }
    expect(noSleep.sleep).not.toHaveBeenCalled();
    await expect(safeFetch("https://192.168.0.10/cb", { method: "POST" })).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("http (não https) nunca é chamado", async () => {
    const f = fakeFetch([200]);
    expect(await deliverWebchatCallback("http://hooks.example.test/x", SECRET, PAYLOAD, { fetchImpl: f.impl, ...noSleep })).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe("despacho por ref", () => {
  function setup() {
    m.channels["ch-1"] = { s2sSecret: SECRET, v2: { s2s: { callbackUrl: URL_OK } } };
    m.refs = [
      { id: "r1", ref: "REF-1", conversationId: "conv-1", lastCallbackStatus: null, conversation: { channel: "webchat", channelId: "ch-1", status: "OPEN" } },
      { id: "r2", ref: "REF-2", conversationId: "conv-1", lastCallbackStatus: null, conversation: { channel: "webchat", channelId: "ch-1", status: "OPEN" } },
    ];
  }

  it("attended sai uma vez por ref; repetir não reenvia", async () => {
    setup();
    const f = fakeFetch([200]);
    expect(await dispatchWebchatCallbacks(["conv-1"], "attended", { fetchImpl: f.impl, ...noSleep })).toBe(2);
    expect(f.calls.map((c) => JSON.parse(c.init.body as string))).toEqual([
      { ref: "REF-1", status: "attended", conversation_id: "conv-1" },
      { ref: "REF-2", status: "attended", conversation_id: "conv-1" },
    ]);
    expect(await dispatchWebchatCallbacks(["conv-1"], "attended", { fetchImpl: f.impl, ...noSleep })).toBe(0);
    expect(f.calls).toHaveLength(2);
  });

  it("resolved só com a conversa encerrada de fato, e uma vez", async () => {
    setup();
    const f = fakeFetch([200]);
    expect(await dispatchWebchatCallbacks(["conv-1"], "resolved", { fetchImpl: f.impl, ...noSleep })).toBe(0);
    for (const r of m.refs) r.conversation.status = "RESOLVED";
    m.refs[0]!.lastCallbackStatus = "attended";
    expect(await dispatchWebchatCallbacks(["conv-1"], "resolved", { fetchImpl: f.impl, ...noSleep })).toBe(2);
    expect(await dispatchWebchatCallbacks(["conv-1"], "resolved", { fetchImpl: f.impl, ...noSleep })).toBe(0);
    expect(f.calls).toHaveLength(2);
  });

  it("sem callbackUrl ou sem segredo: nada sai e nada é marcado", async () => {
    setup();
    m.channels["ch-1"] = { v2: { s2s: { callbackUrl: URL_OK } } };
    const f = fakeFetch([200]);
    expect(await dispatchWebchatCallbacks(["conv-1"], "attended", { fetchImpl: f.impl, ...noSleep })).toBe(0);
    m.channels["ch-1"] = { s2sSecret: SECRET };
    expect(await dispatchWebchatCallbacks(["conv-1"], "attended", { fetchImpl: f.impl, ...noSleep })).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(m.refs.every((r) => r.lastCallbackStatus === null)).toBe(true);
  });

  it("conversa de outro canal (não webchat) é ignorada", async () => {
    setup();
    for (const r of m.refs) r.conversation.channel = "whatsapp";
    const f = fakeFetch([200]);
    expect(await dispatchWebchatCallbacks(["conv-1"], "attended", { fetchImpl: f.impl, ...noSleep })).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
});
