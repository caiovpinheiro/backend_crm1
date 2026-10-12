/**
 * `volume.messagesIn` / `volume.messagesOut` em `getPainelVolume`.
 *
 * Os dois eram a constante 0 desde que a contagem em `messages` saiu do volume
 * (24b6a26b0). Os cards "Mensagens recebidas/respondidas" da aba Negócios leem
 * esses campos (via `/api/painel/service?section=volume`), então mostravam 0
 * com conversas iniciadas e tabuladas no período (auditoria de produção, 12/10).
 *
 * Sem banco: o `$queryRaw` aplica sobre uma lista de mensagens os predicados
 * que o teste exige no SQL (org, período, pública, in/out, recorte de chat).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Msg = {
  organizationId: string;
  createdAt: Date;
  direction: string;
  isPrivate: boolean;
  messageType: string;
};

const h = vi.hoisted(() => ({
  msgs: [] as Msg[],
  sqls: [] as string[],
  values: [] as unknown[][],
  from: new Date(),
  to: new Date(),
}));

const NON_CHAT = new Set(["note", "ai_draft", "ai_summary", "whatsapp_call", "whatsapp_call_recording"]);

function answer(q: { sql: string; values: unknown[] }): unknown[] {
  h.sqls.push(q.sql);
  h.values.push(q.values);
  if (q.sql.includes('AS "messagesIn"')) {
    const hit = h.msgs.filter(
      (m) =>
        m.organizationId === "org_1" &&
        m.createdAt >= h.from &&
        m.createdAt <= h.to &&
        !m.isPrivate &&
        (m.direction === "in" || m.direction === "out") &&
        !NON_CHAT.has(m.messageType) &&
        !m.messageType.startsWith("event"),
    );
    return [
      {
        messagesIn: BigInt(hit.filter((m) => m.direction === "in").length),
        messagesOut: BigInt(hit.filter((m) => m.direction === "out").length),
      },
    ];
  }
  if (q.sql.includes('AS "stillOpen"')) {
    return [{ started: 14n, stillOpen: 10n, openStarted: 0n, openWaiting: 10n, resolved: 4n }];
  }
  if (q.sql.includes('AS "fromStarted"')) return [{ finished: 6n, fromStarted: 4n }];
  return [];
}

vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    $queryRaw: async (q: { sql: string; values: unknown[] }) => answer(q),
  }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/prisma-replica", () => ({
  isReplicaActive: () => false,
  isReplicaTripped: () => false,
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org_1" }));
vi.mock("@/services/painel-agora", () => ({ getPainelAgora: vi.fn() }));
vi.mock("@/services/painel-hours", () => ({ loadPainelHours: vi.fn() }));

import { getPainelVolume } from "@/services/painel-service";

/** Hoje (12/10) em São Paulo: 03:00 UTC até 02:59:59.999 UTC do dia 13. */
const FROM = new Date("2026-10-12T03:00:00.000Z");
const TO = new Date("2026-10-13T02:59:59.999Z");
const at = (iso: string) => new Date(iso);
const msg = (createdAt: string, direction: string, extra: Partial<Msg> = {}): Msg => ({
  organizationId: "org_1",
  createdAt: at(createdAt),
  direction,
  isPrivate: false,
  messageType: "text",
  ...extra,
});

beforeEach(() => {
  h.sqls.length = 0;
  h.values.length = 0;
  h.from = FROM;
  h.to = TO;
  h.msgs = [
    // 3 recebidas e 2 respondidas hoje (uma da IA).
    msg("2026-10-12T12:00:00Z", "in"),
    msg("2026-10-12T12:01:00Z", "in", { messageType: "image" }),
    msg("2026-10-12T12:02:00Z", "in"),
    msg("2026-10-12T12:03:00Z", "out"),
    msg("2026-10-12T12:04:00Z", "out", { messageType: "audio" }),
    // Fora do recorte de chat: nota, rascunho da IA, evento, ligação, privada.
    msg("2026-10-12T12:05:00Z", "out", { messageType: "note" }),
    msg("2026-10-12T12:06:00Z", "out", { messageType: "ai_draft" }),
    msg("2026-10-12T12:07:00Z", "out", { messageType: "event_transfer" }),
    msg("2026-10-12T12:08:00Z", "in", { messageType: "whatsapp_call" }),
    msg("2026-10-12T12:09:00Z", "out", { isPrivate: true }),
    // Fora do período (ontem 23:00 em SP) e de outra org.
    msg("2026-10-12T02:00:00Z", "in"),
    msg("2026-10-12T12:10:00Z", "in", { organizationId: "org_2" }),
  ];
});

describe("getPainelVolume — mensagens do período", () => {
  it("conta recebidas e respondidas do recorte (não fica em 0)", async () => {
    const v = await getPainelVolume({ from: FROM, to: TO }, "business");
    expect(v.started.value).toBe(14);
    expect(v.messagesIn).toBe(3);
    expect(v.messagesOut).toBe(2);
    expect(v.empty).toBe(false);
  });

  it("o SQL aplica org, período e o recorte de chat da lista do inbox", async () => {
    await getPainelVolume({ from: FROM, to: TO }, "business");
    const i = h.sqls.findIndex((s) => s.includes('AS "messagesIn"'));
    expect(i).toBeGreaterThanOrEqual(0);
    const sql = h.sqls[i]!.replace(/\s+/g, " ");
    expect(sql).toContain("FROM messages m");
    expect(sql).toContain('m."organizationId" = ?');
    expect(sql).toContain('m."createdAt" >= ? AND m."createdAt" <= ?');
    expect(sql).toContain('m."isPrivate" = false');
    expect(sql).toContain("m.direction IN ('in', 'out')");
    expect(sql).toContain(`m."messageType" NOT LIKE 'event%'`);
    expect(sql).toMatch(/m\."messageType" NOT IN \(\?(,\s?\?){4}\)/);
    expect(h.values[i]).toEqual(
      expect.arrayContaining(["org_1", FROM, TO, "note", "ai_draft", "ai_summary", "whatsapp_call", "whatsapp_call_recording"]),
    );
  });
});
