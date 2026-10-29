/**
 * `POST /api/public/webchat/s2s/{publicKey}`: assinatura (válida, inválida,
 * ausente, de outro canal), timestamp vencido, chave de idempotência,
 * corpo, repetição idempotente e isolamento de org. Banco e efeito
 * (ingress) mockados — a lógica do efeito tem testes próprios.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    logger,
    prismaBase: { channel: { findUnique: vi.fn() } },
    prisma: { channel: { findFirst: vi.fn() } },
    orgCalls: [] as string[],
    process: vi.fn(),
    claim: vi.fn(),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: mocks.prismaBase }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/cache/keys", () => ({
  wrapChannelLookup: (_k: string, _t: number, loader: () => Promise<unknown>) => loader(),
}));
vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: async (orgId: string, fn: () => Promise<unknown>) => {
    mocks.orgCalls.push(orgId);
    return fn();
  },
}));
vi.mock("@/lib/webchat/s2s/ingress", () => ({
  processWebchatS2SIngress: mocks.process,
  webchatConversationUrl: async (_org: string, n: number) => `https://acme.example.test/inbox?c=${n}`,
}));
vi.mock("@/lib/webchat/s2s/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/webchat/s2s/idempotency")>()),
  claimIdempotencyKey: mocks.claim,
  completeIdempotencyKey: mocks.complete,
  failIdempotencyKey: mocks.fail,
  maybePurgeExpiredIngressKeys: async () => {},
}));

import { POST } from "@/app/api/public/webchat/s2s/[publicKey]/route";
import { resetRateLimitersForTests } from "@/lib/rate-limit";
import { hashS2SBody } from "@/lib/webchat/s2s/idempotency";
import { signWebchatS2S } from "@/lib/webchat/signatures";

const KEY_A = "wc_AAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "wc_BBBBBBBBBBBBBBBBBBBBBBBB";
const SECRET_A = "wcsk_segredo-do-canal-a";
const SECRET_B = "wcsk_segredo-do-canal-b";

function channelRow(id: string, org: string, key: string) {
  return {
    id,
    organizationId: org,
    name: "Site",
    publicKey: key,
    provider: "WEBCHAT",
    status: "CONNECTED",
    defaultPipelineId: null,
    config: { allowedOrigins: [] },
    organization: { status: "ACTIVE", primaryColor: null, logoUrl: null },
  };
}

const SECRETS: Record<string, string | undefined> = { "ch-a": SECRET_A, "ch-b": SECRET_B };

function nowSec() {
  return String(Math.floor(Date.now() / 1000));
}

function req(
  key: string,
  body: unknown,
  opts: { secret?: string | null; ts?: string; idem?: string | null; signature?: string } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const ts = opts.ts ?? nowSec();
  const headers: Record<string, string> = { "content-type": "application/json", "x-timestamp": ts };
  if (opts.signature !== undefined) headers["x-signature"] = opts.signature;
  else if (opts.secret !== null) headers["x-signature"] = signWebchatS2S(opts.secret ?? SECRET_A, ts, raw);
  if (opts.idem !== null) headers["idempotency-key"] = opts.idem ?? "idem-1";
  return [
    new Request(`https://api.example.test/api/public/webchat/s2s/${key}`, { method: "POST", headers, body: raw }),
    { params: Promise.resolve({ publicKey: key }) },
  ] as const;
}

const BODY = { external_id: "ext-1", ref: "REF-1", text: "Precisa de ajuda na etapa 2", fields: { etapa: "2" } };

beforeEach(() => {
  resetRateLimitersForTests();
  mocks.orgCalls.length = 0;
  mocks.process.mockReset();
  mocks.claim.mockReset();
  mocks.complete.mockClear();
  mocks.fail.mockClear();
  mocks.prismaBase.channel.findUnique.mockImplementation(async ({ where }: { where: { publicKey: string } }) => {
    if (where.publicKey === KEY_A) return channelRow("ch-a", "org-a", KEY_A);
    if (where.publicKey === KEY_B) return channelRow("ch-b", "org-b", KEY_B);
    return null;
  });
  mocks.prisma.channel.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const s = SECRETS[where.id];
    return { config: s ? { s2sSecret: s } : {} };
  });
  mocks.claim.mockResolvedValue({ kind: "claimed", id: "ik-1" });
  mocks.process.mockResolvedValue({
    conversationId: "conv-1",
    conversationNumber: 42,
    contactId: "ct-1",
    contactCreated: false,
    conversationCreated: false,
    noteId: "msg-1",
  });
});

describe("POST /api/public/webchat/s2s/{publicKey}", () => {
  it("assinatura válida → 200 { conversation_id, url }", async () => {
    const res = await POST(...req(KEY_A, BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversation_id: "conv-1", url: "https://acme.example.test/inbox?c=42" });
    expect(mocks.process).toHaveBeenCalledTimes(1);
    const [channel, request] = mocks.process.mock.calls[0]!;
    expect(channel.id).toBe("ch-a");
    expect(request).toMatchObject({ externalId: "ext-1", ref: "REF-1", fields: { etapa: "2" } });
    expect(mocks.complete).toHaveBeenCalledWith("ik-1", { conversation_id: "conv-1", url: "https://acme.example.test/inbox?c=42" });
    const claimArg = mocks.claim.mock.calls[0]![0];
    expect(claimArg).toMatchObject({ channelId: "ch-a", key: "idem-1", requestHash: hashS2SBody(JSON.stringify(BODY)) });
  });

  it("assinatura inválida → 401 SIGNATURE_INVALID, nada processado", async () => {
    const res = await POST(...req(KEY_A, BODY, { signature: `sha256=${"0".repeat(64)}` }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("SIGNATURE_INVALID");
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("assinatura ausente → 401 SIGNATURE_INVALID", async () => {
    const res = await POST(...req(KEY_A, BODY, { secret: null }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("SIGNATURE_INVALID");
  });

  it("corpo alterado depois de assinado → 401", async () => {
    const ts = nowSec();
    const sig = signWebchatS2S(SECRET_A, ts, JSON.stringify(BODY));
    const res = await POST(...req(KEY_A, { ...BODY, text: "outro" }, { ts, signature: sig }));
    expect(res.status).toBe(401);
  });

  it("timestamp com mais de 5 min → 401 TIMESTAMP_EXPIRED", async () => {
    const old = String(Math.floor(Date.now() / 1000) - 301);
    const res = await POST(...req(KEY_A, BODY, { ts: old }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("TIMESTAMP_EXPIRED");
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("canal sem segredo S2S → 403 S2S_NOT_CONFIGURED", async () => {
    SECRETS["ch-a"] = undefined;
    try {
      const res = await POST(...req(KEY_A, BODY));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("S2S_NOT_CONFIGURED");
    } finally {
      SECRETS["ch-a"] = SECRET_A;
    }
  });

  it("chave pública desconhecida → 404 CHANNEL_NOT_FOUND", async () => {
    const res = await POST(...req("wc_ZZZZZZZZZZZZZZZZZZZZZZZZ", BODY));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("CHANNEL_NOT_FOUND");
  });

  it("Idempotency-Key ausente ou inválida → 400", async () => {
    let res = await POST(...req(KEY_A, BODY, { idem: null }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_INVALID");
    res = await POST(...req(KEY_A, BODY, { idem: "tem espaço" }));
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("corpo sem text nem fields / JSON inválido → 400", async () => {
    let res = await POST(...req(KEY_A, { external_id: "ext-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BODY");
    res = await POST(...req(KEY_A, "{nao-json"));
    expect((await res.json()).code).toBe("INVALID_JSON");
  });

  it("corpo acima de 32 KB → 413", async () => {
    const res = await POST(...req(KEY_A, { ...BODY, text: "x".repeat(40_000) }));
    expect(res.status).toBe(413);
  });

  it("mesma chave e mesmo corpo → mesmo 200 com Idempotent-Replayed, sem reprocessar", async () => {
    mocks.claim.mockResolvedValueOnce({
      kind: "replay",
      response: { conversation_id: "conv-1", url: "https://acme.example.test/inbox?c=42" },
    });
    const res = await POST(...req(KEY_A, BODY));
    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await res.json()).toEqual({ conversation_id: "conv-1", url: "https://acme.example.test/inbox?c=42" });
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("mesma chave com outro corpo → 409; ainda processando → 409 com Retry-After", async () => {
    mocks.claim.mockResolvedValueOnce({ kind: "reused" });
    let res = await POST(...req(KEY_A, BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
    mocks.claim.mockResolvedValueOnce({ kind: "in_progress" });
    res = await POST(...req(KEY_A, BODY));
    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect((await res.json()).code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("falha no processamento → 500 e a chave fica retomável", async () => {
    mocks.process.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(...req(KEY_A, BODY));
    expect(res.status).toBe(500);
    expect(mocks.fail).toHaveBeenCalledWith("ik-1");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("pedido sem assinatura não gasta a cota do canal (300/min)", async () => {
    for (let i = 0; i < 305; i++) {
      const res = await POST(...req(KEY_A, BODY, { secret: null }));
      expect(res.status).toBe(401);
    }
    const ok = await POST(...req(KEY_A, BODY));
    expect(ok.status).toBe(200);
  });

  describe("isolamento de org", () => {
    it("assinado com o segredo do canal B na chave do canal A → 401", async () => {
      const res = await POST(...req(KEY_A, BODY, { secret: SECRET_B }));
      expect(res.status).toBe(401);
      expect(mocks.process).not.toHaveBeenCalled();
    });

    it("tudo roda no contexto da org dona da chave", async () => {
      const res = await POST(...req(KEY_B, BODY, { secret: SECRET_B }));
      expect(res.status).toBe(200);
      expect(new Set(mocks.orgCalls)).toEqual(new Set(["org-b"]));
      expect(mocks.process.mock.calls[0]![0].organizationId).toBe("org-b");
      expect(mocks.claim.mock.calls[0]![0].channelId).toBe("ch-b");
    });
  });
});
