/**
 * Efeito da entrada S2S: contato pelo campo de match (desconhecido → cria),
 * contexto vivo, nota na conversa existente, conversa nova com a tag da
 * fila, `ref` e regras de category/priority. Helpers da base mockados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  prisma: {
    contact: { findFirst: vi.fn() },
    contactCustomFieldValue: { findFirst: vi.fn(), upsert: vi.fn() },
    customField: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
    tag: { findFirst: vi.fn() },
    tagOnContact: { findFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null) },
    department: { findFirst: vi.fn() },
  },
  prismaBase: { organization: { findUnique: vi.fn(async () => ({ slug: "acme" })) } },
  insertContact: vi.fn(),
  fireTrigger: vi.fn(async () => {}),
  addTag: vi.fn(async () => ({})),
  findActive: vi.fn(),
  createNote: vi.fn(async () => "note-1"),
  findOrCreateConv: vi.fn(),
  writeLiveContext: vi.fn(async (_a: unknown) => ({})),
  recordRef: vi.fn(async () => ({ id: "ref-1", created: true })),
  publishConversationUpdated: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: m.prisma }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: m.prismaBase }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: <T,>(d: T) => ({ ...d, organizationId: "org-1" }) }));
vi.mock("@/lib/cache/message-versions", () => ({ noteMessageChange: vi.fn(async () => {}) }));
vi.mock("@/lib/realtime-events", () => ({ publishConversationUpdated: m.publishConversationUpdated }));
vi.mock("@/services/contacts", () => ({
  insertContactWithNextNumber: m.insertContact,
  isPrismaUniqueViolation: (e: unknown) => (e as { code?: string })?.code === "P2002",
}));
vi.mock("@/services/automation-triggers", () => ({ fireTrigger: m.fireTrigger }));
vi.mock("@/services/tags", () => ({ addTagToContact: m.addTag }));
vi.mock("@/lib/webchat/conversation-notes", () => ({
  findActiveWebchatConversation: m.findActive,
  createWebchatSiteNote: m.createNote,
}));
vi.mock("@/lib/webchat/inbound", () => ({ findOrCreateWebchatConversation: m.findOrCreateConv }));
vi.mock("@/lib/webchat/live-context", async (orig) => ({
  ...(await orig<typeof import("@/lib/webchat/live-context")>()),
  writeLiveContext: m.writeLiveContext,
}));
vi.mock("@/lib/webchat/conversation-ref", async (orig) => ({
  ...(await orig<typeof import("@/lib/webchat/conversation-ref")>()),
  recordWebchatConversationRef: m.recordRef,
}));

import { processWebchatS2SIngress, webchatConversationUrl } from "@/lib/webchat/s2s/ingress";
import type { WebchatS2SRequest } from "@/lib/webchat/s2s/body";
import type { WebchatChannel } from "@/lib/webchat/session";
import { defaultWebchatV2Config, normalizeWebchatV2Config } from "@/lib/webchat/v2-config";

function channel(v2Patch: unknown = {}): WebchatChannel {
  return {
    id: "ch-1",
    organizationId: "org-1",
    name: "Site",
    publicKey: "wc_x",
    defaultPipelineId: null,
    config: {} as WebchatChannel["config"],
    v2: normalizeWebchatV2Config(v2Patch, defaultWebchatV2Config()),
    orgDefaults: { primary: "#000000", avatarUrl: null },
  };
}

function request(over: Partial<WebchatS2SRequest> = {}): WebchatS2SRequest {
  return {
    externalId: "ext-1",
    ref: null,
    category: null,
    priority: null,
    text: "Precisa de ajuda",
    fields: null,
    links: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.prisma.contact.findFirst.mockResolvedValue({ id: "ct-1" });
  m.findActive.mockResolvedValue({ id: "conv-1", number: 7 });
  m.prisma.tag.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "tag-ok" || where.id === "tag-fila" ? { id: where.id } : null,
  );
  m.prisma.department.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "dep-ok" ? { id: "dep-ok" } : null,
  );
});

describe("entrada S2S — efeito", () => {
  it("contato conhecido + conversa aberta: só a nota (com links) e o contexto", async () => {
    const res = await processWebchatS2SIngress(
      channel(),
      request({
        fields: { etapa: "2", invalida$: "x" },
        links: [{ label: "Ver histórico", url: "https://sistema.example.test/h/1" }],
      }),
    );
    expect(res).toMatchObject({
      conversationId: "conv-1",
      conversationNumber: 7,
      contactId: "ct-1",
      contactCreated: false,
      conversationCreated: false,
      noteId: "note-1",
    });
    expect(m.prisma.contact.findFirst).toHaveBeenCalledWith({ where: { externalId: "ext-1" }, select: { id: true } });
    expect(m.insertContact).not.toHaveBeenCalled();
    expect(m.findOrCreateConv).not.toHaveBeenCalled();
    expect(m.createNote).toHaveBeenCalledWith({
      organizationId: "org-1",
      conversationId: "conv-1",
      contactId: "ct-1",
      content: "Precisa de ajuda\n\nVer histórico — https://sistema.example.test/h/1",
    });
    const ctx = m.writeLiveContext.mock.calls[0]![0] as unknown as {
      channelId: string;
      owner: unknown;
      patch: { set: unknown; ignored: string[] };
      maxKeys: number;
    };
    expect(ctx.channelId).toBe("ch-1");
    expect(ctx.owner).toEqual({ contactId: "ct-1" });
    expect(ctx.patch.set).toEqual({ etapa: "2" });
    expect(ctx.patch.ignored).toEqual(["invalida$"]);
    expect(ctx.maxKeys).toBe(30);
    expect(m.addTag).not.toHaveBeenCalled();
  });

  it("external_id desconhecido cria o contato (nome = external_id, identidade no campo de match)", async () => {
    m.prisma.contact.findFirst.mockResolvedValue(null);
    m.insertContact.mockResolvedValue({ id: "ct-novo" });
    const res = await processWebchatS2SIngress(channel(), request());
    expect(res.contactCreated).toBe(true);
    expect(res.contactId).toBe("ct-novo");
    expect(m.insertContact.mock.calls[0]![0]).toEqual({
      name: "ext-1",
      lifecycleStage: "LEAD",
      source: "Webchat",
      externalId: "ext-1",
    });
    expect(m.fireTrigger).toHaveBeenCalledWith("contact_created", expect.objectContaining({ contactId: "ct-novo" }));
  });

  it("campo de match personalizado: cria e grava o valor no campo", async () => {
    m.prisma.customField.findFirst.mockResolvedValue({ id: "cf-1" });
    m.prisma.contactCustomFieldValue.findFirst.mockResolvedValue(null);
    m.insertContact.mockResolvedValue({ id: "ct-novo" });
    await processWebchatS2SIngress(
      channel({ identity: { matchField: { type: "customField", customFieldId: "cf-1" } } }),
      request(),
    );
    expect(m.insertContact.mock.calls[0]![0]).not.toHaveProperty("externalId");
    expect(m.prisma.contactCustomFieldValue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactId_customFieldId: { contactId: "ct-novo", customFieldId: "cf-1" } },
        update: { value: "ext-1" },
      }),
    );
  });

  it("campo de match que não existe mais cai no externalId", async () => {
    m.prisma.customField.findFirst.mockResolvedValue(null);
    await processWebchatS2SIngress(
      channel({ identity: { matchField: { type: "customField", customFieldId: "cf-sumiu" } } }),
      request(),
    );
    expect(m.prisma.contact.findFirst).toHaveBeenCalledWith({ where: { externalId: "ext-1" }, select: { id: true } });
  });

  it("corrida na criação (unique do externalId) usa o contato que venceu", async () => {
    m.prisma.contact.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "ct-outro" });
    m.insertContact.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await processWebchatS2SIngress(channel(), request());
    expect(res).toMatchObject({ contactId: "ct-outro", contactCreated: false });
  });

  it("sem conversa aberta: cria na fila do canal e aplica a tag configurada", async () => {
    m.findActive.mockResolvedValue(null);
    m.findOrCreateConv.mockResolvedValue({ id: "conv-nova", assignedToId: null, created: true });
    m.prisma.conversation.findFirst.mockResolvedValue({ id: "conv-nova", number: 99 });
    const res = await processWebchatS2SIngress(channel({ s2s: { queueTagId: "tag-fila" } }), request());
    expect(m.findOrCreateConv).toHaveBeenCalledWith("ct-1", "ch-1", {
      content: "Precisa de ajuda",
      messageType: "note",
    });
    expect(res).toMatchObject({ conversationId: "conv-nova", conversationNumber: 99, conversationCreated: true });
    expect(m.addTag).toHaveBeenCalledWith("ct-1", "tag-fila");
    expect(m.createNote).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-nova" }));
  });

  it("tag da fila já aplicada ou inexistente não quebra nem duplica", async () => {
    m.findActive.mockResolvedValue(null);
    m.findOrCreateConv.mockResolvedValue({ id: "conv-nova", assignedToId: null, created: true });
    m.prisma.conversation.findFirst.mockResolvedValue({ id: "conv-nova", number: 99 });
    await processWebchatS2SIngress(channel({ s2s: { queueTagId: "tag-inexistente" } }), request());
    expect(m.addTag).not.toHaveBeenCalled();
    m.prisma.tagOnContact.findFirst.mockResolvedValueOnce({ contactId: "ct-1" });
    await processWebchatS2SIngress(channel({ s2s: { queueTagId: "tag-fila" } }), request());
    expect(m.addTag).not.toHaveBeenCalled();
  });

  it("ref registrado com category/priority e cópia para o negócio configurado", async () => {
    await processWebchatS2SIngress(
      channel({ refDealCustomFieldId: "cf-deal" }),
      request({ ref: "REF-1", category: "suporte", priority: "alta" }),
    );
    expect(m.recordRef).toHaveBeenCalledWith({
      conversationId: "conv-1",
      contactId: "ct-1",
      ref: "REF-1",
      source: "s2s",
      category: "suporte",
      priority: "alta",
      refDealCustomFieldId: "cf-deal",
    });
  });

  it("regras: tag, departamento e nota fixada para a combinação que casa", async () => {
    await processWebchatS2SIngress(
      channel({
        s2s: {
          rules: [
            { priority: "alta", tagId: "tag-ok", departmentId: "dep-ok", pinNote: true },
            { category: "outra", tagId: "tag-ok" },
            { priority: "alta", departmentId: "dep-inexistente" },
          ],
        },
      }),
      request({ category: "suporte", priority: " ALTA " }),
    );
    expect(m.addTag).toHaveBeenCalledTimes(1);
    expect(m.addTag).toHaveBeenCalledWith("ct-1", "tag-ok");
    expect(m.prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: { departmentId: "dep-ok" },
    });
    expect(m.prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: { pinnedNoteId: "note-1" },
    });
    expect(m.prisma.conversation.update).toHaveBeenCalledTimes(2);
  });

  it("só fields: atualiza o contexto sem nota", async () => {
    const res = await processWebchatS2SIngress(channel(), request({ text: null, fields: { etapa: 3 } }));
    expect(res.noteId).toBeNull();
    expect(m.createNote).not.toHaveBeenCalled();
    expect(m.writeLiveContext).toHaveBeenCalledTimes(1);
  });

  it("url da conversa: tenant da org", async () => {
    vi.stubEnv("TENANT_BASE_DOMAIN", "crm.example.test");
    vi.stubEnv("TENANT_PROTOCOL", "https");
    try {
      expect(await webchatConversationUrl("org-1", 42)).toBe("https://acme.crm.example.test/inbox?c=42");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
