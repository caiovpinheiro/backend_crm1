import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  type Row = {
    messageId?: string;
    state: string;
    executions: number;
    removeOnComplete: unknown;
    jobId?: string;
  };
  const jobs = new Map<string, Row>();
  const hangers: Array<() => void> = [];
  return {
    jobs,
    hangers,
    hangNext: false,
    seq: 0,
    messageUpdate: vi.fn(async () => ({})),
  };
});

vi.mock("ioredis", () => ({
  default: class Redis {
    constructor() {}
  },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    async add(
      _name: string,
      data: { messageId?: string },
      opts?: { jobId?: string; removeOnComplete?: unknown },
    ) {
      const id = opts?.jobId ?? `auto-${++h.seq}`;
      const existing = h.jobs.get(id);
      if (existing) {
        return {
          id,
          data: { messageId: existing.messageId },
          getState: async () => existing.state,
        };
      }
      const row = {
        messageId: data.messageId,
        state: "waiting",
        executions: 0,
        removeOnComplete: opts?.removeOnComplete,
        jobId: opts?.jobId,
      };
      h.jobs.set(id, row);
      const created = {
        id,
        data,
        getState: async () => h.jobs.get(id)?.state ?? row.state,
      };
      if (opts?.jobId && h.hangNext) {
        h.hangNext = false;
        return new Promise((resolve) => {
          h.hangers.push(() => resolve(created));
        });
      }
      return created;
    }
    async getJob(id: string) {
      const row = h.jobs.get(id);
      if (!row) return undefined;
      return {
        id,
        data: { messageId: row.messageId },
        getState: async () => row.state,
      };
    }
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: { update: h.messageUpdate },
    contact: { findUnique: vi.fn(async () => null) },
    channel: { findUnique: vi.fn() },
  },
}));
vi.mock("@/services/activity-log", () => ({ logMessageFailed: vi.fn() }));

import {
  BaileysOutboundAlreadyQueuedError,
  BaileysOutboundJobFailedError,
  enqueueBaileysOutbound,
  scheduledMessageBaileysJobId,
} from "@/lib/queue";
import { sendWhatsAppText } from "@/lib/send-whatsapp";
import { scheduledMessageSendingLeaseMs } from "@/services/scheduled-messages-worker";

function finishConsumer(jobId: string) {
  const row = h.jobs.get(jobId);
  if (!row) throw new Error(`job ${jobId} ausente`);
  row.executions += 1;
  row.state = "completed";
  if (row.removeOnComplete === true) h.jobs.delete(jobId);
}

const payload = {
  channelId: "ch-1",
  to: "5511999999999@s.whatsapp.net",
  content: "oi",
  messageType: "text",
  conversationId: "conv-1",
};

beforeEach(() => {
  h.jobs.clear();
  h.hangers.length = 0;
  h.hangNext = false;
  h.seq = 0;
  h.messageUpdate.mockClear();
});

