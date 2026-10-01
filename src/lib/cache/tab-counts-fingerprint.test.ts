/**
 * Chave do cache dos contadores do inbox (`?counts=1`).
 *
 * O `visibilityWhere` de MEMBER com a aba Automação embute
 * `automationQueueDelayAgo()` — um `Date` novo a cada chamada. Hasheado cru,
 * a chave mudava a cada milissegundo e o COUNT caro rodava sempre.
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
import { automationQueueDelayAgo } from "@/lib/inbox-automation-queue";

/** Mesmo formato do trecho da aba Automação em `visibility.ts`. */
function memberAutomationScope() {
  return {
    k: 12,
    v: {
      OR: [
        { assignedToId: "u1" },
        {
          status: "OPEN",
          assignedToId: null,
          AND: [
            {
              contact: {
                automationContexts: {
                  some: {
                    status: { in: ["RUNNING", "PAUSED"] },
                    createdAt: { lte: automationQueueDelayAgo() },
                  },
                },
              },
            },
            {
              NOT: {
                contact: {
                  automationContexts: {
                    some: { createdAt: { gt: automationQueueDelayAgo() } },
                  },
                },
              },
            },
          ],
        },
      ],
    },
    m: ["entrada"],
    c: null,
    f: [],
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
  it("duas chamadas na mesma janela de 15 s geram a mesma chave", () => {
    const start = Date.UTC(2026, 9, 1, 12, 0, 0);
    vi.setSystemTime(start + 1);
    const a = inboxTabCountsFingerprint(memberAutomationScope());
    vi.setSystemTime(start + 7_000);
    const b = inboxTabCountsFingerprint(memberAutomationScope());
    vi.setSystemTime(start + INBOX_TAB_COUNTS_FP_DATE_BUCKET_MS - 1);
    const c = inboxTabCountsFingerprint(memberAutomationScope());

    expect(a).toHaveLength(INBOX_TAB_COUNTS_FP_LENGTH);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("muda de chave ao cruzar a janela", () => {
    const start = Date.UTC(2026, 9, 1, 12, 0, 0);
    vi.setSystemTime(start);
    const a = inboxTabCountsFingerprint(memberAutomationScope());
    vi.setSystemTime(start + INBOX_TAB_COUNTS_FP_DATE_BUCKET_MS);
    const b = inboxTabCountsFingerprint(memberAutomationScope());
    expect(b).not.toBe(a);
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
  });
});
