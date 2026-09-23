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

  it("hidden em new_message tira texto, mídia e nomes; mantém ids", () => {
    const full = {
      ...inbound,
      contactId: "ct_1",
      timestamp: "2026-09-23T10:00:00Z",
      assignedToId: "u_outro",
      content: "texto do cliente",
      senderName: "Marcelo",
      mediaUrl: "https://x/y.jpg",
      caption: "legenda",
      contactName: "Marcelo",
      card: { id: "conv_1", assignedToId: "u_outro" },
    };
    expect(stripHiddenInboxSseCard(full, () => false, "new_message")).toEqual({
      organizationId: "org_a",
      conversationId: "conv_1",
      contactId: "ct_1",
      direction: "in",
      messageType: "text",
      timestamp: "2026-09-23T10:00:00Z",
      assignedToId: "u_outro",
      cardOmitted: "hidden",
    });
  });

  it("budget em new_message também sai sem conteúdo", () => {
    const withText = { ...inbound, content: "segredo", senderName: "X" };
    expect(markInboxCardOmittedByBudget("new_message", withText, withText)).toEqual({
      ...inbound,
      cardOmitted: "budget",
    });
  });

  it("conversation_updated hidden mantém os campos (patch de status/responsável)", () => {
    const upd = { organizationId: "org_a", conversationId: "c", status: "OPEN", card: { id: "c" } };
    expect(stripHiddenInboxSseCard(upd, () => false, "conversation_updated")).toEqual({
      organizationId: "org_a",
      conversationId: "c",
      status: "OPEN",
      cardOmitted: "hidden",
    });
  });

  it("gate aceitou → envelope intacto", () => {
    const withCard = { ...inbound, card: { id: "conv_1" } };
    expect(stripHiddenInboxSseCard(withCard, () => true)).toBe(withCard);
  });
});
