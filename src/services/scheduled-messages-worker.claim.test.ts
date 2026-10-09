import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; status: string; updatedAt: Date };

const h = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  return {
    rows,
    updateMany: vi.fn(async (args: {
      where: { id?: string; status?: string; updatedAt?: { lt: Date } };
      data: { status?: string };
    }) => {
      const matches = [...rows.values()].filter((row) => {
        if (args.where.id && row.id !== args.where.id) return false;
        if (args.where.status && row.status !== args.where.status) return false;
        if (args.where.updatedAt?.lt && !(row.updatedAt < args.where.updatedAt.lt)) return false;
        return true;
      });
      if (args.where.id) {
        const row = matches[0];
        if (!row) return { count: 0 };
        if (args.data.status) {
          row.status = args.data.status;
          row.updatedAt = new Date();
        }
        return { count: 1 };
      }
      for (const row of matches) {
        if (args.data.status) {
          row.status = args.data.status;
          row.updatedAt = new Date();
        }
      }
      return { count: matches.length };
    }),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { scheduledMessage: { updateMany: h.updateMany } },
}));
vi.mock("@/lib/send-whatsapp", () => ({ sendWhatsAppText: vi.fn() }));
vi.mock("@/lib/meta-whatsapp/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta-whatsapp/client")>(
    "@/lib/meta-whatsapp/client",
  );
  return actual;
});

import { metaGraphFetchWorstCaseMs } from "@/lib/meta-whatsapp/client";
import { TEMPLATE_DEFINITION_LISTING_PAGE_CAP } from "@/lib/meta-whatsapp/enrich-template-flow";
import {
  claimScheduledMessage,
  reclaimStaleSendingScheduledMessages,
  scheduledDispatchExternalWorstCaseMs,
  scheduledMessageSendingLeaseMs,
} from "@/services/scheduled-messages-worker";

beforeEach(() => {
  h.rows.clear();
  h.updateMany.mockClear();
  delete process.env.SCHEDULED_MESSAGE_SENDING_LEASE_MS;
  delete process.env.META_GRAPH_MAX_ATTEMPTS;
});

describe("claim atômico", () => {
  it("dois workers no mesmo id: só um claim e só um envio", async () => {
    h.rows.set("sm_1", { id: "sm_1", status: "PENDING", updatedAt: new Date() });
    const sends: string[] = [];
    async function worker() {
      const claimed = await claimScheduledMessage("sm_1");
      if (!claimed) return;
      sends.push("meta");
    }
    await Promise.all([worker(), worker()]);
    expect(sends).toEqual(["meta"]);
    expect(h.rows.get("sm_1")?.status).toBe("SENDING");
  });

  it("SENDING antigo volta a PENDING; SENDING dentro do lease fica", async () => {
    const lease = scheduledMessageSendingLeaseMs();
    h.rows.set("old", {
      id: "old",
      status: "SENDING",
      updatedAt: new Date(Date.now() - lease - 1_000),
    });
    h.rows.set("fresh", {
      id: "fresh",
      status: "SENDING",
      updatedAt: new Date(),
    });
    const n = await reclaimStaleSendingScheduledMessages();
    expect(n).toBe(1);
    expect(h.rows.get("old")?.status).toBe("PENDING");
    expect(h.rows.get("fresh")?.status).toBe("SENDING");
  });
});

describe("lease do SENDING", () => {
  it("fica acima do pior caso de sendText/sendTemplate + listagem do template", () => {
    const worst = scheduledDispatchExternalWorstCaseMs();
    const oneCall = metaGraphFetchWorstCaseMs();
    expect(worst).toBe((1 + TEMPLATE_DEFINITION_LISTING_PAGE_CAP + 1) * oneCall);
    expect(oneCall).toBeGreaterThanOrEqual(3 * 20_000);
    const lease = scheduledMessageSendingLeaseMs();
    expect(lease).toBeGreaterThan(worst);
  });

  it("env abaixo do piso é ignorado; acima do piso vale", () => {
    const floor = scheduledMessageSendingLeaseMs();
    process.env.SCHEDULED_MESSAGE_SENDING_LEASE_MS = "1000";
    expect(scheduledMessageSendingLeaseMs()).toBe(floor);
    process.env.SCHEDULED_MESSAGE_SENDING_LEASE_MS = String(floor + 5_000);
    expect(scheduledMessageSendingLeaseMs()).toBe(floor + 5_000);
  });
});
