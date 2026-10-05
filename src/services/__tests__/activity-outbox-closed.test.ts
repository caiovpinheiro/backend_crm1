/**
 * Consumidor de `CONVERSATION_CLOSED` da activity_outbox.
 *
 * Banco falso em memória (sem Postgres/Redis): a outbox e `activity_events`
 * são arrays, e o `$queryRaw` do fake aplica os mesmos predicados do SQL
 * (pendente + tipo, ou lock por id).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type OutboxRow = {
  id: string;
  organizationId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  scheduledFor: Date;
  processedAt: Date | null;
  deadLetterAt: Date | null;
  attempts: number;
  maxAttempts: number;
  lastError?: string | null;
};
type EventRow = Record<string, unknown> & {
  organizationId: string;
  idempotencyKey?: string;
};

const h = vi.hoisted(() => {
  const state = {
    outbox: [] as OutboxRow[],
    events: [] as EventRow[],
    dealEvents: [] as { organizationId: string; conversationId: string; userId: string }[],
    sql: [] as { text: string; inTx: boolean }[],
    /** Ids travados por "outra réplica" (SKIP LOCKED devolve vazio). */
    lockedElsewhere: new Set<string>(),
    failCreateOnce: false,
    /** `where` de cada checagem de idempotência em activity_events. */
    idemWheres: [] as Record<string, unknown>[],
  };

  const pending = (r: OutboxRow) => !r.processedAt && !r.deadLetterAt;

  function makeClient(inTx: boolean) {
    const client = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        state.sql.push({ text, inTx });
        const typeMatch = text.match(/payload->>'type' = '([A-Z_]+)'/);
        if (typeMatch) {
          const limit = values[0] as number;
          return state.outbox
            .filter((r) => pending(r) && r.scheduledFor.getTime() <= Date.now())
            .filter((r) => r.payload.type === typeMatch[1])
            .slice(0, limit)
            .map((r) => ({ id: r.id }));
        }
        if (text.includes("WHERE id = ?") && text.includes("FOR UPDATE SKIP LOCKED")) {
          const id = values[0] as string;
          if (state.lockedElsewhere.has(id)) return [];
          return state.outbox.filter((r) => r.id === id && pending(r));
        }
        throw new Error("SQL inesperado no fake: " + text);
      },
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(makeClient(true)),
      activityEvent: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          if (!("idempotencyKey" in where)) return null;
          state.idemWheres.push(where);
          // Respeita a janela de `occurredAt` como o banco: se ela deixar o
          // evento de fora, a idempotência quebra e o teste acusa.
          const win = where.occurredAt as { gte?: Date; lte?: Date } | undefined;
          const found = state.events.find((e) => {
            const at = e.occurredAt as Date | undefined;
            const inWindow =
              !win ||
              !at ||
              ((!win.gte || at >= win.gte) && (!win.lte || at <= win.lte));
            return (
              e.organizationId === where.organizationId &&
              e.idempotencyKey === where.idempotencyKey &&
              inWindow
            );
          });
          return found ? { id: "evt" } : null;
        },
        create: async ({ data }: { data: EventRow }) => {
          if (state.failCreateOnce) {
            state.failCreateOnce = false;
            throw new Error("deadlock detected");
          }
          state.events.push(data);
          return data;
        },
      },
      dealEvent: {
        findFirst: async ({ where }: { where: { organizationId: string; meta: { equals: string } } }) => {
          const found = state.dealEvents.find(
            (d) =>
              d.organizationId === where.organizationId &&
              d.conversationId === where.meta.equals,
          );
          return found ? { userId: found.userId } : null;
        },
      },
      activityOutbox: {
        update: async ({ where, data }: { where: { id: string }; data: Partial<OutboxRow> }) => {
          const row = state.outbox.find((r) => r.id === where.id);
          if (!row) throw new Error("outbox row não existe");
          Object.assign(row, data);
          return row;
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
          state.outbox.find((r) => r.id === where.id) ?? null,
      },
    };
    return client;
  }

  return { state, prismaBase: makeClient(false), inc: vi.fn() };
});

