/**
 * Identificação do visitante: o que ele digita NUNCA liga, funde nem
 * sobrescreve outro contato. O visitante fica no contato nascido no webchat
 * e o agente recebe a nota de "possível duplicado" na conversa.
 *
 * Banco em memória (só o que identify/ensureVisitorContact/duplicate-notice
 * usam) e o `ensureVisitorContact` REAL — o teste cobre a regra de posse
 * (`webchatVisitorId === session.id`) de ponta a ponta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };

  const db = {
    contacts: [] as Row[],
    conversations: [] as Row[],
    messages: [] as Row[],
    seq: 0,
  };

  /** Casa um `where` simples do Prisma (o subconjunto usado aqui). */
  function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, cond]) => {
      const v = row[k];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
        const c = cond as Row;
        if ("not" in c) return v !== c.not;
        if ("in" in c) return (c.in as unknown[]).includes(v);
        if ("equals" in c) {
          return c.mode === "insensitive"
            ? String(v ?? "").toLowerCase() === String(c.equals).toLowerCase()
            : v === c.equals;
        }
        return false;
      }
      return v === cond;
    });
  }
  function pick(row: Row | undefined, select?: Row): Row | null {
    if (!row) return null;
    if (!select) return { ...row };
    const out: Row = {};
    for (const k of Object.keys(select)) out[k] = row[k];
    return out;
  }
  const byCreated = (a: Row, b: Row) => (a.createdAt as number) - (b.createdAt as number);

  const prisma = {
    contact: {
      findFirst: vi.fn(async ({ where, select }: { where?: Row; select?: Row }) =>
        pick([...db.contacts].sort(byCreated).find((c) => matches(c, where)), select),
      ),
      findUnique: vi.fn(async ({ where, select }: { where: Row; select?: Row }) =>
        pick(db.contacts.find((c) => c.id === where.id), select),
      ),
      findMany: vi.fn(async ({ where, select, take }: { where?: Row; select?: Row; take?: number }) =>
        [...db.contacts]
          .sort(byCreated)
          .filter((c) => matches(c, where))
          .slice(0, take ?? 1000)
          .map((c) => pick(c, select)),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = db.contacts.filter((c) => matches(c, where));
        for (const c of hit) Object.assign(c, data);
        return { count: hit.length };
      }),
      update: vi.fn(async () => {
        throw new Error("identify não pode usar contact.update (sem guarda de posse)");
      }),
      delete: vi.fn(async () => {
        throw new Error("identify nunca apaga contato");
      }),
      deleteMany: vi.fn(async () => {
        throw new Error("identify nunca apaga contato");
      }),
    },
    conversation: {
      findFirst: vi.fn(async ({ where, select }: { where?: Row; select?: Row }) =>
        pick(db.conversations.find((c) => matches(c, where)), select),
      ),
    },
    message: {
      findFirst: vi.fn(async ({ where, select }: { where?: Row; select?: Row }) =>
        pick(db.messages.find((m) => matches(m, where)), select),
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = {
          id: `msg-${++db.seq}`,
          organizationId: "org-1",
          externalId: null,
          createdAt: new Date(),
          ...data,
        };
        db.messages.push(row);
        return row;
      }),
      updateMany: vi.fn(async () => {
        throw new Error("identify nunca move mensagens");
      }),
    },
    deal: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    webchatSession: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => {
        throw new Error("identify nunca repontua sessões em massa");
      }),
    },
  };

  return {
    logger,
    db,
    prisma,
    insertContact: vi.fn(async (data: Row) => {
      const row: Row = { id: `ct-new-${++db.seq}`, number: 900 + db.seq, createdAt: Date.now(), ...data };
      db.contacts.push(row);
      return { id: row.id as string, name: row.name as string };
    }),
    publishContactUpdated: vi.fn(),
    publishConversationUpdated: vi.fn(),
    publishNewMessage: vi.fn(),
    fireTrigger: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/lib/cache/message-versions", () => ({
  noteMessageChange: vi.fn(async () => {}),
  noteMessageRowChange: vi.fn(async () => {}),
}));
vi.mock("@/lib/cache/keys", () => ({ invalidateBoardData: vi.fn(async () => {}) }));
vi.mock("@/lib/realtime-events", () => ({
  publishContactUpdated: mocks.publishContactUpdated,
  publishConversationUpdated: mocks.publishConversationUpdated,
  publishNewMessage: mocks.publishNewMessage,
}));
// Dependências do inbound que identify não exercita.
vi.mock("@/lib/web-push", () => ({ notifyInboundMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/conversation-inbound", () => ({ touchInbound: vi.fn(), warnTouchInboundFailed: vi.fn() }));
vi.mock("@/lib/message-dedup", () => ({ createMessageDedup: vi.fn() }));
vi.mock("@/lib/webchat/session", () => ({ contactTrackingFromSession: () => ({}) }));
vi.mock("@/services/ai/attendance-gate", () => ({ inheritContactAssigneeForNewTicket: async () => null }));
vi.mock("@/services/auto-deals", () => ({ ensureOpenDealForContact: vi.fn(async () => {}) }));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: mocks.fireTrigger,
  buildMessageTriggerData: (d: unknown) => d,
  emitConversationCreated: vi.fn(),
  openingMessageTriggerExtra: () => ({}),
}));
vi.mock("@/services/contacts", () => ({
  insertContactWithNextNumber: mocks.insertContact,
  isPrismaUniqueViolation: () => false,
}));
vi.mock("@/services/conversations", () => ({
  activeConversationOnAccountWhere: (a: unknown) => a,
  isActiveConversationUniqueViolation: () => false,
  withConversationNumberRetry: (fn: (n: number) => Promise<unknown>) => fn(1),
}));
vi.mock("@/services/distribution", () => ({ maybeDistributeNewInboundTicket: vi.fn(async () => {}) }));

