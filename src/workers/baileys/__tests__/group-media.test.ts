/**
 * Mensagem de grupo (WhatsApp QR): mídia é baixada e guardada como no
 * inbox; o nome do perfil vai para o participante (LID + telefone).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const groups = vi.hoisted(() => ({
  appendWhatsAppGroupMessage: vi.fn(),
  findWhatsAppGroupByJid: vi.fn(),
  learnGroupMemberName: vi.fn(),
  findGroupMessageByWaId: vi.fn(),
  applyGroupMessageReaction: vi.fn(),
  groupQuoteAuthor: (m: { fromMe: boolean; fromName: string | null }) => (m.fromMe ? "Você" : m.fromName),
  GROUP_MEDIA_TYPES: new Set(["image", "video", "audio", "ptt", "document", "sticker"]),
}));
const media = vi.hoisted(() => ({ download: vi.fn(), save: vi.fn() }));

vi.mock("@/services/whatsapp-groups", () => groups);
vi.mock("@whiskeysockets/baileys", async (orig) => ({
  ...(await orig<typeof import("@whiskeysockets/baileys")>()),
  downloadMediaMessage: media.download,
}));
vi.mock("@/lib/storage/local", () => ({
  generateFileName: ({ ext }: { ext: string }) => `wa-1.${ext}`,
  saveFile: media.save,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

const { handleBaileysMessage, groupMediaMeta } = await import("../message-handler");

const GROUP = "120363@g.us";
const sock = {} as never;

function groupMsg(message: Record<string, unknown>, key: Record<string, unknown> = {}) {
  return {
    key: { remoteJid: GROUP, id: "W1", fromMe: false, participant: "77@lid", participantAlt: "5511944690752@s.whatsapp.net", ...key },
    pushName: "Caio",
    message,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  groups.findWhatsAppGroupByJid.mockResolvedValue({ id: "g1", organizationId: "org1" });
  groups.appendWhatsAppGroupMessage.mockResolvedValue({ id: "m1" });
  groups.learnGroupMemberName.mockResolvedValue(1);
  media.download.mockResolvedValue(Buffer.from("x"));
  media.save.mockResolvedValue({ url: "/api/storage/org1/inbound-media/wa-1.ogg" });
});

describe("mensagem recebida em grupo", () => {
  it("áudio de voz é baixado e gravado como ptt com o arquivo", async () => {
    await handleBaileysMessage("ch1", groupMsg({ audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } }), sock);
    expect(media.save).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org1", bucket: "inbound-media" }));
    expect(groups.appendWhatsAppGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "g1",
        messageType: "ptt",
        mediaUrl: "/api/storage/org1/inbound-media/wa-1.ogg",
        mimeType: "audio/ogg",
        fromPhone: "+5511944690752",
      }),
    );
  });

  it("documento guarda o nome do arquivo", async () => {
    media.save.mockResolvedValue({ url: "/api/storage/org1/inbound-media/wa-1.pdf" });
    await handleBaileysMessage(
      "ch1",
      groupMsg({ documentMessage: { mimetype: "application/pdf", fileName: "proposta.pdf" } }),
      sock,
    );
    expect(groups.appendWhatsAppGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "document", fileName: "proposta.pdf", text: "📎 proposta.pdf" }),
    );
  });

  it("download falhou: grava a mensagem sem arquivo, com o rótulo", async () => {
    media.download.mockRejectedValue(new Error("expirou"));
    await handleBaileysMessage("ch1", groupMsg({ imageMessage: { mimetype: "image/jpeg" } }), sock);
    expect(groups.appendWhatsAppGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "image", mediaUrl: null, text: "[image]" }),
    );
  });

  it("texto segue como texto e ensina o nome do perfil pelo LID e pelo telefone", async () => {
    await handleBaileysMessage("ch1", groupMsg({ conversation: "Olá!" }), sock);
    expect(media.download).not.toHaveBeenCalled();
    expect(groups.appendWhatsAppGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "text", text: "Olá!", mediaUrl: null }),
    );
    expect(groups.learnGroupMemberName).toHaveBeenCalledWith({
      groupId: "g1",
      jids: ["77@lid", "5511944690752@s.whatsapp.net"],
      phone: "5511944690752",
      name: "Caio",
    });
  });

  it("mensagem minha (outro aparelho) não troca nome de participante", async () => {
    await handleBaileysMessage("ch1", groupMsg({ conversation: "oi" }, { fromMe: true }), sock);
    expect(groups.learnGroupMemberName).not.toHaveBeenCalled();
  });

  it("grupo desconhecido: não baixa nada", async () => {
    groups.findWhatsAppGroupByJid.mockResolvedValue(null);
    await handleBaileysMessage("ch1", groupMsg({ imageMessage: { mimetype: "image/jpeg" } }), sock);
    expect(media.download).not.toHaveBeenCalled();
    expect(groups.appendWhatsAppGroupMessage).not.toHaveBeenCalled();
  });
});

describe("groupMediaMeta", () => {
  it("lê tipo e nome do arquivo da mídia", () => {
    expect(
      groupMediaMeta({ message: { documentMessage: { mimetype: "application/pdf; x=1", fileName: " a.pdf " } } } as never),
    ).toEqual({ mimeType: "application/pdf", fileName: "a.pdf" });
    expect(groupMediaMeta({ message: { conversation: "oi" } } as never)).toEqual({ mimeType: null, fileName: null });
  });
});

describe("reação e resposta que chegam do grupo", () => {
  it("reação aponta para a mensagem pelo id do WhatsApp", async () => {
    groups.findGroupMessageByWaId.mockResolvedValue({ id: "m1", reactions: [] });
    await handleBaileysMessage("ch1", groupMsg({ reactionMessage: { text: "❤️", key: { id: "WA1" } } }), sock);
    expect(groups.findGroupMessageByWaId).toHaveBeenCalledWith("g1", "WA1");
    expect(groups.applyGroupMessageReaction).toHaveBeenCalledWith("m1", [], {
      from: "77@lid",
      emoji: "❤️",
      name: "Caio",
    });
    expect(groups.appendWhatsAppGroupMessage).not.toHaveBeenCalled();
  });

  it("reação do próprio número (celular) conta como 'me'", async () => {
    groups.findGroupMessageByWaId.mockResolvedValue({ id: "m1", reactions: [] });
    await handleBaileysMessage(
      "ch1",
      groupMsg({ reactionMessage: { text: "", key: { id: "WA1" } } }, { fromMe: true }),
      sock,
    );
    expect(groups.applyGroupMessageReaction).toHaveBeenCalledWith("m1", [], { from: "me", emoji: "", name: null });
  });

  it("resposta grava a citação com autor da mensagem original", async () => {
    groups.findGroupMessageByWaId.mockResolvedValue({ id: "m1", text: "folha", fromMe: false, fromName: "Kleber Raia", fromPhone: null, reactions: [] });
    await handleBaileysMessage(
      "ch1",
      groupMsg({
        extendedTextMessage: {
          text: "certo",
          contextInfo: { stanzaId: "WA1", participant: "88@lid", quotedMessage: { conversation: "A escola falou que essa folha" } },
        },
      }),
      sock,
    );
    expect(groups.appendWhatsAppGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "certo",
        replyTo: { waId: "WA1", text: "A escola falou que essa folha", author: "Kleber Raia" },
      }),
    );
  });
});
