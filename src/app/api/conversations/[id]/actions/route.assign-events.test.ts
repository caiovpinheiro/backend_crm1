/**
 * POST /api/conversations/:id/actions (assign | transfer) — tempo real.
 *
 * Antes: a rota só publicava `conversation_timeline_updated` (chatter). A
 * lista do Inbox ficava com o responsável, o departamento e a aba antigos até
 * o F5. Agora publica `conversation_updated` com responsável, departamento e
 * não lidas.
 *
 * O barramento é o REAL (só o snapshot do card, que vai ao Postgres, é
 * simulado): o teste confere o que cada conexão da org recebe.
 */
process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
process.env.SSE_ENABLE_REDIS_PUBSUB = "0";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SseEventEnvelope } from "@/lib/sse-bus";

const ORG = "org_1";
const USER_A = "user_a";
const USER_B = "user_b";
const ADMIN = "user_admin";

const h = vi.hoisted(() => ({
  conv: {
    id: "conv_1",
    contactId: "contact_1",
    externalId: "ext_1",
    assignedToId: "user_a" as string | null,
    departmentId: "dept_1" as string | null,
    unreadCount: 3,
    lastMessageAt: new Date("2026-10-07T12:00:00.000Z") as Date | null,
  },
  users: {
    user_a: { id: "user_a", name: "Ana", type: "HUMAN" },
    user_b: { id: "user_b", name: "Beto", type: "HUMAN" },
  } as Record<string, { id: string; name: string; type: string }>,
  assignResult: { ok: true } as { ok: true } | { ok: false; code: string },
  departments: { dept_1: "Vendas", dept_2: "Suporte" } as Record<string, string>,
  distributionAssignsTo: null as string | null,
  logEvent: vi.fn(async () => undefined),
}));

function assigneeOf(id: string | null) {
  return id ? (h.users[id] ?? null) : null;
}