import {
  WebchatIdentifyError,
  identifyWebchatVisitor,
  ownVisitorContactView,
  parseWebchatIdentity,
  renameAnonymousVisitorDeals,
} from "@/lib/webchat/identify";
import type { WebchatSessionRow } from "@/lib/webchat/session";

const VISITOR = "wv_visitor_1";

function session(contactId: string | null): WebchatSessionRow {
  return {
    id: VISITOR,
    organizationId: "org-1",
    channelId: "ch-1",
    contactId,
    tokenHash: "h",
    prevTokenHash: null,
    rotatedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    firstUrl: null,
    lastUrl: null,
    referrer: null,
    utm: null,
    createdAt: new Date(),
  };
}

const ANA = {
  id: "ct-ana",
  number: 42,
  name: "Ana Souza",
  email: "ana@cliente.com",
  phone: "+5511987654321",
  webchatVisitorId: null,
  createdAt: 1,
};
const BRUNO = {
  id: "ct-bruno",
  number: 43,
  name: "Bruno Lima",
  email: "bruno@cliente.com",
  phone: "+5521912345678",
  webchatVisitorId: "wv_outro_visitante",
  createdAt: 2,
};
const OWN = {
  id: "ct-own",
  number: 99,
  name: "Visitante itor_1",
  email: null,
  phone: null,
  webchatVisitorId: VISITOR,
  createdAt: 3,
};

function seed(opts: { own?: boolean; ownConversation?: boolean } = {}) {
  mocks.db.contacts.splice(0, mocks.db.contacts.length, { ...ANA }, { ...BRUNO });
  if (opts.own !== false) mocks.db.contacts.push({ ...OWN });
  mocks.db.conversations.splice(
    0,
    mocks.db.conversations.length,
    // Tickets webchat dos contatos existentes (o que o widget expunha antes).
    { id: "conv-ana", contactId: "ct-ana", channel: "webchat", channelId: "ch-1", status: "OPEN" },
    { id: "conv-bruno", contactId: "ct-bruno", channel: "webchat", channelId: "ch-1", status: "OPEN" },
  );
  if (opts.ownConversation !== false && opts.own !== false) {
    mocks.db.conversations.push({
      id: "conv-own",
      contactId: "ct-own",
      channel: "webchat",
      channelId: "ch-1",
      status: "OPEN",
    });
  }
  mocks.db.messages.splice(0, mocks.db.messages.length);
}

