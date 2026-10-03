/**
 * Chave do cache dos contadores do inbox (`?counts=1`).
 *
 * O `visibilityWhere` de MEMBER com a aba Automação embute
 * `automationQueueDelayAgo()` — um `Date` novo a cada chamada. Hasheado cru,
 * a chave mudava a cada milissegundo; arredondado para 15 s, girava a cada
 * 15 s (C2 / 1.3 da auditoria). Agora o corte relativo ao agora entra pelo
 * rótulo e a chave é estável; o instante exato continua só na consulta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  delete process.env.REDIS_URL;
});

import {
  INBOX_TAB_COUNTS_FP_DATE_BUCKET_MS,
  INBOX_TAB_COUNTS_FP_LENGTH,
  inboxTabCountsFingerprint,
} from "@/lib/cache/keys";
import { nowRelativeLabel } from "@/lib/cache/now-relative";
import {
  AUTOMATION_QUEUE_DELAY_MS,
  automationQueueDelayAgo,
} from "@/lib/inbox-automation-queue";
import { metaSessionWindowWhere } from "@/lib/meta-session-window";
import { withInboxQueueVisibility } from "@/lib/visibility";

/** Escopo como `getTabCounts` monta para MEMBER com a fila Automação. */
function memberAutomationScope(extraFilters: unknown[] = []) {
  return {
    k: 12,
    v: withInboxQueueVisibility(
      { assignedToId: "u1" },
      {
        permissions: [
          "inbox:tab:entrada",
          "conversation:claim",
          "inbox:tab:automacao",
          "inbox:tab:agente_ia",
        ],
      },
    ),
    m: ["entrada"],
    c: null,
    f: extraFilters,
    s: null,
    g: true,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("inboxTabCountsFingerprint", () => {
  it("fila Automação: duas chamadas com 20 s de intervalo geram a mesma chave", () => {
    const start = Date.UTC(2026, 9, 1, 12, 0, 7);
    vi.setSystemTime(start);
    const a = inboxTabCountsFingerprint(memberAutomationScope());
    vi.setSystemTime(start + 20_000);
    const b = inboxTabCountsFingerprint(memberAutomationScope());
    vi.setSystemTime(start + 3_600_000);
    const c = inboxTabCountsFingerprint(memberAutomationScope());

    expect(a).toHaveLength(INBOX_TAB_COUNTS_FP_LENGTH);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("filtro de janela 24 h da Meta também não gira a chave", () => {
    const start = Date.UTC(2026, 9, 1, 12, 0, 0);
    vi.setSystemTime(start);
    const a = inboxTabCountsFingerprint(
      memberAutomationScope([metaSessionWindowWhere("open")]),
    );
    vi.setSystemTime(start + 20_000);
    const b = inboxTabCountsFingerprint(
      memberAutomationScope([metaSessionWindowWhere("open")]),
    );
    expect(b).toBe(a);
    // Estado diferente da janela = escopo diferente.
    expect(
      inboxTabCountsFingerprint(memberAutomationScope([metaSessionWindowWhere("closed")])),
    ).not.toBe(a);
  });

  it("a consulta continua com o instante exato (só a chave usa o rótulo)", () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0);
    vi.setSystemTime(now);
    const cut = automationQueueDelayAgo();
    expect(cut).toBeInstanceOf(Date);
    expect(cut.getTime()).toBe(now - AUTOMATION_QUEUE_DELAY_MS);
    expect(nowRelativeLabel(cut)).toBe("automation_queue_delay");
    // A marca não vaza para a serialização (Prisma / JSON).
    expect(JSON.stringify({ d: cut })).toBe(JSON.stringify({ d: new Date(cut.getTime()) }));
    expect(Object.keys(cut)).toEqual([]);
  });

  it("Date absoluto (sem marca) segue arredondado na janela", () => {
    const start = Date.UTC(2026, 9, 1, 12, 0, 0);
    const scope = (t: number) => ({ f: [{ createdAt: { gte: new Date(t) } }] });
    const a = inboxTabCountsFingerprint(scope(start + 1));
    expect(inboxTabCountsFingerprint(scope(start + 7_000))).toBe(a);
    expect(
      inboxTabCountsFingerprint(scope(start + INBOX_TAB_COUNTS_FP_DATE_BUCKET_MS)),
    ).not.toBe(a);
  });

  it("escopos diferentes continuam com chaves diferentes", () => {
    vi.setSystemTime(Date.UTC(2026, 9, 1, 12, 0, 0));
    const base = memberAutomationScope();
    const other = { ...base, s: "maria" };
    expect(inboxTabCountsFingerprint(other)).not.toBe(
      inboxTabCountsFingerprint(base),
    );
    expect(inboxTabCountsFingerprint({ x: new Date(0) })).not.toBe(
      inboxTabCountsFingerprint({ x: new Date(0).toISOString() }),
    );
    expect(inboxTabCountsFingerprint({ x: automationQueueDelayAgo() })).not.toBe(
      inboxTabCountsFingerprint({ x: new Date() }),
    );
  });
});