vi.mock("@/lib/auth-helpers", () => ({
  isAdmin: () => true,
  isSuperAdmin: () => false,
  withOrgContext: async (cb: (s: unknown) => unknown) =>
    cb({ user: { id: "user_admin", role: "ADMIN", organizationId: "org_1", isSuperAdmin: false } }),
}));
vi.mock("@/lib/authz", () => ({ checkPermission: async () => true }));
vi.mock("@/lib/conversation-access", () => ({ requireConversationAccess: async () => null }));
vi.mock("@/lib/org-settings", () => ({ getOrgSettingBool: async () => false }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    conversation: {
      // Snapshot do card que o barramento anexa (uma leitura por evento).
      findFirst: vi.fn(async () => ({
        id: h.conv.id,
        number: 1,
        channel: "WHATSAPP",
        channelId: null,
        status: "OPEN",
        unreadCount: h.conv.unreadCount,
        hasError: false,
        hasHumanReply: true,
        hasAgentReply: true,
        lastInboundAt: null,
        lastMessageDirection: "in",
        closedAt: null,
        followUpAt: null,
        updatedAt: new Date("2026-10-07T12:00:00.000Z"),
        createdAt: new Date("2026-10-01T12:00:00.000Z"),
        assignedToId: h.conv.assignedToId,
        departmentId: h.conv.departmentId,
        tabulationId: null,
        pinnedNoteId: null,
        whatsappCallConsentStatus: null,
        department: null,
        assignedTo: assigneeOf(h.conv.assignedToId)
          ? { ...assigneeOf(h.conv.assignedToId)!, avatarUrl: null }
          : null,
        contact: {
          id: "contact_1",
          name: "Cliente",
          email: null,
          phone: "5511999999999",
          avatarUrl: null,
          automationContexts: [],
        },
      })),
    },
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentPermission: { findUnique: vi.fn(async () => null) },
    department: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        h.departments[where.id] ? { id: where.id, name: h.departments[where.id] } : null,
      ),
    },
    conversation: {
      findUnique: vi.fn(async (args: { select?: Record<string, unknown> }) => {
        const sel = args.select ?? {};
        const row: Record<string, unknown> = {
          id: h.conv.id,
          contactId: h.conv.contactId,
          externalId: h.conv.externalId,
          assignedToId: h.conv.assignedToId,
          assignedTo: assigneeOf(h.conv.assignedToId),
          departmentId: h.conv.departmentId,
          department: h.conv.departmentId
            ? { id: h.conv.departmentId, name: h.departments[h.conv.departmentId] }
            : null,
          unreadCount: h.conv.unreadCount,
          lastMessageAt: h.conv.lastMessageAt,
          status: "OPEN",
        };
        return Object.fromEntries(Object.keys(sel).map((k) => [k, row[k]]));
      }),
      update: vi.fn(async ({ data }: { data: { departmentId?: string | null } }) => {
        if ("departmentId" in data) h.conv.departmentId = data.departmentId ?? null;
        return {};
      }),
    },
  },
}));
vi.mock("@/services/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/conversations")>();
  return {
    ...actual,
    activeConversationOnAccountWhere: vi.fn(),
    getConversationById: vi.fn(),
    resolveReopenDepartmentId: vi.fn(),
    updateConversationStatusInDb: vi.fn(),
    updateConversationStatusInTx: vi.fn(),
    withConversationNumberRetry: vi.fn(),
    assignConversationAssignedTo: vi.fn(async (_id: string, to: string | null) => {
      if (!h.assignResult.ok) return h.assignResult;
      h.conv.assignedToId = to;
      return {
        ok: true,
        conversation: {
          id: h.conv.id,
          status: "OPEN",
          externalId: h.conv.externalId,
          contactId: h.conv.contactId,
          assignedToId: to,
          assignedTo: assigneeOf(to),
        },
      };
    }),
  };
});
vi.mock("@/services/automation-triggers", () => ({ fireTrigger: vi.fn(async () => undefined) }));
vi.mock("@/services/deals", () => ({ createDealEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/activity-log", () => ({
  logEvent: h.logEvent,
  userIdForFk: (id: string) => id,
}));
vi.mock("@/services/activity-outbox", () => ({ insertActivityOutbox: vi.fn() }));
vi.mock("@/lib/distribution-execute-queue", () => ({
  runDistributionExecuteOrInline: async (_p: unknown, inline: () => Promise<unknown>) => ({
    kind: "result",
    result: await inline(),
  }),
}));
vi.mock("@/services/distribution", () => ({
  executeDistribution: vi.fn(async () => {
    if (h.distributionAssignsTo) h.conv.assignedToId = h.distributionAssignsTo;
    return {
      success: true,
      reason: "ASSIGNED",
      selectedUserId: h.distributionAssignsTo,
      selectedUserName: assigneeOf(h.distributionAssignsTo)?.name ?? null,
    };
  }),
}));
vi.mock("@/services/tabulations", () => ({
  assertLeafInDepartments: vi.fn(),
  assertLeafInOrg: vi.fn(),
  getAncestors: vi.fn(),
  listDepartmentsForUser: vi.fn(),
  listOrgDepartments: vi.fn(),
  tabulationLogMeta: vi.fn(),
}));
vi.mock("@/services/ai/inbound-debounce", () => ({
  cancelAiReplyDebounce: vi.fn(),
  kickAiAfterInboxAssign: vi.fn(),
}));
vi.mock("@/services/ai-v2/state", () => ({ resetV2ConversationStateOwner: vi.fn() }));

import { POST } from "@/app/api/conversations/[id]/actions/route";
import { sseBus } from "@/lib/sse-bus";

type Received = Array<{ event: string; envelope: SseEventEnvelope }>;
const unsubs: Array<() => void> = [];

function listen(organizationId: string, userId: string): Received {
  const received: Received = [];
  unsubs.push(
    sseBus.subscribe({ organizationId, userId, isSuperAdmin: false }, (event, envelope) =>
      received.push({ event, envelope }),
    ),
  );
  return received;
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("evento não chegou a tempo");
    await new Promise<void>((r) => setImmediate(r));
  }
}

