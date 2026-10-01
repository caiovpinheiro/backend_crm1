/**
 * Painel do negócio — qual ticket do contato vem primeiro em
 * `GET /api/deals/:id` (`contact.conversations[0]` é "a conversa do negócio"
 * no Kanban e no Flow).
 *
 * Sintoma que estes testes travam: card com prévia de mensagem abrindo
 * "Nenhuma mensagem nesta conversa." porque, sem ticket ativo, o primeiro da
 * lista era só o de `updatedAt` mais recente — muitas vezes um ticket aberto
 * e encerrado sem nenhuma mensagem — e não o que tem a última mensagem do
 * contato (a mesma que alimenta a prévia do card).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb, INBOX_SCHEMA } from "@/test-setup/fake-db";

const h = vi.hoisted(() => ({
  db: null as unknown as import("@/test-setup/fake-db").FakeDb,
  groupBy: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  findUnique: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));

vi.mock("@/lib/prisma", () => {
  h.groupBy = vi.fn(async (args: { where: Record<string, unknown> }) => {
    const latest = new Map<string, Date>();
    for (const row of h.db.table("message")) {
      if (!h.db.matches("message", row, args.where)) continue;
      const id = row.conversationId as string;
      const at = row.createdAt as Date;
      const cur = latest.get(id);
      if (!cur || at > cur) latest.set(id, at);
    }
    return [...latest].map(([conversationId, createdAt]) => ({
      conversationId,
      _max: { createdAt },
    }));
  });
  h.findUnique = vi.fn();
  return {
    prisma: { message: { groupBy: h.groupBy }, deal: { findUnique: h.findUnique } },
    allocateOrgNumber: vi.fn(),
  };
});
vi.mock("@/lib/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/request-context")>()),
  getOrgIdOrThrow: () => "org_1",
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: async () => undefined,
}));

import {
  orderConversationsForDealPanel,
  preferConversationWithLastMessage,
} from "@/services/deal-panel-conversation";
import { getDealById } from "@/services/deals";

const day = (d: string) => new Date(`2026-${d}T12:00:00.000Z`);

type Conv = { id: string; status: "OPEN" | "RESOLVED" | "PENDING" | "SNOOZED"; channel: string };
const conv = (id: string, status: Conv["status"], channel = "whatsapp"): Conv => ({
  id,
  status,
  channel,
});

type SeedMessage = {
  id: string;
  conversationId: string;
  at: Date;
  messageType?: string;
  direction?: string;
  isPrivate?: boolean;
};

function seedMessages(rows: SeedMessage[]) {
  h.db = new FakeDb(INBOX_SCHEMA);
  for (const r of rows) {
    h.db.insert("message", {
      id: r.id,
      conversationId: r.conversationId,
      createdAt: r.at,
      messageType: r.messageType ?? "text",
      direction: r.direction ?? "in",
      isPrivate: r.isPrivate ?? false,
    });
  }
}

const ids = (list: { id: string }[]) => list.map((c) => c.id);

beforeEach(() => {
  vi.clearAllMocks();
  seedMessages([]);
});

describe("orderConversationsForDealPanel (puro)", () => {
  it("ticket ativo continua na frente, mesmo vazio", () => {
    const out = orderConversationsForDealPanel(
      [conv("velho", "RESOLVED"), conv("ativo", "OPEN")],
      new Map([["velho", day("07-06")]]),
    );
    expect(ids(out)).toEqual(["ativo", "velho"]);
  });

  it("só encerrados: o da mensagem mais recente primeiro; vazios por último na ordem do banco", () => {
    const out = orderConversationsForDealPanel(
      [
        conv("vazio_a", "RESOLVED"),
        conv("antigo", "RESOLVED"),
        conv("vazio_b", "RESOLVED"),
        conv("recente", "RESOLVED"),
      ],
      new Map([
        ["antigo", day("06-08")],
        ["recente", day("07-06")],
      ]),
    );
    expect(ids(out)).toEqual(["recente", "antigo", "vazio_a", "vazio_b"]);
  });
});

describe("preferConversationWithLastMessage", () => {
  it("ticket atual vazio + mensagens em ticket anterior: abre o que tem as mensagens", async () => {
    // Caso do negócio #463: ticket Nº 32344 encerrado em 25/07 sem mensagens;
    // a mensagem da prévia (06/07) está no ticket anterior.
    seedMessages([{ id: "m1", conversationId: "t_anterior", at: day("07-06") }]);
    const out = await preferConversationWithLastMessage([
      conv("t_32344_vazio", "RESOLVED"),
      conv("t_anterior", "RESOLVED"),
    ]);
    expect(ids(out)).toEqual(["t_anterior", "t_32344_vazio"]);
    expect(h.groupBy).toHaveBeenCalledTimes(1);
  });

  it("tickets em dois canais: vence o canal da última mensagem do contato", async () => {
    seedMessages([
      { id: "w1", conversationId: "t_whatsapp", at: day("06-01") },
      { id: "i1", conversationId: "t_instagram", at: day("07-18") },
    ]);
    const out = await preferConversationWithLastMessage([
      conv("t_whatsapp_vazio", "RESOLVED", "whatsapp"),
      conv("t_whatsapp", "RESOLVED", "whatsapp"),
      conv("t_instagram", "RESOLVED", "instagram"),
    ]);
    expect(ids(out)).toEqual(["t_instagram", "t_whatsapp", "t_whatsapp_vazio"]);
  });

  it("evento, nota interna e rascunho de IA não contam como mensagem (critério da prévia do card)", async () => {
    seedMessages([
      { id: "e1", conversationId: "t_so_evento", at: day("07-25"), messageType: "event:encerramento", direction: "system" },
      { id: "e2", conversationId: "t_so_evento", at: day("07-25"), messageType: "event:atribuicao", direction: "out" },
      { id: "n1", conversationId: "t_so_evento", at: day("07-25"), messageType: "note", direction: "out", isPrivate: true },
      { id: "d1", conversationId: "t_so_evento", at: day("07-25"), messageType: "ai_draft", direction: "out" },
      { id: "m1", conversationId: "t_com_chat", at: day("07-06") },
    ]);
    const out = await preferConversationWithLastMessage([
      conv("t_so_evento", "RESOLVED"),
      conv("t_com_chat", "RESOLVED"),
    ]);
    expect(ids(out)).toEqual(["t_com_chat", "t_so_evento"]);
  });

  it("ticket atual com mensagens fica onde está (não regride)", async () => {
    seedMessages([
      { id: "m2", conversationId: "t_atual", at: day("07-25") },
      { id: "m1", conversationId: "t_anterior", at: day("07-06") },
    ]);
    const out = await preferConversationWithLastMessage([
      conv("t_atual", "RESOLVED"),
      conv("t_anterior", "RESOLVED"),
    ]);
    expect(ids(out)).toEqual(["t_atual", "t_anterior"]);
  });

  it("com ticket ativo ou um ticket só não consulta mensagens", async () => {
    const comAtivo = [conv("t_ativo", "OPEN"), conv("t_antigo", "RESOLVED")];
    expect(await preferConversationWithLastMessage(comAtivo)).toBe(comAtivo);
    const unico = [conv("t_unico", "RESOLVED")];
    expect(await preferConversationWithLastMessage(unico)).toBe(unico);
    expect(h.groupBy).not.toHaveBeenCalled();
  });

  it("falha na consulta mantém a ordem original (não derruba o detalhe do negócio)", async () => {
    h.groupBy.mockRejectedValueOnce(new Error("boom"));
    const list = [conv("a", "RESOLVED"), conv("b", "RESOLVED")];
    expect(ids(await preferConversationWithLastMessage(list))).toEqual(["a", "b"]);
  });
});

describe("getDealById", () => {
  const dealWith = (conversations: Conv[]) => ({
    id: "deal_463",
    number: 463,
    contact: { id: "ct_1", conversations },
  });

  it("no detalhe do painel (`conversationWithLastMessageFirst`) o ticket com mensagens vem primeiro", async () => {
    seedMessages([{ id: "m1", conversationId: "t_anterior", at: day("07-06") }]);
    h.findUnique.mockResolvedValueOnce(
      dealWith([conv("t_32344_vazio", "RESOLVED"), conv("t_anterior", "RESOLVED")]),
    );
    const deal = await getDealById("deal_463", { conversationWithLastMessageFirst: true });
    expect(ids(deal!.contact!.conversations)).toEqual(["t_anterior", "t_32344_vazio"]);
  });

  it("sem a opção (demais rotas) não faz a consulta extra", async () => {
    h.findUnique.mockResolvedValueOnce(
      dealWith([conv("t_32344_vazio", "RESOLVED"), conv("t_anterior", "RESOLVED")]),
    );
    const deal = await getDealById("deal_463");
    expect(ids(deal!.contact!.conversations)).toEqual(["t_32344_vazio", "t_anterior"]);
    expect(h.groupBy).not.toHaveBeenCalled();
  });
});