describe("jobId do agendamento Baileys", () => {
  it("o primeiro add fica preso e o segundo não cria outro job", async () => {
    const jobId = scheduledMessageBaileysJobId("sm_1");
    expect(jobId).toBe("scheduled-message-sm_1");
    expect(jobId.includes(":")).toBe(false);

    h.hangNext = true;
    const first = enqueueBaileysOutbound(
      { ...payload, messageId: "msg-a" },
      { jobId },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.jobs.size).toBe(1);

    await expect(
      enqueueBaileysOutbound({ ...payload, messageId: "msg-b" }, { jobId }),
    ).rejects.toBeInstanceOf(BaileysOutboundAlreadyQueuedError);
    expect(h.jobs.size).toBe(1);
    expect(h.jobs.get(jobId)?.messageId).toBe("msg-a");

    h.hangers[0]?.();
    await first;
    expect(h.jobs.size).toBe(1);
  });

  it("sem jobId, dois envios comuns continuam sendo dois jobs e somem ao completar", async () => {
    await enqueueBaileysOutbound({ ...payload, messageId: "m1" });
    await enqueueBaileysOutbound({ ...payload, messageId: "m2" });
    expect(h.jobs.size).toBe(2);
    for (const row of h.jobs.values()) {
      expect(row.jobId).toBeUndefined();
      expect(row.removeOnComplete).toBe(true);
    }
    const ids = [...h.jobs.keys()];
    for (const id of ids) finishConsumer(id);
    expect(h.jobs.size).toBe(0);
  });

  it("job de agendamento concluído permanece além do lease e o recovery não reenvia", async () => {
    const jobId = scheduledMessageBaileysJobId("sm_done");
    await enqueueBaileysOutbound({ ...payload, messageId: "msg-a" }, { jobId });
    const row = h.jobs.get(jobId);
    expect(row?.jobId).toBe(jobId);
    const keep = row?.removeOnComplete as { age: number; count: number };
    const leaseSec = Math.ceil(scheduledMessageSendingLeaseMs() / 1000);
    expect(keep.age).toBeGreaterThanOrEqual(2 * leaseSec);
    expect(keep.count).toBeGreaterThan(0);
    expect(keep.age).toBeGreaterThan(leaseSec);

    finishConsumer(jobId);
    expect(h.jobs.get(jobId)?.state).toBe("completed");
    expect(h.jobs.get(jobId)?.executions).toBe(1);

    await expect(
      enqueueBaileysOutbound({ ...payload, messageId: "msg-b" }, { jobId }),
    ).rejects.toBeInstanceOf(BaileysOutboundAlreadyQueuedError);
    expect(h.jobs.size).toBe(1);
    expect(h.jobs.get(jobId)?.executions).toBe(1);
    expect(h.jobs.get(jobId)?.messageId).toBe("msg-a");
  });

  it("job failed definitivo não é tratado como entrega pendente nem reenfileirado", async () => {
    const jobId = scheduledMessageBaileysJobId("sm_fail");
    await enqueueBaileysOutbound({ ...payload, messageId: "msg-a" }, { jobId });
    const row = h.jobs.get(jobId)!;
    row.executions = 1;
    row.state = "failed";

    await expect(
      enqueueBaileysOutbound({ ...payload, messageId: "msg-b" }, { jobId }),
    ).rejects.toBeInstanceOf(BaileysOutboundJobFailedError);
    expect(h.jobs.size).toBe(1);
    expect(h.jobs.get(jobId)?.executions).toBe(1);

    const send = await sendWhatsAppText({
      conversationId: "conv-1",
      contactId: "ct-1",
      channelRef: { id: "ch-1", provider: "BAILEYS_MD" },
      content: "oi",
      messageId: "msg-c",
      waJid: payload.to,
      baileysJobId: jobId,
    });
    expect(send.failed).toBe(true);
    expect(h.jobs.get(jobId)?.executions).toBe(1);
  });

  it("sendWhatsAppText do agendamento usa o jobId e não marca falha no segundo", async () => {
    const jobId = scheduledMessageBaileysJobId("sm_9");
    h.hangNext = true;
    const first = sendWhatsAppText({
      conversationId: "conv-1",
      contactId: "ct-1",
      channelRef: { id: "ch-1", provider: "BAILEYS_MD" },
      content: "oi",
      messageId: "msg-a",
      waJid: payload.to,
      baileysJobId: jobId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await sendWhatsAppText({
      conversationId: "conv-1",
      contactId: "ct-1",
      channelRef: { id: "ch-1", provider: "BAILEYS_MD" },
      content: "oi",
      messageId: "msg-b",
      waJid: payload.to,
      baileysJobId: jobId,
    });
    expect(second.failed).toBe(false);
    expect(h.jobs.size).toBe(1);
    expect(h.messageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "msg-b" },
        data: expect.objectContaining({ sendStatus: "failed" }),
      }),
    );
    h.hangers[0]?.();
    const done = await first;
    expect(done.failed).toBe(false);
    expect(h.jobs.size).toBe(1);
  });
});
