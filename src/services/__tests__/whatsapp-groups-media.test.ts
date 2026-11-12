/**
 * Grupos WhatsApp: ordem pela última mensagem, mídia no histórico e nome
 * dos participantes (perfil do WhatsApp, preservado no resync; contato do
 * CRM só na leitura).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  whatsAppGroup: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  whatsAppGroupMember: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
  whatsAppGroupMessage: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  contact: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/services/contacts", () => ({ insertContactWithNextNumber: vi.fn() }));
vi.mock("@/services/conversations", () => ({
  activeConversationOnAccountWhere: vi.fn(),
  withConversationNumberRetry: vi.fn(),
}));

const svc = await import("../whatsapp-groups");

const at = new Date("2026-11-12T19:44:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  db.whatsAppGroup.updateMany.mockResolvedValue({ count: 1 });
  db.whatsAppGroupMember.updateMany.mockResolvedValue({ count: 1 });
  db.whatsAppGroupMember.findMany.mockResolvedValue([]);
  db.contact.findMany.mockResolvedValue([]);
});

describe("appendWhatsAppGroupMessage", () => {
  it("grava a mídia e sobe o grupo só para frente", async () => {
    db.whatsAppGroupMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "m1",
      fromJid: data.fromJid,
      fromName: null,
      fromPhone: null,
      fromMe: true,
      text: data.text,
      messageType: data.messageType,
      mediaUrl: data.mediaUrl,
      mimeType: data.mimeType,
      fileName: data.fileName,
      createdAt: at,
    }));
    const msg = await svc.appendWhatsAppGroupMessage({
      organizationId: "org1",
      groupId: "g1",
      fromJid: "me",
      fromMe: true,
      text: "📎 proposta.pdf",
      messageType: "document",
      mediaUrl: "/api/storage/org1/attachments/x.pdf",
      mimeType: "application/pdf",
      fileName: "proposta.pdf",
    });
    expect(msg).toMatchObject({
      messageType: "document",
      mediaUrl: "/api/storage/org1/attachments/x.pdf",
      fileName: "proposta.pdf",
      createdAt: at.toISOString(),
    });
    expect(db.whatsAppGroup.updateMany).toHaveBeenCalledWith({
      where: { id: "g1", OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }] },
      data: { lastMessageAt: at },
    });
  });

  it("tipo desconhecido vira texto", async () => {
    db.whatsAppGroupMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "m2",
      fromName: null,
      fromPhone: null,
      createdAt: at,
    }));
    const msg = await svc.appendWhatsAppGroupMessage({
      organizationId: "org1",
      groupId: "g1",
      fromJid: "x",
      fromMe: false,
      text: "oi",
      messageType: "reactionMessage",
    });
    expect(msg?.messageType).toBe("text");
  });
});

describe("listWhatsAppGroups", () => {
  it("ordena pela última mensagem (sem mensagem no fim) e depois pelo nome", async () => {
    db.whatsAppGroup.findMany.mockResolvedValue([
      {
        id: "g1",
        jid: "1@g.us",
        name: "A",
        description: null,
        ownerJid: null,
        participantCount: 3,
        syncedAt: at,
        lastMessageAt: at,
      },
    ]);
    const list = await svc.listWhatsAppGroups("ch1");
    expect(db.whatsAppGroup.findMany.mock.calls[0][0].orderBy).toEqual([
      { lastMessageAt: { sort: "desc", nulls: "last" } },
      { name: "asc" },
    ]);
    expect(list[0].lastMessageAt).toBe(at.toISOString());
  });
});

describe("nome dos participantes", () => {
  it("aprende o nome pelo jid alternativo (LID + telefone)", async () => {
    await svc.learnGroupMemberName({
      groupId: "g1",
      jids: ["123@lid", "5511944690752@s.whatsapp.net", null],
      phone: "5511944690752",
      name: " Caio ",
    });
    expect(db.whatsAppGroupMember.updateMany).toHaveBeenCalledWith({
      where: {
        groupId: "g1",
        AND: [
          {
            OR: [
              { jid: { in: ["123@lid", "5511944690752@s.whatsapp.net"] } },
              { phone: "5511944690752" },
            ],
          },
          // Participante sem nome (NULL) também aprende.
          { OR: [{ name: null }, { name: { not: "Caio" } }] },
        ],
      },
      data: { name: "Caio" },
    });
  });

  it("nome vazio não grava", async () => {
    expect(await svc.learnGroupMemberName({ groupId: "g1", jids: ["a"], phone: null, name: "  " })).toBe(0);
    expect(db.whatsAppGroupMember.updateMany).not.toHaveBeenCalled();
  });

  it("resync mantém o nome já aprendido (por jid ou telefone)", async () => {
    db.whatsAppGroup.upsert.mockResolvedValue({ id: "g1" });
    db.whatsAppGroupMember.findMany.mockResolvedValue([
      { jid: "a@s.whatsapp.net", phone: "5511900000001", name: "Ana" },
      { jid: "old@lid", phone: "5511900000002", name: "Bruno" },
    ]);
    await svc.replaceChannelGroups("org1", "ch1", [
      {
        jid: "1@g.us",
        name: "Grupo",
        description: null,
        ownerJid: null,
        members: [
          { jid: "a@s.whatsapp.net", phone: "5511900000001", name: null, isAdmin: false, isSuperAdmin: false },
          { jid: "b@s.whatsapp.net", phone: "5511900000002", name: null, isAdmin: false, isSuperAdmin: false },
          { jid: "c@s.whatsapp.net", phone: "5511900000003", name: "Carla", isAdmin: false, isSuperAdmin: false },
        ],
      },
    ]);
    db.whatsAppGroup.findMany.mockResolvedValue([]);
    const created = db.whatsAppGroupMember.createMany.mock.calls[0][0].data as Array<{ name: string | null }>;
    expect(created.map((m) => m.name)).toEqual(["Ana", "Bruno", "Carla"]);
  });

  it("sem nome do WhatsApp, mostra o do contato do CRM (sem gravar)", async () => {
    db.whatsAppGroup.findFirst.mockResolvedValue({
      id: "g1",
      jid: "1@g.us",
      name: "Teste",
      description: null,
      ownerJid: null,
      participantCount: 2,
      syncedAt: at,
      lastMessageAt: null,
      members: [
        { id: "m1", jid: "x", phone: "5511945010493", name: null, isAdmin: false, isSuperAdmin: false },
        { id: "m2", jid: "y", phone: "5511978398715", name: "William", isAdmin: true, isSuperAdmin: true },
      ],
    });
    db.contact.findMany.mockResolvedValue([{ phone: "+5511945010493", name: "Caio Pinheiro" }]);
    const group = await svc.getWhatsAppGroup("g1", "ch1");
    expect(group?.members.map((m) => m.name)).toEqual(["Caio Pinheiro", "William"]);
    expect(db.whatsAppGroupMember.updateMany).not.toHaveBeenCalled();
  });
});
