/**
 * Rotas de segredos do webchat v2: só quem tem `manage` no canal gera/gira;
 * o valor aparece uma vez (POST) e o GET devolve só configurado + data.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: { user: { id: "u1", role: "ADMIN" } } as { user: { id: string; role: string } } | null,
  deny: false,
  actions: [] as string[],
  channel: null as { provider: string; config: unknown } | null,
  rotate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/authz/resource-policy", () => ({
  requireChannelScope: vi.fn(async (_u: unknown, action: string) => {
    h.actions.push(action);
    return h.deny ? NextResponse.json({ message: "Sem permissão." }, { status: 403 }) : null;
  }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { channel: { findUnique: vi.fn(async () => h.channel) } },
}));
vi.mock("@/services/channels", () => ({ rotateWebchatChannelSecret: h.rotate }));

import { GET } from "@/app/api/channels/[id]/webchat-secrets/route";
import { POST } from "@/app/api/channels/[id]/webchat-secrets/[kind]/route";

const ctx = (kind = "identity") => ({ params: Promise.resolve({ id: "ch-1", kind }) });
const req = () =>
  new Request("http://crm.test/api/channels/ch-1/webchat-secrets/identity", { method: "POST" });

beforeEach(() => {
  h.session = { user: { id: "u1", role: "ADMIN" } };
  h.deny = false;
  h.actions.length = 0;
  h.channel = null;
  h.rotate.mockReset();
});

describe("POST /api/channels/:id/webchat-secrets/:kind", () => {
  it("201 com o segredo uma vez + status; exige manage", async () => {
    const status = {
      identity: { configured: true, rotatedAt: "2026-10-28T12:00:00.000Z" },
      s2s: { configured: false, rotatedAt: null },
    };
    h.rotate.mockResolvedValue({ secret: "wcid_valor", rotatedAt: "2026-10-28T12:00:00.000Z", status });
    const res = await POST(req(), ctx("identity"));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      kind: "identity",
      secret: "wcid_valor",
      rotatedAt: "2026-10-28T12:00:00.000Z",
      secrets: status,
    });
    expect(h.rotate).toHaveBeenCalledWith("ch-1", "identity");
    expect(h.actions).toEqual(["manage"]);
  });

  it("401 sem sessão, 403 sem manage, 400 tipo inválido, 404 não-webchat", async () => {
    h.session = null;
    expect((await POST(req(), ctx())).status).toBe(401);
    h.session = { user: { id: "u1", role: "AGENT" } };
    h.deny = true;
    expect((await POST(req(), ctx())).status).toBe(403);
    h.deny = false;
    expect((await POST(req(), ctx("outro"))).status).toBe(400);
    h.rotate.mockResolvedValue(null);
    expect((await POST(req(), ctx("s2s"))).status).toBe(404);
    expect(h.rotate).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/channels/:id/webchat-secrets", () => {
  it("só configurado sim/não + data, nunca o valor", async () => {
    h.channel = {
      provider: "WEBCHAT",
      config: {
        publicKey: "wc_x",
        identitySecret: "enc:v1:abc",
        identitySecretRotatedAt: "2026-10-28T12:00:00.000Z",
      },
    };
    const res = await GET(new Request("http://crm.test"), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      secrets: {
        identity: { configured: true, rotatedAt: "2026-10-28T12:00:00.000Z" },
        s2s: { configured: false, rotatedAt: null },
      },
    });
    expect(JSON.stringify(body)).not.toContain("enc:v1");
    expect(h.actions).toEqual(["manage"]);
  });

  it("403 sem manage; 404 para canal que não é webchat", async () => {
    h.deny = true;
    expect((await GET(new Request("http://crm.test"), ctx())).status).toBe(403);
    h.deny = false;
    h.channel = { provider: "META_CLOUD_API", config: {} };
    expect((await GET(new Request("http://crm.test"), ctx())).status).toBe(404);
  });
});
