import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  SESSION_WINDOW_MS,
  sessionFromLastInbound,
} from "@/lib/channel-session";

describe("sessionFromLastInbound", () => {
  const now = new Date("2026-08-28T14:45:00.000Z").getTime();

  it("abre a janela com inbound agora, mesmo depois de um template outbound", () => {
    const lastInboundAt = new Date("2026-08-28T14:44:00.000Z");
    const session = sessionFromLastInbound(lastInboundAt, now);
    expect(session.active).toBe(true);
    expect(session.expiresAt?.toISOString()).toBe("2026-08-29T14:44:00.000Z");
  });

  it("fica fechada em ticket só-template (sem inbound)", () => {
    expect(sessionFromLastInbound(null, now).active).toBe(false);
    expect(sessionFromLastInbound(null, now).lastInboundAt).toBeNull();
  });

  it("fica fechada quando o último inbound tem 24h ou mais", () => {
    const expired = new Date(now - SESSION_WINDOW_MS);
    expect(sessionFromLastInbound(expired, now).active).toBe(false);
    const justInside = new Date(now - SESSION_WINDOW_MS + 1);
    expect(sessionFromLastInbound(justInside, now).active).toBe(true);
  });
});
