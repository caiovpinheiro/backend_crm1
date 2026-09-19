import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prismaBase } from "@/lib/prisma-base";
import { cleanupActivityOutbox, pollAndProjectActivityOutbox } from "@/services/activity-outbox";

type TestOrg = Awaited<ReturnType<typeof seedOrg>>;

async function seedOrg() {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const organization = await prismaBase.organization.create({
    data: { name: `outbox-test-${suffix}`, slug: `outbox-test-${suffix}` },
  });
  const user = await prismaBase.user.create({
    data: {
      organizationId: organization.id,
      name: "Test User",
      email: `outbox-test-${suffix}@example.com`,
      hashedPassword: "x",
    },
  });
  const pipeline = await prismaBase.pipeline.create({
    data: {
      organizationId: organization.id,
      name: "Test Pipeline",
      slug: `pipe-${suffix}`,
      number: 1,
    },
  });
  const stage = await prismaBase.stage.create({
    data: {
      organizationId: organization.id,
      pipelineId: pipeline.id,
      name: "Test Stage",
      slug: `stage-${suffix}`,
      number: 1,
      position: 0,
    },
  });
  const deal = await prismaBase.deal.create({
    data: {
      organizationId: organization.id,
      stageId: stage.id,
      title: "Test Deal",
      number: 1,
      status: "OPEN",
    },
  });
  return { organization, user, pipeline, stage, deal };
}

function createdPayload(org: TestOrg) {
  return {
    type: "CREATED",
    entityType: "DEAL" as const,
    entityId: org.deal.id,
    dealId: org.deal.id,
    actorType: "HUMAN" as const,
    actorUserId: org.user.id,
    organizationId: org.organization.id,
    idempotencyKey: `outbox-test:created:${org.deal.id}`,
    meta: { stageId: org.stage.id },
  };
}

async function cleanupTestOrg(org: TestOrg) {
  await prismaBase.deal.deleteMany({ where: { organizationId: org.organization.id } });
  await prismaBase.stage.deleteMany({ where: { organizationId: org.organization.id } });
  await prismaBase.pipeline.deleteMany({ where: { organizationId: org.organization.id } });
  await prismaBase.user.deleteMany({ where: { organizationId: org.organization.id } });
  await prismaBase.organization.delete({ where: { id: org.organization.id } });
}

describe("activity-outbox", () => {
  let org: TestOrg;

  beforeEach(async () => {
    org = await seedOrg();
  });

  afterEach(async () => {
    await prismaBase.activityEvent.deleteMany({
      where: { organizationId: org.organization.id },
    });
    await prismaBase.activityOutbox.deleteMany({
      where: { organizationId: org.organization.id },
    });
    await cleanupTestOrg(org);
  });

  it("projeta um evento e nao duplica em reprocessamento apos crash", async () => {
    const payload = createdPayload(org);
    const outbox = await prismaBase.activityOutbox.create({
      data: {
        organizationId: org.organization.id,
        idempotencyKey: payload.idempotencyKey,
        payload,
      },
    });

    const first = await pollAndProjectActivityOutbox(10);
    expect(first.processed).toBe(1);
    expect(await prismaBase.activityEvent.count({
      where: { organizationId: org.organization.id },
    })).toBe(1);

    // Simula crash: linha ja existe em activity_events, mas a outbox ainda nao
    // foi marcada como processada.
    await prismaBase.$executeRaw`
      UPDATE "activity_outbox"
      SET "processedAt" = NULL
      WHERE id = ${outbox.id}
    `;

    const second = await pollAndProjectActivityOutbox(10);
    expect(second.processed).toBe(1);
    expect(await prismaBase.activityEvent.count({
      where: { organizationId: org.organization.id },
    })).toBe(1);

    const reprocessed = await prismaBase.activityOutbox.findUnique({
      where: { id: outbox.id },
    });
    expect(reprocessed?.processedAt).not.toBeNull();
    expect(reprocessed?.attempts).toBe(0);
  });

  it("dead letter apos 5 tentativas consecutivas", async () => {
    const payload = {
      type: "CREATED",
      entityType: "INVALID_ENTITY_TYPE" as unknown as "DEAL",
      entityId: "does-not-matter",
      actorType: "HUMAN" as const,
      actorUserId: org.user.id,
      organizationId: org.organization.id,
      idempotencyKey: `outbox-test:bad:${org.deal.id}`,
    };
    await prismaBase.activityOutbox.create({
      data: {
        organizationId: org.organization.id,
        idempotencyKey: payload.idempotencyKey,
        payload,
        maxAttempts: 5,
      },
    });

    let totalProcessed = 0;
    let totalDead = 0;
    for (let i = 0; i < 5; i++) {
      // Acelera o retry: torna o item elegivel imediatamente.
      await prismaBase.$executeRaw`
        UPDATE "activity_outbox"
        SET "scheduledFor" = CURRENT_TIMESTAMP
        WHERE "organizationId" = ${org.organization.id}
          AND "idempotencyKey" = ${payload.idempotencyKey}
      `;
      const result = await pollAndProjectActivityOutbox(10);
      totalProcessed += result.processed;
      totalDead += result.dead;
    }

    expect(totalProcessed).toBe(0);
    expect(totalDead).toBe(1);

    const dead = await prismaBase.activityOutbox.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: org.organization.id, idempotencyKey: payload.idempotencyKey } },
    });
    expect(dead?.deadLetterAt).not.toBeNull();
    expect(dead?.attempts).toBeGreaterThanOrEqual(5);
  });

  it("cleanup remove itens processados antigos, mas nunca pendentes", async () => {
    const payload = createdPayload(org);
    const oldProcessed = await prismaBase.activityOutbox.create({
      data: {
        organizationId: org.organization.id,
        idempotencyKey: `${payload.idempotencyKey}:old`,
        payload,
        processedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        attempts: 1,
      },
    });
    const pending = await prismaBase.activityOutbox.create({
      data: {
        organizationId: org.organization.id,
        idempotencyKey: `${payload.idempotencyKey}:pending`,
        payload,
      },
    });

    const removed = await cleanupActivityOutbox(7);
    expect(removed).toBe(1);

    const oldStillThere = await prismaBase.activityOutbox.findUnique({
      where: { id: oldProcessed.id },
    });
    expect(oldStillThere).toBeNull();

    const pendingStillThere = await prismaBase.activityOutbox.findUnique({
      where: { id: pending.id },
    });
    expect(pendingStillThere).not.toBeNull();
  });
});