vi.mock("@/lib/prisma-base", () => ({ prismaBase: h.prismaBase }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/activity-log", () => ({
  runLogEvent: vi.fn(),
  userIdForFk: (raw: string | null | undefined) => {
    const v = (raw ?? "").trim();
    return !v || v === "system" || v === "webhook" || v === "cron" ? null : v;
  },
}));
vi.mock("@/lib/metrics", () => ({
  metrics: { activityOutbox: { processed: { inc: h.inc } } },
}));

import { runLogEvent } from "@/services/activity-log";
import {
  activityOutboxWorkerBatch,
  activityOutboxWorkerIntervalMs,
  isActivityOutboxWorkerEnabled,
  projectConversationClosedOutboxBatch,
  projectTabulationOutboxBatch,
  resetConversationClosedProjectorForTests,
  runConversationClosedProjectorTick,
  startConversationClosedOutboxProjector,
} from "@/services/activity-outbox";

const CLOSED_AT = new Date("2026-09-20T15:04:05.000Z");

function closedRow(over: Partial<OutboxRow> = {}, payload: Record<string, unknown> = {}): OutboxRow {
  return {
    id: "ob-closed-1",
    organizationId: "org-1",
    createdAt: CLOSED_AT,
    scheduledFor: CLOSED_AT,
    processedAt: null,
    deadLetterAt: null,
    attempts: 0,
    maxAttempts: 5,
    payload: {
      type: "CONVERSATION_CLOSED",
      actorType: "HUMAN",
      entityType: "CONVERSATION",
      entityId: "conv-1",
      entityLabel: "T-100",
      conversationId: "conv-1",
      contactId: "contact-1",
      field: "status",
      oldValue: "OPEN",
      newValue: "RESOLVED",
      organizationId: "org-1",
      actorUserId: "user-9",
      meta: { action: "resolve", tabulationId: "tab-1" },
      idempotencyKey: `conversation:conv-1:closed:${CLOSED_AT.toISOString()}`,
      ...payload,
    },
    ...over,
  };
}

function tabulatedRow(): OutboxRow {
  return {
    id: "ob-tab-1",
    organizationId: "org-1",
    createdAt: CLOSED_AT,
    scheduledFor: CLOSED_AT,
    processedAt: null,
    deadLetterAt: null,
    attempts: 0,
    maxAttempts: 5,
    payload: {
      type: "CONVERSATION_TABULATED",
      actorType: "HUMAN",
      entityType: "CONVERSATION",
      entityId: "conv-1",
      conversationId: "conv-1",
      organizationId: "org-1",
      actorUserId: "user-9",
      meta: { tabulationId: "tab-1", departmentId: "dep-1" },
      idempotencyKey: `conversation:conv-1:tabulated:tab-1:${CLOSED_AT.toISOString()}`,
    },
  };
}

beforeEach(() => {
  h.state.outbox = [];
  h.state.events = [];
  h.state.dealEvents = [];
  h.state.sql = [];
  h.state.lockedElsewhere = new Set();
  h.state.failCreateOnce = false;
  h.state.idemWheres = [];
  h.inc.mockClear();
  vi.mocked(runLogEvent).mockClear();
  resetConversationClosedProjectorForTests();
});

