/**
 * Modelos do widget de ponta a ponta, com Postgres de verdade
 * (docs/decisoes/webchat-widget.md §9.15): `PUT /api/channels/:id` grava no JSON
 * do canal e `GET /api/public/webchat/config` entrega o que foi salvo.
 *
 * Só corre contra Postgres local (DATABASE_URL em localhost). Sem isso, pula.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { hostnameFromConnectionUrl } from "@/lib/warn-public-do-managed-hosts";

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u-1" } })) }));
vi.mock("@/lib/authz/resource-policy", () => ({ requireChannelScope: vi.fn(async () => null) }));
vi.mock("@/lib/queue", () => ({ enqueueBaileysControl: vi.fn(async () => {}) }));
vi.mock("@/lib/audit/log", () => ({ logAudit: vi.fn(async () => {}) }));

const url = process.env.DATABASE_URL;
const host = url?.trim() ? hostnameFromConnectionUrl(url) : null;
const LOCAL = host === "localhost" || host === "127.0.0.1" || host === "::1";

const suffix = randomBytes(4).toString("hex");
const ORIGIN = "https://www.exemplo.test";

describe.skipIf(!LOCAL)("appearance do webchat (Postgres local)", () => {
  type Base = (typeof import("@/lib/prisma-base"))["prismaBase"];
  let base: Base;
  let orgId = "";
  let channelId = "";
  let publicKey = "";

  async function put(config: unknown) {
    const { PUT } = await import("@/app/api/channels/[id]/route");
    const { runWithContext } = await import("@/lib/request-context");
    return runWithContext({ organizationId: orgId, userId: "u-1", isSuperAdmin: false }, () =>
      PUT(
        new Request(`http://localhost/api/channels/${channelId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config }),
        }),
        { params: Promise.resolve({ id: channelId }) },
      ),
    );
  }

  async function publicConfig() {
    const { GET } = await import("@/app/api/public/webchat/config/route");
    const res = await GET(
      new Request(`http://localhost/api/public/webchat/config?key=${publicKey}&host=${ORIGIN}`, {
        headers: { origin: "https://bwipo.com" },
      }),
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  const stored = async () => {
    const row = await base.channel.findUniqueOrThrow({ where: { id: channelId }, select: { config: true } });
    return row.config as Record<string, unknown> & { v2?: Record<string, unknown> };
  };

  beforeAll(async () => {
    base = (await import("@/lib/prisma-base")).prismaBase;
    const org = await base.organization.create({
      data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
      select: { id: true },
    });
    orgId = org.id;
    publicKey = `wc_${suffix}${"x".repeat(16)}`;
    // Canal como os antigos: JSON sem `v2`, com um segredo já gravado.
    const channel = await base.channel.create({
      data: {
        organizationId: orgId,
        name: "Site",
        number: 1,
        type: "WEBCHAT",
        provider: "WEBCHAT",
        status: "CONNECTED",
        publicKey,
        config: { publicKey, allowedOrigins: [ORIGIN], greeting: "Oi", identitySecret: "enc:v1:guardado" },
      },
      select: { id: true },
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await base.channel.deleteMany({ where: { organizationId: orgId } });
    await base.organization.delete({ where: { id: orgId } });
  });

  it("canal sem configuração: compact, sem tópicos", async () => {
    const body = await publicConfig();
    expect(body.appearance).toMatchObject({ model: "compact", allowExpand: false, start: { topics: [] } });
    expect(body.v2).toBeUndefined();
  });

  it("PUT inválido → 400 com a mensagem, e nada muda no banco", async () => {
    const before = await stored();
    const res = await put({ v2: { appearance: { model: "outro" } } });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/appearance\.model/);
    expect(await stored()).toEqual(before);
  });

  it("texto que o jsonb recusa → 400, não 500", async () => {
    const res = await put({ v2: { appearance: { start: { title: "a\u0000b" } } } });
    expect(res.status).toBe(400);
  });

  it("PUT válido chega ao widget e preserva o resto do config e o segredo", async () => {
    const topic = {
      id: "t1",
      label: "Acesso",
      icon: "lock",
      action: { type: "open_url", url: "https://exemplo.test/ajuda", label: "Ver" },
    };
    const res = await put({ v2: { appearance: { model: "guided", allowExpand: true, start: { topics: [topic] } } } });
    expect(res.status).toBe(200);

    const saved = await stored();
    expect(saved.greeting).toBe("Oi");
    expect(saved.identitySecret).toBe("enc:v1:guardado");

    const body = await publicConfig();
    expect(body.appearance).toMatchObject({ model: "guided", allowExpand: true, start: { topics: [topic] } });
    expect(JSON.stringify(body)).not.toContain("enc:v1");
  });

  it("PUT de outro campo mantém appearance", async () => {
    const res = await put({ greeting: "Olá", v2: { context: { anonymous: true } } });
    expect(res.status).toBe(200);
    const body = await publicConfig();
    expect(body.greeting).toBe("Olá");
    expect(body.appearance.model).toBe("guided");
    expect((await stored()).identitySecret).toBe("enc:v1:guardado");
  });

  it("JSON quebrado no banco cai no padrão sem derrubar o widget", async () => {
    const saved = await stored();
    await base.channel.update({
      where: { id: channelId },
      data: { config: { ...saved, v2: { appearance: { model: "antigo", start: "x" } } } as object },
    });
    const { invalidateChannelLookups } = await import("@/lib/cache/keys");
    await invalidateChannelLookups(orgId);
    const body = await publicConfig();
    expect(body.appearance).toMatchObject({ model: "compact", start: { topics: [] } });
    expect(body.greeting).toBe("Olá");
  });
});
