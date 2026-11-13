import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ findMany: vi.fn(), groupBy: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { whatsAppGroupMessage: { findMany: db.findMany, groupBy: db.groupBy } },
}));

const svc = await import("../whatsapp-group-media");

const at = new Date("2026-11-13T15:00:00Z");
const row = (over: Record<string, unknown>) => ({
  id: "m1",
  messageType: "text",
  mediaUrl: null,
  mimeType: null,
  fileName: null,
  text: "",
  fromMe: false,
  fromName: "William",
  fromPhone: "+5511944690752",
  createdAt: at,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("extractLinks", () => {
  it("acha links no texto, tira pontuação final e repetidos", () => {
    expect(
      svc.extractLinks("veja https://dnawork.com.br/vagas. e http://x.com/a?b=1, de novo https://dnawork.com.br/vagas"),
    ).toEqual(["https://dnawork.com.br/vagas", "http://x.com/a?b=1"]);
    expect(svc.extractLinks("sem link aqui, só http")).toEqual([]);
  });
});

describe("listGroupMediaItems", () => {
  it("fotos e vídeos com arquivo, mais recentes primeiro; autor 'Você' no próprio número", async () => {
    db.findMany.mockResolvedValue([
      row({ id: "a", messageType: "image", mediaUrl: "/api/storage/o/b/a.jpg", fromMe: true }),
    ]);
    const items = await svc.listGroupMediaItems("g1", "media", { limit: 3 });
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId: "g1", messageType: { in: ["image", "video"] }, mediaUrl: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
    );
    expect(items[0]).toMatchObject({ id: "a", author: "Você", createdAt: at.toISOString() });
  });

  it("documentos com paginação por data", async () => {
    db.findMany.mockResolvedValue([]);
    const before = new Date("2026-11-01T00:00:00Z");
    await svc.listGroupMediaItems("g1", "docs", { before });
    expect(db.findMany.mock.calls[0][0].where).toEqual({
      groupId: "g1",
      messageType: { in: ["document"] },
      mediaUrl: { not: null },
      createdAt: { lt: before },
    });
  });
});

describe("listGroupLinks / countGroupMedia", () => {
  it("um item por link, com domínio, trecho e autor", async () => {
    db.findMany.mockResolvedValue([
      row({ id: "m1", text: "planilha aqui https://docs.google.com/x e https://www.dnawork.com.br" }),
    ]);
    const links = await svc.listGroupLinks("g1");
    expect(links.map((l) => [l.id, l.domain, l.author])).toEqual([
      ["m1:0", "docs.google.com", "William"],
      ["m1:1", "dnawork.com.br", "William"],
    ]);
    expect(links[0].snippet).toContain("planilha aqui");
  });

  it("totais das três abas", async () => {
    db.groupBy.mockResolvedValue([
      { messageType: "image", _count: { _all: 5 } },
      { messageType: "video", _count: { _all: 2 } },
      { messageType: "document", _count: { _all: 3 } },
    ]);
    db.findMany.mockResolvedValue([row({ text: "https://a.com" }), row({ id: "m2", text: "http: nada" })]);
    expect(await svc.countGroupMedia("g1")).toEqual({ media: 7, docs: 3, links: 1 });
  });
});
