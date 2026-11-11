/**
 * A lista de templates de permissão de ligação vem da WABA do canal da
 * conversa. Antes vinha sempre do último canal Cloud API conectado da org:
 * na DNA Work (Candidaturas × Empresas) a lista saía vazia.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolveArgs: [] as unknown[],
  access: null as
    | { response: unknown; conversation?: undefined }
    | { response?: undefined; conversation: { channelId: string | null } }
    | null,
  templates: [] as unknown[],
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (cb: (s: unknown) => unknown) =>
    cb({ user: { id: "u1", role: "AGENT", organizationId: "org_1", isSuperAdmin: false } }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { conversation: { findFirst: vi.fn() } } }));
vi.mock("@/lib/conversation-access", () => ({
  CONVERSATION_ACCESS_SELECT: {},
  requireConversationAccessAndLoad: vi.fn(async () => h.access),
}));
vi.mock("@/lib/meta-whatsapp/resolve-templates-client", () => ({
  resolveMetaTemplatesClient: vi.fn(async (args: unknown) => {
    h.resolveArgs.push(args);
    return {
      ok: true,
      channelId: "ch",
      client: { listMessageTemplates: async () => ({ data: h.templates }) },
    };
  }),
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";

const req = (qs = "") =>
  new Request(`http://localhost/api/meta/whatsapp/call-permission-templates${qs}`);

beforeEach(() => {
  h.resolveArgs = [];
  h.access = null;
  h.templates = [
    { name: "ligacao1", status: "APPROVED", sub_category: "CALL_PERMISSIONS_REQUEST", language: "pt_BR", components: [] },
    { name: "boas_vindas", status: "APPROVED", sub_category: "CUSTOM", language: "pt_BR", components: [] },
  ];
});

describe("GET call-permission-templates", () => {
  it("com conversationId, usa o canal da conversa", async () => {
    h.access = { conversation: { channelId: "ch_candidaturas" } };
    const res = await GET(req("?conversationId=conv_1"));
    expect(res.status).toBe(200);
    expect(h.resolveArgs[0]).toMatchObject({ channelId: "ch_candidaturas" });
    const body = (await res.json()) as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(["ligacao1"]);
  });

  it("sem acesso à conversa, devolve a resposta de acesso e não consulta a Meta", async () => {
    h.access = { response: NextResponse.json({ message: "x" }, { status: 404 }) };
    const res = await GET(req("?conversationId=conv_x"));
    expect(res.status).toBe(404);
    expect(h.resolveArgs).toHaveLength(0);
  });

  it("com channelId, usa esse canal", async () => {
    await GET(req("?channelId=ch_empresas"));
    expect(h.resolveArgs[0]).toMatchObject({ channelId: "ch_empresas" });
  });

  it("sem parâmetro, mantém o comportamento antigo (canal padrão da org)", async () => {
    await GET(req());
    expect(h.resolveArgs[0]).toMatchObject({ channelId: null });
  });
});