describe("projectConversationClosedOutboxBatch", () => {
  it("CLOSED vira um activity_event com a hora do encerramento e a linha fica processada", async () => {
    h.state.outbox = [closedRow()];

    expect(await projectConversationClosedOutboxBatch()).toBe(1);

    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0]).toMatchObject({
      organizationId: "org-1",
      type: "CONVERSATION_CLOSED",
      occurredAt: CLOSED_AT,
      entityType: "CONVERSATION",
      entityId: "conv-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      actorType: "HUMAN",
      actorUserId: "user-9",
      field: "status",
      oldValue: "OPEN",
      newValue: "RESOLVED",
      tabulationId: "tab-1",
      idempotencyKey: `conversation:conv-1:closed:${CLOSED_AT.toISOString()}`,
    });
    expect(h.state.outbox[0].processedAt).toBeInstanceOf(Date);
    expect(h.inc).toHaveBeenCalledWith({ organization: "org-1", status: "ok" }, 1);
    // Sem `runLogEvent`: nada de espelho no chat nem `occurredAt` = agora.
    expect(runLogEvent).not.toHaveBeenCalled();
  });

  it("rodar de novo não duplica (linha processada sai da consulta)", async () => {
    h.state.outbox = [closedRow()];
    await projectConversationClosedOutboxBatch();
    expect(await projectConversationClosedOutboxBatch()).toBe(0);
    expect(h.state.events).toHaveLength(1);
  });

  it("idempotência: evento já gravado (falha entre o INSERT e o processedAt) não é gravado de novo", async () => {
    h.state.outbox = [closedRow()];
    await projectConversationClosedOutboxBatch();
    // Simula a linha voltando a pendente depois de o evento já existir.
    h.state.outbox[0].processedAt = null;

    expect(await projectConversationClosedOutboxBatch()).toBe(0);
    expect(h.state.events).toHaveLength(1);
    expect(h.state.outbox[0].processedAt).toBeInstanceOf(Date);
  });

  it("a checagem de idempotência limita `occurredAt` (poda de partição de activity_events)", async () => {
    h.state.outbox = [closedRow()];
    await projectConversationClosedOutboxBatch();

    expect(h.state.idemWheres).toHaveLength(1);
    const win = h.state.idemWheres[0]!.occurredAt as { gte: Date; lte: Date };
    // De 1 dia antes da linha da outbox até 1 dia depois de agora: o evento
    // (occurredAt = createdAt da outbox) cai sempre dentro.
    expect(win.gte.getTime()).toBe(CLOSED_AT.getTime() - 86_400_000);
    expect(win.lte.getTime()).toBeGreaterThan(Date.now());
    expect(win.lte.getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000);
  });

  it("linha travada por outra réplica (SKIP LOCKED) é pulada sem gravar", async () => {
    h.state.outbox = [closedRow()];
    h.state.lockedElsewhere.add("ob-closed-1");

    expect(await projectConversationClosedOutboxBatch()).toBe(0);
    expect(h.state.events).toHaveLength(0);
    expect(h.state.outbox[0].processedAt).toBeNull();
    expect(h.state.outbox[0].attempts).toBe(0);
  });

  it("o lock é FOR UPDATE SKIP LOCKED dentro da transação; a seleção filtra o tipo", async () => {
    h.state.outbox = [closedRow()];
    await projectConversationClosedOutboxBatch(100);

    const [select, lock] = h.state.sql;
    expect(select.inTx).toBe(false);
    expect(select.text).toContain("payload->>'type' = 'CONVERSATION_CLOSED'");
    expect(select.text).toContain('"processedAt" IS NULL');
    expect(select.text).toContain('"deadLetterAt" IS NULL');
    expect(select.text).toContain('"scheduledFor" <= CURRENT_TIMESTAMP');
    expect(lock.inTx).toBe(true);
    expect(lock.text).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("fila antiga (payload sem actorUserId): o usuário sai do deal_events do encerramento", async () => {
    h.state.outbox = [closedRow({}, { actorUserId: undefined })];
    h.state.dealEvents = [
      { organizationId: "org-1", conversationId: "conv-1", userId: "user-42" },
    ];

    await projectConversationClosedOutboxBatch();
    expect(h.state.events[0].actorUserId).toBe("user-42");
  });

  it("falha na gravação: reagenda com backoff e não marca como processada", async () => {
    h.state.outbox = [closedRow()];
    h.state.failCreateOnce = true;
    const before = Date.now();

    expect(await projectConversationClosedOutboxBatch()).toBe(0);

    const row = h.state.outbox[0];
    expect(h.state.events).toHaveLength(0);
    expect(row.processedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("deadlock");
    expect(row.scheduledFor.getTime()).toBeGreaterThanOrEqual(before + 10_000);
  });

  it("respeita o tamanho do lote", async () => {
    h.state.outbox = Array.from({ length: 5 }, (_, i) =>
      closedRow(
        { id: `ob-${i}` },
        { entityId: `conv-${i}`, conversationId: `conv-${i}`, idempotencyKey: `k-${i}` },
      ),
    );
    expect(await projectConversationClosedOutboxBatch(2)).toBe(2);
    expect(h.state.outbox.filter((r) => r.processedAt).length).toBe(2);
  });
});

describe("CLOSED e TABULATED não se cruzam", () => {
  it("o consumidor de CLOSED não toca em TABULATED; o projetor de tabulação continua dono dele", async () => {
    h.state.outbox = [closedRow(), tabulatedRow()];

    expect(await projectConversationClosedOutboxBatch()).toBe(1);
    const tab = h.state.outbox.find((r) => r.id === "ob-tab-1")!;
    expect(tab.processedAt).toBeNull();
    expect(h.state.events.map((e) => e.type)).toEqual(["CONVERSATION_CLOSED"]);

    expect(await projectTabulationOutboxBatch()).toBe(1);
    expect(tab.processedAt).toBeInstanceOf(Date);
    expect(h.state.events.map((e) => e.type)).toEqual([
      "CONVERSATION_CLOSED",
      "CONVERSATION_TABULATED",
    ]);
  });

  it("o projetor de tabulação não toca em CLOSED", async () => {
    h.state.outbox = [closedRow()];

    expect(await projectTabulationOutboxBatch()).toBe(0);
    expect(h.state.outbox[0].processedAt).toBeNull();
    expect(h.state.outbox[0].deadLetterAt).toBeNull();
    expect(h.state.events).toHaveLength(0);
  });
});

describe("ACTIVITY_OUTBOX_WORKER", () => {
  it("ligado por padrão; 0/false/off/no desligam", () => {
    expect(isActivityOutboxWorkerEnabled({})).toBe(true);
    expect(isActivityOutboxWorkerEnabled({ ACTIVITY_OUTBOX_WORKER: "" })).toBe(true);
    expect(isActivityOutboxWorkerEnabled({ ACTIVITY_OUTBOX_WORKER: "1" })).toBe(true);
    for (const off of ["0", "false", "OFF", " no "]) {
      expect(isActivityOutboxWorkerEnabled({ ACTIVITY_OUTBOX_WORKER: off })).toBe(false);
    }
  });

  it("lote e intervalo: padrão 100 a cada 5 s, com piso e teto", () => {
    expect(activityOutboxWorkerBatch({})).toBe(100);
    expect(activityOutboxWorkerIntervalMs({})).toBe(5_000);
    expect(activityOutboxWorkerBatch({ ACTIVITY_OUTBOX_WORKER_BATCH: "9999" })).toBe(500);
    expect(activityOutboxWorkerBatch({ ACTIVITY_OUTBOX_WORKER_BATCH: "abc" })).toBe(100);
    expect(activityOutboxWorkerIntervalMs({ ACTIVITY_OUTBOX_WORKER_INTERVAL_MS: "10" })).toBe(1_000);
    expect(activityOutboxWorkerIntervalMs({ ACTIVITY_OUTBOX_WORKER_INTERVAL_MS: "30000" })).toBe(30_000);
  });

  it("env desligada: o tick não consulta nem consome", async () => {
    h.state.outbox = [closedRow()];

    expect(await runConversationClosedProjectorTick({ ACTIVITY_OUTBOX_WORKER: "0" })).toBe(0);
    expect(h.state.sql).toHaveLength(0);
    expect(h.state.events).toHaveLength(0);
    expect(h.state.outbox[0].processedAt).toBeNull();

    expect(await runConversationClosedProjectorTick({})).toBe(1);
    expect(h.state.events).toHaveLength(1);
  });

  it("env desligada: o timer não é criado", async () => {
    vi.useFakeTimers();
    try {
      h.state.outbox = [closedRow()];
      expect(startConversationClosedOutboxProjector({ ACTIVITY_OUTBOX_WORKER: "0" })).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.state.sql).toHaveLength(0);
      expect(h.state.outbox[0].processedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("env ligada: o timer consome no primeiro tick e não inicia duas vezes", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
      h.state.outbox = [closedRow()];
      expect(startConversationClosedOutboxProjector({})).toBe(true);
      expect(startConversationClosedOutboxProjector({})).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(h.state.events).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