const contactById = (id: string) => mocks.db.contacts.find((c) => c.id === id);
const notesIn = (conversationId: string) =>
  mocks.db.messages.filter((m) => m.conversationId === conversationId && m.messageType === "note");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.seq = 0;
  seed();
});

// session.id "wv_visitor_1" → placeholder "Visitante itor_1"
const PLACEHOLDER = "Negócio Visitante itor_1";

describe("renameAnonymousVisitorDeals", () => {
  it("renomeia o deal aberto que ainda tem o título do visitante anônimo", async () => {
    mocks.prisma.deal.findMany.mockResolvedValueOnce([{ id: "d1", stage: { pipelineId: "p1" } }]);
    mocks.prisma.deal.updateMany.mockResolvedValueOnce({ count: 1 });
    const n = await renameAnonymousVisitorDeals("org-1", "ct-1", VISITOR, "Ana Souza");
    expect(n).toBe(1);
    expect(mocks.prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: "ct-1", status: "OPEN", title: PLACEHOLDER } }),
    );
    expect(mocks.prisma.deal.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["d1"] }, title: PLACEHOLDER },
      data: { title: "Negócio Ana Souza" },
    });
  });

  it("sem nome real (vazio/placeholder) não consulta nem renomeia", async () => {
    expect(await renameAnonymousVisitorDeals("org-1", "ct-1", VISITOR, null)).toBe(0);
    expect(await renameAnonymousVisitorDeals("org-1", "ct-1", VISITOR, "Visitante itor_1")).toBe(0);
    expect(mocks.prisma.deal.findMany).not.toHaveBeenCalled();
  });
});

describe("parseWebchatIdentity", () => {
  it("normaliza e-mail e telefone; rejeita inválidos", () => {
    expect(parseWebchatIdentity({ name: " Ana ", email: "ANA@X.COM", phone: "(11) 98765-4321" })).toEqual({
      name: "Ana",
      email: "ana@x.com",
      phone: "+5511987654321",
    });
    expect(() => parseWebchatIdentity({ email: "nao-e-email" })).toThrow(WebchatIdentifyError);
    expect(() => parseWebchatIdentity({ phone: "abc" })).toThrow(WebchatIdentifyError);
  });
});

