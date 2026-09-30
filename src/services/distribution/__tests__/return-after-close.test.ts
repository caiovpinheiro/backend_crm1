import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn(), findUnique: vi.fn() },
  activityEvent: { findFirst: vi.fn() },
  message: { findFirst: vi.fn() },
  contact: { findUnique: vi.fn() },
  deal: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));

const history = vi.hoisted(() => ({
  humanWasAssignedInThisConversation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/services/distribution/assignee-eligibility", () => ({
  isAssigneeCurrentlyEligible: vi.fn(async () => ({ eligible: true })),
  shouldClearOwnershipOnIneligible: vi.fn(() => false),
}));
vi.mock("@/services/distribution/human-assignment-history", () => history);

import { keepHumanAfterAutomationClose } from "@/services/distribution/return-after-close";

const ARGS = { conversationId: "conv-new", contactId: "contact-1" };

/** Ticket anterior encerrado por automação, com o consultor anterior. */
function previousTicketClosedByAutomation() {
  db.conversation.findFirst.mockResolvedValue({
    id: "conv-old",
    assignedToId: "user-previous",
    assignedTo: { type: "HUMAN" },
  });
  db.activityEvent.findFirst.mockResolvedValue({ actorType: "AUTOMATION", meta: {} });
  db.user.findFirst.mockResolvedValue({ id: "user-previous" });
}

describe("keepHumanAfterAutomationClose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previousTicketClosedByAutomation();
    db.$transaction.mockResolvedValue(undefined);
  });

  it("ticket novo sem responsável recebe o consultor do ticket anterior", async () => {
    db.conversation.findUnique.mockResolvedValue({ assignedToId: null, assignedTo: null });

    const kept = await keepHumanAfterAutomationClose(ARGS);

    expect(kept).toBe("user-previous");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("transferência feita nesta conversa não é desfeita pela mensagem do cliente", async () => {
    db.conversation.findUnique.mockResolvedValue({
      assignedToId: "user-transferred",
      assignedTo: { type: "HUMAN" },
    });
    history.humanWasAssignedInThisConversation.mockResolvedValue(true);

    const kept = await keepHumanAfterAutomationClose(ARGS);

    expect(kept).toBe("user-transferred");
    expect(history.humanWasAssignedInThisConversation).toHaveBeenCalledWith(
      "conv-new",
      "user-transferred",
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("responsável herdado (sem atribuição nesta conversa) volta para o consultor anterior", async () => {
    db.conversation.findUnique.mockResolvedValue({
      assignedToId: "user-inherited",
      assignedTo: { type: "HUMAN" },
    });
    history.humanWasAssignedInThisConversation.mockResolvedValue(false);

    const kept = await keepHumanAfterAutomationClose(ARGS);

    expect(kept).toBe("user-previous");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("sem ticket anterior encerrado por automação não mexe em nada", async () => {
    db.conversation.findFirst.mockResolvedValue(null);

    const kept = await keepHumanAfterAutomationClose(ARGS);

    expect(kept).toBeNull();
    expect(db.conversation.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
