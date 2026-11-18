/**
 * Passo "Enviar para empresa": escolhe empresa/grupos, falha sem empresa,
 * sem grupo ou com o QR desconectado, assina e grava no histórico do grupo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  whatsAppGroup: { findMany: vi.fn(), findFirst: vi.fn() },
}));
const deps = vi.hoisted(() => ({
  primaryCompanyForDeal: vi.fn(),
  companyForMessages: vi.fn(),
  appendWhatsAppGroupMessage: vi.fn(),
  deleteGroupMessage: vi.fn(),
  enqueueBaileysOutbound: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org1" }));
vi.mock("@/lib/queue", () => ({ enqueueBaileysOutbound: deps.enqueueBaileysOutbound }));
vi.mock("@/services/deal-companies", () => ({
  primaryCompanyForDeal: deps.primaryCompanyForDeal,
  companyForMessages: deps.companyForMessages,
}));
vi.mock("@/services/whatsapp-groups", () => ({
  appendWhatsAppGroupMessage: deps.appendWhatsAppGroupMessage,
  deleteGroupMessage: deps.deleteGroupMessage,
}));

const svc = await import("../company-group-send");

const company = { id: "c1", number: 1, name: "Cacau Lopes", cnpj: null, phone: null, email: null, cep: null, city: null, state: null, address: null };
const on = { id: "ch1", phoneNumber: "+55 11 99999-0000" as string | null, status: "CONNECTED", provider: "BAILEYS_MD" };
const off = { id: "ch2", phoneNumber: null, status: "DISCONNECTED", provider: "BAILEYS_MD" };
const group = (id: string, jid: string, channel = on, customName: string | null = null) => ({
  id, jid, name: `Grupo ${id}`, customName, channel,
});
const cfg = (over: Record<string, unknown> = {}) => svc.readCompanyGroupConfig({ content: "Oi {{empresa.nome}}", ...over });

beforeEach(() => {
  vi.clearAllMocks();
  deps.appendWhatsAppGroupMessage.mockResolvedValue({ id: "m1" });
  deps.enqueueBaileysOutbound.mockResolvedValue({ id: "job" });
  deps.deleteGroupMessage.mockResolvedValue(undefined);
  deps.companyForMessages.mockResolvedValue(company);
  deps.primaryCompanyForDeal.mockResolvedValue(company);
});

describe("resolveCompanyGroupTargets", () => {
  it("empresa fixa + grupo escolhido: só o grupo, se ainda é da empresa", async () => {
    db.whatsAppGroup.findMany.mockResolvedValue([group("g1", "j1", on, "RH Cacau")]);
    const r = await svc.resolveCompanyGroupTargets(cfg({ companyId: "c1", groupId: "g1" }), null);
    expect(db.whatsAppGroup.findMany.mock.calls[0][0].where).toEqual({ id: "g1", companyId: "c1" });
    expect(r.groups.map((g) => g.name)).toEqual(["RH Cacau"]);
  });

  it("grupo desvinculado da empresa: erro", async () => {
    db.whatsAppGroup.findMany.mockResolvedValue([]);
    await expect(svc.resolveCompanyGroupTargets(cfg({ companyId: "c1", groupId: "g1" }), null)).rejects.toThrow(
      /não está mais vinculado/,
    );
  });

  it("sem empresa escolhida / empresa apagada: erro", async () => {
    await expect(svc.resolveCompanyGroupTargets(cfg(), null)).rejects.toBeInstanceOf(svc.CompanyGroupSendError);
    deps.companyForMessages.mockResolvedValue(null);
    await expect(svc.resolveCompanyGroupTargets(cfg({ companyId: "x", allGroups: true }), null)).rejects.toThrow(
      /não existe mais/,
    );
  });

  it("todos os grupos: um por jid, preferindo o número conectado", async () => {
    db.whatsAppGroup.findMany.mockResolvedValue([group("g1", "j1", off), group("g2", "j1", on), group("g3", "j3")]);
    const r = await svc.resolveCompanyGroupTargets(cfg({ companyId: "c1", allGroups: true }), null);
    expect(r.groups.map((g) => g.id)).toEqual(["g2", "g3"]);
  });

  it("principal do negócio sem 'todos': o grupo vinculado por último", async () => {
    db.whatsAppGroup.findFirst.mockResolvedValue({ jid: "j9" });
    db.whatsAppGroup.findMany.mockResolvedValue([group("g9", "j9")]);
    const r = await svc.resolveCompanyGroupTargets(cfg({ companyMode: "deal_primary" }), "d1");
    expect(deps.primaryCompanyForDeal).toHaveBeenCalledWith("d1");
    expect(db.whatsAppGroup.findFirst.mock.calls[0][0].orderBy[0]).toEqual({
      companyLinkedAt: { sort: "desc", nulls: "last" },
    });
    expect(r.groups.map((g) => g.id)).toEqual(["g9"]);
  });

  it("negócio sem empresa / sem negócio / empresa sem grupo: erro", async () => {
    await expect(svc.resolveCompanyGroupTargets(cfg({ companyMode: "deal_primary" }), null)).rejects.toThrow(
      /sem negócio/,
    );
    deps.primaryCompanyForDeal.mockResolvedValue(null);
    await expect(svc.resolveCompanyGroupTargets(cfg({ companyMode: "deal_primary" }), "d1")).rejects.toThrow(
      /não tem empresa/,
    );
    deps.primaryCompanyForDeal.mockResolvedValue(company);
    db.whatsAppGroup.findFirst.mockResolvedValue(null);
    await expect(svc.resolveCompanyGroupTargets(cfg({ companyMode: "deal_primary" }), "d1")).rejects.toThrow(
      /não tem grupo/,
    );
  });
});

describe("sendToCompanyGroups", () => {
  const interpolate = async (t: string) => t.replace("{{empresa.nome}}", "Cacau Lopes");

  it("texto assinado: grava no histórico e enfileira pelo número do grupo", async () => {
    const res = await svc.sendToCompanyGroups({
      cfg: cfg({ signatureEnabled: true }),
      target: { company, groups: [group("g1", "j1")] },
      interpolate,
      senderName: "Boas-vindas",
    });
    expect(res).toEqual({ companyName: "Cacau Lopes", sent: ["Grupo g1"], skipped: [] });
    expect(deps.appendWhatsAppGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "g1",
        fromMe: true,
        fromName: "Boas-vindas",
        fromJid: "5511999990000@s.whatsapp.net",
        text: "*DNA Work*: Oi Cacau Lopes",
      }),
    );
    expect(deps.enqueueBaileysOutbound).toHaveBeenCalledWith({
      channelId: "ch1",
      to: "j1",
      content: "*DNA Work*: Oi Cacau Lopes",
      messageType: "text",
      groupMessageId: "m1",
    });
  });

  it("todos desconectados: erro (vai para a saída de falha)", async () => {
    await expect(
      svc.sendToCompanyGroups({
        cfg: cfg(),
        target: { company, groups: [group("g1", "j1", off)] },
        interpolate,
        senderName: "x",
      }),
    ).rejects.toThrow(/desconectado/);
    expect(deps.enqueueBaileysOutbound).not.toHaveBeenCalled();
  });

  it("alguns desconectados: envia nos outros e lista os pulados", async () => {
    const res = await svc.sendToCompanyGroups({
      cfg: cfg(),
      target: { company, groups: [group("g1", "j1", off), group("g2", "j2")] },
      interpolate,
      senderName: "x",
    });
    expect(res.sent).toEqual(["Grupo g2"]);
    expect(res.skipped).toEqual(["Grupo g1"]);
  });

  it("mídia: documento usa o nome do arquivo e a legenda vai para o histórico", async () => {
    await svc.sendToCompanyGroups({
      cfg: cfg({
        contentType: "media",
        mediaType: "document",
        mediaUrl: "/api/storage/org1/attachments/abc.pdf",
        uploadedFileName: "vaga.pdf",
        caption: "Vaga {{empresa.nome}}",
      }),
      target: { company, groups: [group("g1", "j1")] },
      interpolate,
      senderName: "x",
    });
    expect(deps.appendWhatsAppGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Vaga Cacau Lopes\n📎 vaga.pdf",
        messageType: "document",
        mimeType: "application/pdf",
        fileName: "vaga.pdf",
      }),
    );
    expect(deps.enqueueBaileysOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: "vaga.pdf", messageType: "document", originalName: "vaga.pdf" }),
    );
  });

  it("fila fora do ar: apaga do histórico e falha", async () => {
    deps.enqueueBaileysOutbound.mockResolvedValue(null);
    await expect(
      svc.sendToCompanyGroups({
        cfg: cfg(),
        target: { company, groups: [group("g1", "j1")] },
        interpolate,
        senderName: "x",
      }),
    ).rejects.toThrow(/fila/);
    expect(deps.deleteGroupMessage).toHaveBeenCalledWith("m1");
  });

  it("texto vazio depois das variáveis: erro", async () => {
    await expect(
      svc.sendToCompanyGroups({
        cfg: cfg({ content: "  " }),
        target: { company, groups: [group("g1", "j1")] },
        interpolate,
        senderName: "x",
      }),
    ).rejects.toThrow(/vazia/);
  });
});

describe("signText", () => {
  it("prefixa e não duplica", () => {
    expect(svc.signText("Oi", "DNA Work")).toBe("*DNA Work*: Oi");
    expect(svc.signText("*DNA Work*: Oi", "DNA Work")).toBe("*DNA Work*: Oi");
  });
});