describe("identifyWebchatVisitor — nunca liga a contato existente", () => {
  it("e-mail de outro contato: sessão fica no contato próprio, o existente não muda e sai a nota", async () => {
    const s = session("ct-own");
    const res = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: null, email: "ana@cliente.com", phone: null },
    });

    expect(res).toEqual({ contactId: "ct-own", possibleDuplicates: 1 });
    expect(s.contactId).toBe("ct-own");
    // Nenhuma escrita na sessão apontando para o contato da Ana.
    for (const call of mocks.prisma.webchatSession.update.mock.calls as unknown as [{ data: Row }][]) {
      expect(call[0].data.contactId).not.toBe("ct-ana");
    }
    expect(contactById("ct-ana")).toEqual(ANA);
    expect(contactById("ct-own")).toMatchObject({ email: "ana@cliente.com", webchatVisitorId: VISITOR });

    // Nota interna de possível duplicado na conversa DO VISITANTE.
    const notes = notesIn("conv-own");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      messageType: "note",
      isPrivate: true,
      direction: "out",
      senderName: "Webchat",
    });
    expect(notes[0]!.content).toContain("ana@cliente.com");
    expect(notes[0]!.content).toContain("Ana Souza (#42)");
    expect(notes[0]!.content).toContain("possível duplicado");
    expect(notesIn("conv-ana")).toHaveLength(0);
    expect(mocks.publishNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-own", messageType: "note" }),
    );
  });

  it("telefone de outro contato (com/sem o 9) também só vira nota", async () => {
    const s = session("ct-own");
    const res = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: "Fulano", email: null, phone: "+551187654321" },
    });
    expect(res).toEqual({ contactId: "ct-own", possibleDuplicates: 1 });
    expect(contactById("ct-ana")).toEqual(ANA);
    expect(contactById("ct-own")).toMatchObject({ name: "Fulano", phone: "+551187654321" });
    expect(notesIn("conv-own")[0]!.content).toContain("o telefone +551187654321");
  });

  it("visitante sem contato reivindicando dado alheio: cria o PRÓPRIO contato, sem nota (ainda sem ticket)", async () => {
    seed({ own: false });
    const s = session(null);
    const res = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: "Ana", email: "ana@cliente.com", phone: null },
    });
    expect(res.contactId).toMatch(/^ct-new-/);
    expect(res.possibleDuplicates).toBe(1);
    expect(s.contactId).toBe(res.contactId);
    expect(mocks.insertContact).toHaveBeenCalledWith(
      expect.objectContaining({ webchatVisitorId: VISITOR, email: "ana@cliente.com", name: "Ana" }),
      expect.anything(),
    );
    expect(mocks.prisma.webchatSession.update).toHaveBeenCalledWith({
      where: { id: VISITOR },
      data: { contactId: res.contactId },
    });
    expect(contactById("ct-ana")).toEqual(ANA);
    expect(mocks.db.messages).toHaveLength(0);
  });

  it("identifies encadeados (Ana → Bruno → e-mail novo) não fundem, não apagam e não sobrescrevem ninguém", async () => {
    const s = session("ct-own");
    await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: null, email: "ana@cliente.com", phone: null },
    });
    await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: null, email: null, phone: "+5521912345678" },
    });
    const last = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: "Carla", email: "carla@novo.com", phone: null },
    });

    expect(last).toEqual({ contactId: "ct-own", possibleDuplicates: 0 });
    expect(s.contactId).toBe("ct-own");
    expect(mocks.db.contacts).toHaveLength(3);
    expect(contactById("ct-ana")).toEqual(ANA);
    expect(contactById("ct-bruno")).toEqual(BRUNO);
    expect(contactById("ct-own")).toMatchObject({
      name: "Carla",
      email: "carla@novo.com",
      phone: "+5521912345678",
      webchatVisitorId: VISITOR,
    });
    expect(mocks.prisma.contact.delete).not.toHaveBeenCalled();
    expect(mocks.prisma.contact.deleteMany).not.toHaveBeenCalled();
    expect(mocks.prisma.message.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.webchatSession.updateMany).not.toHaveBeenCalled();
    // Uma nota por dado alheio, ambas no ticket do visitante.
    const notes = notesIn("conv-own");
    expect(notes).toHaveLength(2);
    expect(notes[0]!.content).toContain("Ana Souza (#42)");
    expect(notes[1]!.content).toContain("Bruno Lima (#43)");
  });

  it("repetir o mesmo dado não duplica a nota", async () => {
    const s = session("ct-own");
    const identity = { name: null, email: "ana@cliente.com", phone: null };
    await identifyWebchatVisitor({ organizationId: "org-1", session: s, identity });
    await identifyWebchatVisitor({ organizationId: "org-1", session: s, identity });
    expect(notesIn("conv-own")).toHaveLength(1);
  });

  it("sessão ligada a contato alheio (identify antigo): volta para um contato próprio e não toca no alheio", async () => {
    seed({ own: false });
    const s = session("ct-ana");
    const res = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: "Intruso", email: "intruso@x.com", phone: null },
    });
    expect(res.contactId).not.toBe("ct-ana");
    expect(s.contactId).toBe(res.contactId);
    expect(contactById("ct-ana")).toEqual(ANA);
    expect(await ownVisitorContactView(session("ct-ana"))).toBeNull();
  });

  it("sem nenhum dado → erro de validação", async () => {
    await expect(
      identifyWebchatVisitor({
        organizationId: "org-1",
        session: session(null),
        identity: { name: null, email: null, phone: null },
      }),
    ).rejects.toBeInstanceOf(WebchatIdentifyError);
  });
});

describe("ownVisitorContactView", () => {
  it("só devolve o contato nascido na sessão", async () => {
    expect(await ownVisitorContactView(session("ct-own"))).toMatchObject({
      id: "ct-own",
      identified: false,
    });
    expect(await ownVisitorContactView(session("ct-bruno"))).toBeNull();
    expect(await ownVisitorContactView(session(null))).toBeNull();
  });
});
