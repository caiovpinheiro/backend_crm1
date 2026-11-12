import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  contactFindMany: vi.fn(),
  contactUpdate: vi.fn(),
  contactDelete: vi.fn(),
  convUpdateMany: vi.fn(),
  dealUpdateMany: vi.fn(),
  findExisting: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    baileysAuthKey: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    contact: { findMany: db.contactFindMany, update: db.contactUpdate, delete: db.contactDelete },
    conversation: { updateMany: db.convUpdateMany },
    deal: { updateMany: db.dealUpdateMany },
  },
}));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { channel: { findUnique: vi.fn().mockResolvedValue({ organizationId: "org" }) } },
}));
vi.mock("@/lib/conversation-last-message", () => ({ carryContactLastMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/auto-deals", () => ({ findExistingContactOnPhone: db.findExisting }));

import { clearChannelMap, fixLidContact, resolveLidJid, resolveJid } from "../lid-resolver";

const LID = "209117746565344@lid";
const PN = "551159880991@s.whatsapp.net";

describe("LID do WhatsApp QR → telefone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearChannelMap("ch");
    db.contactFindMany.mockResolvedValue([]);
  });

  it("usa o telefone que o WhatsApp manda junto (key.remoteJidAlt) e memoriza", async () => {
    expect(await resolveLidJid("ch", LID, { alt: PN })).toBe(PN);
    expect(resolveJid("ch", LID)).toBe(PN);
  });

  it("ignora sufixo de aparelho no telefone (5511…:12@s.whatsapp.net)", async () => {
    expect(await resolveLidJid("ch", LID, { alt: "551159880991:12@s.whatsapp.net" })).toBe(PN);
  });

  it("sem alt, pergunta ao mapa LID da sessão do Baileys", async () => {
    const lookup = vi.fn().mockResolvedValue("551159880991:3@s.whatsapp.net");
    expect(await resolveLidJid("ch", LID, { lookup })).toBe(PN);
    expect(lookup).toHaveBeenCalledWith(LID);
  });

  it("alt que também é LID não serve; falha na consulta não derruba a mensagem", async () => {
    const lookup = vi.fn().mockRejectedValue(new Error("sem sessão"));
    expect(await resolveLidJid("ch", LID, { alt: "1@lid", lookup })).toBeNull();
  });

  it("mapa já conhecido não consulta o Baileys", async () => {
    await resolveLidJid("ch", LID, { alt: PN });
    const lookup = vi.fn();
    expect(await resolveLidJid("ch", LID, { lookup })).toBe(PN);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("JID de telefone passa direto", async () => {
    expect(await resolveLidJid("ch", PN, {})).toBe(PN);
  });
});

describe("corrige contato criado com o LID como telefone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.contactDelete.mockResolvedValue({});
    db.contactUpdate.mockResolvedValue({});
    db.convUpdateMany.mockResolvedValue({ count: 1 });
    db.dealUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("junta no contato existente achado pelas variantes do telefone (com/sem 9º dígito)", async () => {
    db.contactFindMany.mockResolvedValue([{ id: "c-lid" }]);
    db.findExisting.mockResolvedValue({ contactId: "c-real", dealId: "d1", open: true });
    expect(await fixLidContact("209117746565344", "551159880991")).toBe(1);
    expect(db.contactFindMany).toHaveBeenCalledWith({ where: { phone: "+209117746565344" }, select: { id: true } });
    expect(db.findExisting).toHaveBeenCalledWith("+551159880991", "c-lid");
    expect(db.convUpdateMany).toHaveBeenCalledWith({ where: { contactId: "c-lid" }, data: { contactId: "c-real" } });
    expect(db.dealUpdateMany).toHaveBeenCalledWith({ where: { contactId: "c-lid" }, data: { contactId: "c-real" } });
    expect(db.contactDelete).toHaveBeenCalledWith({ where: { id: "c-lid" } });
  });

  it("sem contato existente, só troca o telefone", async () => {
    db.contactFindMany.mockResolvedValue([{ id: "c-lid" }]);
    db.findExisting.mockResolvedValue(null);
    expect(await fixLidContact("209117746565344", "551159880991")).toBe(1);
    expect(db.contactUpdate).toHaveBeenCalledWith({ where: { id: "c-lid" }, data: { phone: "+551159880991" } });
    expect(db.contactDelete).not.toHaveBeenCalled();
  });
});
