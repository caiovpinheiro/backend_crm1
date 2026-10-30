/**
 * Passo de envio salvo antes da troca de número (9873 → 2310) guardava o
 * `channelId` do canal excluído, escondido atrás de "Selecionar tudo". O
 * envio saía pelo fallback do cliente Meta, mas o `message.create` gravava
 * o id morto e estourava `messages_channelId_fkey`: mensagem entregue sem
 * registro no inbox e fluxo interrompido no passo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  const sendText = vi.fn();
  const client = { configured: true, sendText, sendTemplate: vi.fn(), sendMedia: vi.fn() };
  // Canais que existem no banco; o resto simula canal excluído.
  const existing = new Set(["ch-2310"]);
  const fkCheck = (data: { channelId?: string }) => {
    if (data.channelId && !existing.has(data.channelId)) {
      throw new Error(
        "Foreign key constraint violated on the constraint: `messages_channelId_fkey`",
      );
    }
  };
  return {
    sendText,
    client,
    existing,
    metaClientFromConfig: vi.fn(() => client),
    ensureConv: vi.fn(),
    messageCreate: vi.fn(async ({ data }: { data: { channelId?: string } }) => {
      fkCheck(data);
      return { id: "msg-1", organizationId: "org-1", conversationId: "conv-1", externalId: "wamid.1", createdAt: new Date(), ...data };
    }),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: {
      findFirst: vi.fn(async (args: { where: { id?: string } }) => {
        if (args.where.id && !h.existing.has(args.where.id)) return null;
        return {
          id: "ch-2310",
          provider: "META_CLOUD_API",
          config: { accessToken: "t", phoneNumberId: "p" },
          organizationId: "org-1",
        };
      }),
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.filter((id) => h.existing.has(id)).map((id) => ({ id })),
      ),
    },
    conversation: {
      findUnique: vi.fn(async () => ({
        channel: "whatsapp",
        organizationId: "org-1",
        channelRef: { provider: "META_CLOUD_API", config: { accessToken: "t", phoneNumberId: "p" } },
      })),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: { create: h.messageCreate, findFirst: vi.fn(async () => null) },
    contact: { findUnique: vi.fn(async () => ({ organizationId: "org-1" })) },
    organizationSetting: { findUnique: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 1),
  },
}));
vi.mock("@/lib/meta-whatsapp/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/meta-whatsapp/client")>();
  return { ...real, metaClientFromConfig: h.metaClientFromConfig, metaWhatsApp: h.client };
});
vi.mock("@/services/whatsapp-conversation", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/whatsapp-conversation")>();
  return { ...real, ensureWhatsAppConversationForContact: h.ensureConv };
});
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: vi.fn(async () => undefined),
  notifyDealStageChanged: vi.fn(),
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/conversation-error-flag", () => ({
  markConversationHasError: vi.fn(async () => undefined),
}));

import { executeStep } from "@/services/automation-executor";
import { runWithContext } from "@/lib/request-context";

// O worker roda o passo dentro do contexto da org do lead.
const run = (cfg: Record<string, unknown>) =>
  runWithContext({ organizationId: "org-1", userId: "system", isSuperAdmin: false }, () =>
    executeStep("send_whatsapp_message", cfg, rt as never),
  );

// Lead novo (gatilho não-inbound, sem canal no payload) → passo #3 de boas-vindas.
const rt = {
  automationId: "auto-1",
  automationName: "Boas-vindas",
  contactId: "ct-1",
  dealId: "deal-1",
  event: "deal_created",
  data: {},
  contact: { id: "ct-1", name: "Aluno", phone: "+5511999990000", whatsappBsuid: null },
  deal: null,
  conversation: null,
  contactTagIds: [],
  contactTagNames: [],
  dealTagIds: [],
  dealTagNames: [],
  contactCustomFields: {},
  dealCustomFields: {},
  depth: 0,
};

// Config como ficou no banco: "Selecionar tudo" + channelId do canal excluído.
const staleCfg = {
  content: "Olá, bem vindo(a) a Cruzeiro do Sul Virtual",
  channelScope: "all",
  channelIds: [],
  channelId: "ch-deleted-c3q8ro",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.ensureConv.mockResolvedValue({ conversationId: "conv-1" });
  h.sendText.mockResolvedValue({ messages: [{ id: "wamid.1" }] });
});

describe("passo de envio com canal excluído", () => {
  it("envia e grava a mensagem sem o channelId morto (sem FK)", async () => {
    await run(staleCfg);

    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.messageCreate).toHaveBeenCalledTimes(1);
    const data = h.messageCreate.mock.calls[0]![0].data;
    expect(data.channelId).toBeUndefined();
    expect(data.externalId).toBe("wamid.1");
    // Não abre conversa amarrada ao canal excluído.
    expect(h.ensureConv.mock.calls[0]![1].channelId).toBeNull();
  });

  it("falha de envio grava a mensagem de erro sem o channelId morto", async () => {
    h.sendText.mockRejectedValue(new Error("(#131026) Message undeliverable"));

    await expect(run(staleCfg)).rejects.toThrow();

    expect(h.messageCreate).toHaveBeenCalledTimes(1);
    const data = h.messageCreate.mock.calls[0]![0].data;
    expect(data.sendStatus).toBe("failed");
    expect(data.channelId).toBeUndefined();
  });

  it("canal existente continua sendo gravado na mensagem", async () => {
    await run({ ...staleCfg, channelId: "ch-2310" });

    expect(h.messageCreate.mock.calls[0]![0].data.channelId).toBe("ch-2310");
  });
});