function call(body: Record<string, unknown>) {
  return POST(
    new Request("https://api.test/api/conversations/conv_1/actions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "conv_1" }) },
  );
}

function updates(box: Received) {
  return box.filter((r) => r.event === "conversation_updated");
}

beforeEach(() => {
  h.conv.assignedToId = USER_A;
  h.conv.departmentId = "dept_1";
  h.conv.unreadCount = 3;
  h.assignResult = { ok: true };
  h.distributionAssignsTo = null;
  h.logEvent.mockClear();
});

afterEach(() => {
  while (unsubs.length) unsubs.pop()?.();
});

describe("transferência/atribuição publica conversation_updated", () => {
  it("transferir A -> B: responsável anterior, novo e o resto da org recebem o evento com os campos certos", async () => {
    const boxA = listen(ORG, USER_A);
    const boxB = listen(ORG, USER_B);
    const boxAdmin = listen(ORG, ADMIN);
    const boxOtherOrg = listen("org_2", "user_x");

    const res = await call({ action: "transfer", assignedToId: USER_B });
    expect(res.status).toBe(200);

    await waitFor(() => updates(boxA).length >= 1 && updates(boxB).length >= 1);
    for (const box of [boxA, boxB, boxAdmin]) {
      await waitFor(() => updates(box).length >= 1);
      expect(updates(box)).toHaveLength(1);
      const data = updates(box)[0].envelope.data as Record<string, unknown>;
      expect(data).toMatchObject({
        organizationId: ORG,
        conversationId: "conv_1",
        contactId: "contact_1",
        assignedToId: USER_B,
        assignedTo: { id: USER_B, name: "Beto", type: "HUMAN" },
        departmentId: "dept_1",
        previousAssignedToId: USER_A,
        unreadCount: 3,
        lastMessageAt: "2026-10-07T12:00:00.000Z",
      });
      // O barramento anexa o card (o gate por usuário decide se segue).
      expect(data.card).toMatchObject({ id: "conv_1", assignedToId: USER_B });
    }
    // Outra organização não recebe nada.
    expect(boxOtherOrg).toHaveLength(0);
  });

  it("assign: 'assumir' (sem responsável -> eu) publica o evento", async () => {
    h.conv.assignedToId = null;
    const box = listen(ORG, USER_B);

    const res = await call({ action: "assign", assignedToId: USER_B });
    expect(res.status).toBe(200);

    await waitFor(() => updates(box).length >= 1);
    expect(updates(box)[0].envelope.data).toMatchObject({
      assignedToId: USER_B,
      assignedTo: { id: USER_B, name: "Beto" },
      previousAssignedToId: null,
    });
  });

  it("assign: remover responsável publica assignedTo null", async () => {
    const box = listen(ORG, USER_A);

    const res = await call({ action: "assign", assignedToId: null });
    expect(res.status).toBe(200);

    await waitFor(() => updates(box).length >= 1);
    expect(updates(box)[0].envelope.data).toMatchObject({
      assignedToId: null,
      assignedTo: null,
      previousAssignedToId: USER_A,
    });
  });

  it("transferir para departamento: publica o departamento novo e o responsável que a distribuição escolheu", async () => {
    h.distributionAssignsTo = USER_B;
    const box = listen(ORG, USER_B);

    const res = await call({ action: "transfer", departmentId: "dept_2" });
    expect(res.status).toBe(200);

    await waitFor(() => updates(box).length >= 1);
    expect(updates(box)).toHaveLength(1);
    expect(updates(box)[0].envelope.data).toMatchObject({
      departmentId: "dept_2",
      assignedToId: USER_B,
      assignedTo: { id: USER_B, name: "Beto" },
      previousAssignedToId: USER_A,
    });
  });

  it("transferir agente + departamento na mesma chamada publica UM evento", async () => {
    const box = listen(ORG, USER_A);

    const res = await call({ action: "transfer", assignedToId: USER_B, departmentId: "dept_2" });
    expect(res.status).toBe(200);

    await waitFor(() => updates(box).length >= 1);
    // Dá chance a um segundo evento (indevido) de chegar.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(updates(box)).toHaveLength(1);
    expect(updates(box)[0].envelope.data).toMatchObject({
      assignedToId: USER_B,
      departmentId: "dept_2",
      previousAssignedToId: USER_A,
    });
  });

  it("sem mudança (mesmo responsável e departamento) não publica", async () => {
    const box = listen(ORG, USER_B);

    const res = await call({ action: "transfer", assignedToId: USER_A, departmentId: "dept_1" });
    expect(res.status).toBe(200);

    await new Promise<void>((r) => setTimeout(r, 30));
    expect(updates(box)).toHaveLength(0);
  });

  it("atribuição negada não publica", async () => {
    h.assignResult = { ok: false, code: "FORBIDDEN" };
    const box = listen(ORG, USER_B);

    const res = await call({ action: "assign", assignedToId: USER_B });
    expect(res.status).toBe(403);

    await new Promise<void>((r) => setTimeout(r, 30));
    expect(updates(box)).toHaveLength(0);
  });
});
