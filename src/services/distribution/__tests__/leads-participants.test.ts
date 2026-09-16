/**
 * Participantes do modo leads: upsert cria os 5 slots persistentes na 1ª
 * configuração; peso/status controlam só recebimentos futuros (slots e
 * lastAssignedAt preservados); valida usuário HUMAN da org.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org1",
}));

type Participant = {
  id: string;
  organizationId: string;
  userId: string;
  status: string;
  weight: number;
};
let participants: Participant[];
let slots: { participantId: string; slotIndex: number }[];
let users: { id: string; organizationId: string; type: string }[];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; organizationId: string; type: string } }) =>
        users.find(
          (u) =>
            u.id === where.id &&
            u.organizationId === where.organizationId &&
            u.type === where.type,
        ) ?? null,
      ),
      findMany: vi.fn(async () => []),
    },
    departmentMember: {
      findMany: vi.fn(async () => []),
    },
    distributionLeadsAssignment: {
      groupBy: vi.fn(async () => []),
    },
    distributionLeadsParticipant: {
      findMany: vi.fn(async () => []),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        distributionLeadsParticipant: {
          findUnique: vi.fn(
            async ({
              where,
            }: {
              where: { organizationId_userId: { organizationId: string; userId: string } };
            }) =>
              participants.find(
                (p) =>
                  p.organizationId ===
                    where.organizationId_userId.organizationId &&
                  p.userId === where.organizationId_userId.userId,
              ) ?? null,
          ),
          upsert: vi.fn(
            async ({
              where,
              create,
              update,
            }: {
              where: { organizationId_userId: { organizationId: string; userId: string } };
              create: Omit<Participant, "id">;
              update: Partial<Participant>;
            }) => {
              const existing = participants.find(
                (p) =>
                  p.organizationId ===
                    where.organizationId_userId.organizationId &&
                  p.userId === where.organizationId_userId.userId,
              );
              if (existing) {
                Object.assign(existing, update);
                return { id: existing.id };
              }
              const row: Participant = {
                id: `p_${create.userId}`,
                ...create,
              };
              participants.push(row);
              return { id: row.id };
            },
          ),
        },
        distributionLeadsSlot: {
          createMany: vi.fn(
            async ({
              data,
            }: {
              data: { organizationId: string; participantId: string; slotIndex: number }[];
            }) => {
              for (const d of data) {
                slots.push({ participantId: d.participantId, slotIndex: d.slotIndex });
              }
              return { count: data.length };
            },
          ),
        },
      }),
    ),
  },
}));

import { upsertLeadsParticipant } from "../leads/participants";

describe("upsertLeadsParticipant", () => {
  beforeEach(() => {
    participants = [];
    slots = [];
    users = [
      { id: "u1", organizationId: "org1", type: "HUMAN" },
      { id: "bot", organizationId: "org1", type: "AI" },
    ];
  });

  it("primeira configuração cria os 5 slots persistentes", async () => {
    await upsertLeadsParticipant({ userId: "u1", weight: 3 });
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({ userId: "u1", weight: 3, status: "ACTIVE" });
    expect(slots).toHaveLength(5);
    expect(slots.map((s) => s.slotIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("edição posterior NÃO recria slots (lastAssignedAt preservado)", async () => {
    await upsertLeadsParticipant({ userId: "u1", weight: 2 });
    slots.push(); // slots já criados
    const before = slots.length;
    await upsertLeadsParticipant({ userId: "u1", weight: 5, status: "INACTIVE" });
    expect(slots.length).toBe(before); // nenhum slot novo
    expect(participants[0]).toMatchObject({ weight: 5, status: "INACTIVE" });
  });

  it("rejeita usuário inexistente ou não-HUMAN (IA não participa)", async () => {
    expect(await upsertLeadsParticipant({ userId: "ghost", weight: 1 })).toBeNull();
    expect(await upsertLeadsParticipant({ userId: "bot", weight: 1 })).toBeNull();
    expect(participants).toHaveLength(0);
  });
});
