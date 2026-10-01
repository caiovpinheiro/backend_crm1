/**
 * Contrato dos eventos leves do chat (`typing`, `scheduled_message_updated`)
 * e o throttle do `typing` — sem Redis, sem DB, relógio falso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish } }));

import {
  __resetTypingThrottleForTests,
  publishScheduledMessageUpdated,
  publishTypingEvent,
  TYPING_THROTTLE_MS,
  TYPING_TTL_MS,
} from "@/lib/realtime-events";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");

describe("publishTypingEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    publish.mockReset();
    __resetTypingThrottleForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publica `typing` com conversationId, contactId, userId e until = agora + 5s", () => {
    const ok = publishTypingEvent({
      organizationId: "org_1",
      conversationId: "conv_1",
      contactId: "contact_1",
      userId: "user_a",
      userName: "  Ana  ",
    });
    expect(ok).toBe(true);
    expect(TYPING_TTL_MS).toBe(5_000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("typing", {
      organizationId: "org_1",
      conversationId: "conv_1",
      contactId: "contact_1",
      userId: "user_a",
      userName: "Ana",
      source: "agent",
      until: new Date(T0 + 5_000).toISOString(),
    });
  });

  it("no máximo 1 evento a cada 3s por conversa e agente", () => {
    expect(TYPING_THROTTLE_MS).toBe(3_000);
    const args = {
      organizationId: "org_1",
      conversationId: "conv_1",
      contactId: null,
      userId: "user_a",
    };
    expect(publishTypingEvent(args)).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(publishTypingEvent(args)).toBe(false);
    vi.advanceTimersByTime(1_999);
    expect(publishTypingEvent(args)).toBe(false);
    vi.advanceTimersByTime(1); // 3 000 ms exatos
    expect(publishTypingEvent(args)).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][1]).toMatchObject({
      until: new Date(T0 + 3_000 + 5_000).toISOString(),
    });
  });

  it("outro agente ou outra conversa não cai no throttle do primeiro", () => {
    const base = { organizationId: "org_1", contactId: null };
    expect(publishTypingEvent({ ...base, conversationId: "conv_1", userId: "user_a" })).toBe(true);
    expect(publishTypingEvent({ ...base, conversationId: "conv_1", userId: "user_b" })).toBe(true);
    expect(publishTypingEvent({ ...base, conversationId: "conv_2", userId: "user_a" })).toBe(true);
    expect(publishTypingEvent({ ...base, conversationId: "conv_1", userId: "user_a" })).toBe(false);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("source: contact fica reservado no contrato (userId null)", () => {
    publishTypingEvent({
      organizationId: "org_1",
      conversationId: "conv_1",
      contactId: "contact_1",
      userId: null,
      source: "contact",
    });
    expect(publish.mock.calls[0][1]).toMatchObject({
      userId: null,
      userName: null,
      source: "contact",
    });
  });
});

describe("publishScheduledMessageUpdated", () => {
  beforeEach(() => publish.mockReset());

  it("publica { conversationId, scheduledMessageId, status } na org", () => {
    publishScheduledMessageUpdated({
      organizationId: "org_1",
      conversationId: "conv_1",
      scheduledMessageId: "sm_1",
      status: "PENDING",
    });
    expect(publish).toHaveBeenCalledWith("scheduled_message_updated", {
      organizationId: "org_1",
      conversationId: "conv_1",
      scheduledMessageId: "sm_1",
      status: "PENDING",
    });
  });

  it("sem organizationId não publica (fail-closed, mesmo critério do bus)", () => {
    publishScheduledMessageUpdated({
      organizationId: null,
      conversationId: "conv_1",
      status: "CANCELLED",
    });
    expect(publish).not.toHaveBeenCalled();
  });
});
