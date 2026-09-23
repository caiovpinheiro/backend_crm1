process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
process.env.SSE_ENABLE_REDIS_PUBSUB = "0";

import { beforeAll, describe, expect, it } from "vitest";

import { stripHiddenInboxSseCard } from "@/lib/inbox-sse-card-visibility";

describe("cardOmitted no envelope do SSE", () => {
  let markInboxCardOmittedByBudget: typeof import("@/lib/sse-bus").markInboxCardOmittedByBudget;

  beforeAll(async () => {
    ({ markInboxCardOmittedByBudget } = await import("@/lib/sse-bus"));
  });

  const inbound = {
    organizationId: "org_a",
    conversationId: "conv_1",
    direction: "in",
    messageType: "text",
  };

  it("marca budget quando o card devia vir e não veio", () => {
    expect(markInboxCardOmittedByBudget("new_message", inbound, inbound)).toEqual({
      ...inbound,
      cardOmitted: "budget",
    });
  });

  it("não marca quando o card veio", () => {
    const withCard = { ...inbound, card: { id: "conv_1" } };
    expect(markInboxCardOmittedByBudget("new_message", inbound, withCard)).toBe(withCard);
  });

  it("não marca evento de timeline nem evento que não leva card", () => {
    const ev = { ...inbound, messageType: "event:assigned" };
    expect(markInboxCardOmittedByBudget("new_message", ev, ev)).toBe(ev);
    expect(markInboxCardOmittedByBudget("message_status", inbound, inbound)).toBe(inbound);
  });

  it("gate recusou → tira o card e marca hidden", () => {
    const withCard = { ...inbound, card: { id: "conv_1", assignedToId: "other" } };
    expect(stripHiddenInboxSseCard(withCard, () => false)).toEqual({
      ...inbound,
      cardOmitted: "hidden",
    });
  });

  it("gate aceitou → envelope intacto", () => {
    const withCard = { ...inbound, card: { id: "conv_1" } };
    expect(stripHiddenInboxSseCard(withCard, () => true)).toBe(withCard);
  });
});
