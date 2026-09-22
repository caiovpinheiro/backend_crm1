process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
process.env.SSE_ENABLE_REDIS_PUBSUB = "0";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  serializeSseRedisBody,
  SSE_ACCESS_REVOKED,
} from "@/lib/sse-audience";

const ORG = "org_a";
const MEMBER = "user_member";
const OUTSIDER = "user_outsider";
const SUPER_ID = "user_super";

type Recv = { event: string; data: unknown };

async function flush() {
  await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

describe("sseBus — audiência, revogação e Redis", () => {
  let sseBus: typeof import("@/lib/sse-bus").sseBus;
  const unsubs: Array<() => void> = [];

  beforeAll(async () => {
    ({ sseBus } = await import("@/lib/sse-bus"));
  });

  afterEach(() => {
    while (unsubs.length) unsubs.pop()?.();
  });

  function listen(ctx: {
    organizationId: string | null;
    userId: string | null;
    isSuperAdmin: boolean;
  }) {
    const received: Recv[] = [];
    const unsub = sseBus.subscribe(ctx, (event, envelope) => {
      received.push({ event, data: envelope.data });
    });
    unsubs.push(unsub);
    return received;
  }

  it("1. super-admin não recebe team_chat_* só por isSuperAdmin", async () => {
    const superRecv = listen({
      organizationId: ORG,
      userId: SUPER_ID,
      isSuperAdmin: true,
    });
    const memberRecv = listen({
      organizationId: ORG,
      userId: MEMBER,
      isSuperAdmin: false,
    });

    sseBus.publish(
      "team_chat_message",
      { organizationId: ORG, content: "privado", memberIds: [MEMBER] },
      { audienceUserIds: [MEMBER] },
    );
    await flush();

    expect(memberRecv.some((e) => e.event === "team_chat_message")).toBe(true);
    expect(superRecv.some((e) => e.event === "team_chat_message")).toBe(false);
  });

  it("1b. super-admin ainda recebe new_message da org (privilégio de atendimento)", async () => {
    const superRecv = listen({
      organizationId: null,
      userId: SUPER_ID,
      isSuperAdmin: true,
    });
    sseBus.publish("new_message", { organizationId: ORG, preview: "oi" });
    await flush();
    expect(superRecv.some((e) => e.event === "new_message")).toBe(true);
  });

  it("2. memberIds do payload não autorizam; envelope.audienceUserIds sim", async () => {
    const spoofed = listen({
      organizationId: ORG,
      userId: OUTSIDER,
      isSuperAdmin: false,
    });
    const memberRecv = listen({
      organizationId: ORG,
      userId: MEMBER,
      isSuperAdmin: false,
    });

    sseBus.publish(
      "team_chat_message",
      {
        organizationId: ORG,
        content: "segredo",
        memberIds: [OUTSIDER, MEMBER],
      },
      { audienceUserIds: [MEMBER] },
    );
    await flush();

    expect(spoofed).toEqual([]);
    expect(memberRecv).toHaveLength(1);
  });

  it("2b. team_chat_* sem audienceUserIds é dropado (fail-closed)", async () => {
    const memberRecv = listen({
      organizationId: ORG,
      userId: MEMBER,
      isSuperAdmin: false,
    });
    sseBus.publish("team_chat_message", {
      organizationId: ORG,
      content: "sem audiência",
      memberIds: [MEMBER],
    });
    await flush();
    expect(memberRecv).toEqual([]);
  });

  it("2c. new_message sem audiência explícita continua por organização", async () => {
    const a = listen({
      organizationId: ORG,
      userId: MEMBER,
      isSuperAdmin: false,
    });
    const b = listen({
      organizationId: ORG,
      userId: OUTSIDER,
      isSuperAdmin: false,
    });
    const otherOrg = listen({
      organizationId: "org_b",
      userId: "user_b",
      isSuperAdmin: false,
    });

    sseBus.publish("new_message", { organizationId: ORG, preview: "inbox" });
    await flush();

    expect(a.some((e) => e.event === "new_message")).toBe(true);
    expect(b.some((e) => e.event === "new_message")).toBe(true);
    expect(otherOrg).toEqual([]);
  });

  it("3. revokeUser entrega o evento, remove o listener local e não deixa conteúdo posterior", async () => {
    const order: string[] = [];
    const received: Recv[] = [];
    const unsub = sseBus.subscribe(
      { organizationId: ORG, userId: MEMBER, isSuperAdmin: false },
      (event, envelope) => {
        order.push(event);
        received.push({ event, data: envelope.data });
      },
    );
    unsubs.push(unsub);

    sseBus.revokeUser({ userId: MEMBER, organizationId: ORG });
    await flush();

    expect(order[0]).toBe(SSE_ACCESS_REVOKED);

    sseBus.publish(
      "team_chat_message",
      { organizationId: ORG, content: "depois da revogação" },
      { audienceUserIds: [MEMBER] },
    );
    sseBus.publish("new_message", { organizationId: ORG, preview: "inbox" });
    await flush();

    expect(received.every((e) => e.event === SSE_ACCESS_REVOKED)).toBe(true);
  });

  it("3b. réplica Redis: ingest de revoke fecha a conexão remota", async () => {
    const remote = listen({
      organizationId: ORG,
      userId: MEMBER,
      isSuperAdmin: false,
    });
    const other = listen({
      organizationId: ORG,
      userId: OUTSIDER,
      isSuperAdmin: false,
    });

    sseBus.ingestRedisMessage(
      serializeSseRedisBody({
        event: SSE_ACCESS_REVOKED,
        organizationId: ORG,
        data: { organizationId: ORG, userId: MEMBER },
        audienceUserIds: [MEMBER],
      }),
    );

    expect(remote.map((e) => e.event)).toEqual([SSE_ACCESS_REVOKED]);
    expect(other).toEqual([]);

    sseBus.ingestRedisMessage(
      serializeSseRedisBody({
        event: "new_message",
        organizationId: ORG,
        data: { organizationId: ORG, preview: "ainda ativo" },
      }),
    );
    expect(other.some((e) => e.event === "new_message")).toBe(true);
    expect(remote.filter((e) => e.event === "new_message")).toEqual([]);
  });

  it("4. participação: removido recebe o aviso, não o conteúdo seguinte", async () => {
    const remaining = listen({
      organizationId: ORG,
      userId: MEMBER,
      isSuperAdmin: false,
    });
    const left = listen({
      organizationId: ORG,
      userId: OUTSIDER,
      isSuperAdmin: false,
    });

    sseBus.publish(
      "team_chat_room_updated",
      {
        organizationId: ORG,
        roomId: "room_1",
        leftUserId: OUTSIDER,
        memberIds: [MEMBER],
      },
      { audienceUserIds: [MEMBER, OUTSIDER] },
    );
    await flush();

    expect(remaining.some((e) => e.event === "team_chat_room_updated")).toBe(
      true,
    );
    expect(left.some((e) => e.event === "team_chat_room_updated")).toBe(true);

    remaining.length = 0;
    left.length = 0;

    sseBus.publish(
      "team_chat_message",
      {
        organizationId: ORG,
        roomId: "room_1",
        content: "depois de sair",
        memberIds: [MEMBER],
      },
      { audienceUserIds: [MEMBER] },
    );
    await flush();

    expect(remaining.some((e) => e.event === "team_chat_message")).toBe(true);
    expect(left).toEqual([]);
  });

  it("4b. adicionar/transferir: só a membership atual recebe via Redis", () => {
    const destMember = listen({
      organizationId: ORG,
      userId: MEMBER,
      isSuperAdmin: false,
    });
    const fromOtherRoom = listen({
      organizationId: ORG,
      userId: OUTSIDER,
      isSuperAdmin: false,
    });

    sseBus.ingestRedisMessage(
      serializeSseRedisBody({
        event: "team_chat_forward_updated",
        organizationId: ORG,
        data: {
          organizationId: ORG,
          roomId: "dest",
          memberIds: [MEMBER],
        },
        audienceUserIds: [MEMBER],
      }),
    );

    expect(destMember).toHaveLength(1);
    expect(fromOtherRoom).toEqual([]);
  });

  it("Redis: team_chat sem audienceUserIds no fio não entrega nem ao membro listado no payload", () => {
    const memberRecv = listen({
      organizationId: ORG,
      userId: MEMBER,
      isSuperAdmin: false,
    });
    sseBus.ingestRedisMessage(
      serializeSseRedisBody({
        event: "team_chat_message",
        organizationId: ORG,
        data: {
          organizationId: ORG,
          memberIds: [MEMBER],
          content: "legado",
        },
      }),
    );
    expect(memberRecv).toEqual([]);
  });

  it("Redis: new_message sem audiência chega a todos os listeners da org", () => {
    const a = listen({
      organizationId: ORG,
      userId: MEMBER,
      isSuperAdmin: false,
    });
    const b = listen({
      organizationId: ORG,
      userId: OUTSIDER,
      isSuperAdmin: false,
    });
    sseBus.ingestRedisMessage(
      serializeSseRedisBody({
        event: "new_message",
        organizationId: ORG,
        data: { organizationId: ORG, preview: "redis-inbox" },
      }),
    );
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
