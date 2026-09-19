import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";
import { processBulkMoveStage } from "@/jobs/leads/bulk-move-stage.job";
import type { BulkMoveStagePayload } from "@/lib/queue";
import { resolveConversationsInline } from "@/services/conversations";
import {
  cleanupActivityOutbox,
  pollAndProjectActivityOutbox,
} from "@/services/activity-outbox";

vi.mock("@/services/automation-triggers", () => ({
  notifyDealStageChanged: vi.fn(async () => {}),
  fireTrigger: vi.fn(async () => {}),
}));

type TestOrg = Awaited<ReturnType<typeof seedOrg>>;

async function seedOrg() {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const organization = await prismaBase.organization.create({
    data: { name: `outbox-smoke-${suffix}`, slug: `outbox-smoke-${suffix}` },
  });
  const user = await prismaBase.user.create({
    data: {
      organizationId: organization.id,
      name: "Smoke User",
      email: `outbox-smoke-${suffix}@example.com`,
      hashedPassword: "x",
    },
  });
  const pipeline = await prismaBase.pipeline.create({
    data: {
      organizationId: organization.id,
      name: "Smoke Pipeline",
      slug: `pipe-${suffix}`,
      number: 1,
    },
  });
  const stageA = await prismaBase.stage.create({
    data: {
      organizationId: organization.id,
      pipelineId: pipeline.id,
      name: "Stage A",
      slug: `stage-a-${suffix}`,
      number: 1,
      position: 0,
    },
  });
  const stageB = await prismaBase.stage.create({
    data: {
      organizationId: organization.id,
      pipelineId: pipeline.id,
      name: "Stage B",
      slug: `stage-b-${suffix}`,
      number: 2,
      position: 1,
    },
  });
  return { organization, user, pipeline, stageA, stageB };
}

function uniqueNumber() {
  return Math.floor(Math.random() * 1_000_000_000);
}

async function seedContact(org: TestOrg) {
  return prismaBase.contact.create({
    data: {
      organizationId: org.organization.id,
      name: "Smoke Contact",
      number: uniqueNumber(),
    },
  });
}

async function seedConversation(org: TestOrg, contactId: string) {
  return prismaBase.conversation.create({
    data: {
      organizationId: org.organization.id,
      contactId,
      channel: "whatsapp",
      status: "OPEN",
      number: uniqueNumber(),
      externalId: `thread-${Math.random().toString(36).slice(2, 10)}`,
    },
  });
}

async function seedDeal(org: TestOrg, stageId: string) {
  const contact = await seedContact(org);
  return prismaBase.deal.create({
    data: {
      organizationId: org.organization.id,
      contactId: contact.id,
      stageId,
      title: "Smoke Deal",
      number: uniqueNumber(),
      status: "OPEN",
    },
  });
}

async function cleanupTestOrg(org: TestOrg) {
  await prismaBase.activityEvent.deleteMany({
    where: { organizationId: org.organization.id },
  });
  await prismaBase.activityOutbox.deleteMany({
    where: { organizationId: org.organization.id },
  });
  await prismaBase.dealCustomFieldValue.deleteMany({
    where: { organizationId: org.organization.id },
  });
  await prismaBase.dealEvent.deleteMany({
    where: { organizationId: org.organization.id },
  });
  await prismaBase.deal.deleteMany({ where: { organizationId: org.organization.id } });
  await prismaBase.conversation.deleteMany({
    where: { organizationId: org.organization.id },
  });
  await prismaBase.contact.deleteMany({ where: { organizationId: org.organization.id } });
  await prismaBase.stage.deleteMany({ where: { organizationId: org.organization.id } });
  await prismaBase.pipeline.deleteMany({ where: { organizationId: org.organization.id } });
  await prismaBase.bulkOperation.deleteMany({
    where: { organizationId: org.organization.id },
  });
  await prismaBase.user.deleteMany({ where: { organizationId: org.organization.id } });
  await prismaBase.organization.delete({ where: { id: org.organization.id } });
}

function withOrg<T>(org: TestOrg, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: org.organization.id, userId: org.user.id },
    fn,
  ) as Promise<T>;
}

describe("activity-outbox call sites", () => {
  let org: TestOrg;

  beforeEach(async () => {
    org = await seedOrg();
  });

  afterEach(async () => {
    await cleanupTestOrg(org);
  });

  it("resolveConversationsInline: gera CLOSED com chaves distintas no mesmo chunk", async () => {
    const contact = await seedContact(org);
    const conversations = await Promise.all([
      seedConversation(org, contact.id),
      seedConversation(org, contact.id),
      seedConversation(org, contact.id),
    ]);

    await withOrg(org, () =>
      resolveConversationsInline({
        ids: conversations.map((c) => c.id),
        keepAgent: true,
        keepDepartment: true,
        skipAutomations: true,
      }),
    );

    const outbox = await prismaBase.activityOutbox.findMany({
      where: {
        organizationId: org.organization.id,
        payload: { path: ["type"], equals: "CONVERSATION_CLOSED" },
      },
    });

    expect(outbox).toHaveLength(3);
    const keys = new Set(outbox.map((r) => r.idempotencyKey));
    expect(keys.size).toBe(3);

    const projected = await pollAndProjectActivityOutbox(100);
    expect(projected.processed).toBe(3);

    const events = await prismaBase.activityEvent.findMany({
      where: {
        organizationId: org.organization.id,
        type: "CONVERSATION_CLOSED",
      },
    });
    expect(events).toHaveLength(3);
  });

  it("processBulkMoveStage: gera STAGE_CHANGED com chaves distintas no mesmo chunk", async () => {
    const deals = await Promise.all([
      seedDeal(org, org.stageA.id),
      seedDeal(org, org.stageA.id),
    ]);

    const operation = await prismaBase.bulkOperation.create({
      data: {
        organizationId: org.organization.id,
        type: "DEAL_BULK_MOVE_STAGE",
        status: "PENDING",
        total: deals.length,
        payload: {},
      },
    });

    const payload: BulkMoveStagePayload = {
      operationId: operation.id,
      organizationId: org.organization.id,
      dealIds: deals.map((d) => d.id),
      targetStageId: org.stageB.id,
      initiatedByUserId: org.user.id,
    };

    const job = { id: "smoke-job", attemptsMade: 0 } as any;

    await withOrg(org, () => processBulkMoveStage(payload, job));

    const outbox = await prismaBase.activityOutbox.findMany({
      where: {
        organizationId: org.organization.id,
        payload: { path: ["type"], equals: "STAGE_CHANGED" },
      },
    });

    expect(outbox).toHaveLength(2);
    const keys = new Set(outbox.map((r) => r.idempotencyKey));
    expect(keys.size).toBe(2);

    const projected = await pollAndProjectActivityOutbox(100);
    expect(projected.processed).toBe(2);

    const events = await prismaBase.activityEvent.findMany({
      where: {
        organizationId: org.organization.id,
        type: "STAGE_CHANGED",
      },
    });
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.dealId).toBeTruthy();
      expect(e.toStageId).toBe(org.stageB.id);
    }
  });
});
