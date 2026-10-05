import { describe, expect, it } from "vitest";

import {
  lockOpenCommercialContactExclusive,
  lockOpenCommercialDealCreate,
  lockOpenCommercialDealUnify,
  lockOpenCommercialPipelineShared,
  openCommercialContactLockKey,
  openCommercialPipelineLockKey,
  unifyDuplicateOpenDealsInPipeline,
} from "@/services/deal-duplicates";

type Mode = "shared" | "exclusive";

class AdvisoryLocks {
  private shared = new Map<string, number>();
  private exclusive = new Set<string>();
  private queue: Array<{ key: string; mode: Mode; resume: () => void }> = [];

  private can(key: string, mode: Mode): boolean {
    if (this.exclusive.has(key)) return false;
    if (mode === "exclusive" && (this.shared.get(key) ?? 0) > 0) return false;
    return true;
  }

  private grant(key: string, mode: Mode) {
    if (mode === "exclusive") this.exclusive.add(key);
    else this.shared.set(key, (this.shared.get(key) ?? 0) + 1);
  }

  async acquire(key: string, mode: Mode): Promise<void> {
    if (this.can(key, mode)) {
      this.grant(key, mode);
      return;
    }
    await new Promise<void>((resume) => {
      this.queue.push({ key, mode, resume });
    });
  }

  release(key: string, mode: Mode) {
    if (mode === "exclusive") this.exclusive.delete(key);
    else this.shared.set(key, Math.max(0, (this.shared.get(key) ?? 1) - 1));
    const kept: typeof this.queue = [];
    for (const waiter of this.queue) {
      if (waiter.key === key && this.can(waiter.key, waiter.mode)) {
        this.grant(waiter.key, waiter.mode);
        waiter.resume();
      } else {
        kept.push(waiter);
      }
    }
    this.queue = kept;
  }
}

function sqlText(strings: TemplateStringsArray, values: unknown[] = []): string {
  let text = "";
  for (let i = 0; i < strings.length; i++) {
    text += strings[i] ?? "";
    const value = values[i];
    if (value && typeof value === "object" && "strings" in value) {
      const nested = value as { strings: string[] };
      text += nested.strings.join("");
    }
  }
  return text;
}

function makeLockTx(locks: AdvisoryLocks, held: Array<{ key: string; mode: Mode }>) {
  return {
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const text = sqlText(strings, values);
      const key = String(values[0]);
      if (text.includes("pg_advisory_xact_lock_shared")) {
        await locks.acquire(key, "shared");
        held.push({ key, mode: "shared" });
        return 0;
      }
      if (text.includes("pg_advisory_xact_lock")) {
        await locks.acquire(key, "exclusive");
        held.push({ key, mode: "exclusive" });
        return 0;
      }
      return 0;
    },
    async $queryRaw() {
      return [];
    },
  };
}

type Deal = {
  id: string;
  organizationId: string;
  pipelineId: string;
  contactId: string;
  stagePosition: number;
  updatedAt: number;
  createdAt: number;
};

type Ref = { id: string; dealId: string };

function canonical(deals: Deal[], org: string, pipeline: string, contact: string): Deal | undefined {
  return deals
    .filter(
      (d) => d.organizationId === org && d.pipelineId === pipeline && d.contactId === contact,
    )
    .sort(
      (a, b) =>
        b.stagePosition - a.stagePosition ||
        b.updatedAt - a.updatedAt ||
        a.createdAt - b.createdAt,
    )[0];
}

describe("lock hierárquico de negócio duplicado", () => {
  it("duas criações do mesmo contato geram um canônico; contatos diferentes seguem em paralelo", async () => {
    const locks = new AdvisoryLocks();
    const deals: Deal[] = [];
    let seq = 0;

    async function create(org: string, pipeline: string, contact: string) {
      const held: Array<{ key: string; mode: Mode }> = [];
      const tx = makeLockTx(locks, held);
      try {
        await lockOpenCommercialDealCreate(tx as never, org, pipeline, contact);
        const existing = canonical(deals, org, pipeline, contact);
        if (existing) return existing;
        await Promise.resolve();
        const row: Deal = {
          id: `d${++seq}`,
          organizationId: org,
          pipelineId: pipeline,
          contactId: contact,
          stagePosition: 1,
          updatedAt: seq,
          createdAt: seq,
        };
        deals.push(row);
        return row;
      } finally {
        for (const lock of [...held].reverse()) locks.release(lock.key, lock.mode);
      }
    }

    const [a, b, c, otherOrg] = await Promise.all([
      create("org-a", "pipe-1", "contact-1"),
      create("org-a", "pipe-1", "contact-1"),
      create("org-a", "pipe-1", "contact-2"),
      create("org-b", "pipe-1", "contact-1"),
    ]);

    expect(a.id).toBe(b.id);
    expect(c.id).not.toBe(a.id);
    expect(otherOrg.organizationId).toBe("org-b");
    expect(deals.filter((d) => d.organizationId === "org-a" && d.contactId === "contact-1")).toHaveLength(1);
    expect(deals).toHaveLength(3);
    expect(openCommercialPipelineLockKey("org-a", "pipe-1")).not.toBe(
      openCommercialPipelineLockKey("org-b", "pipe-1"),
    );
    expect(openCommercialContactLockKey("org-a", "pipe-1", "contact-1")).toContain("org-a");
  });

  it("duas unificações deixam um canônico e as referências no vencedor", async () => {
    const locks = new AdvisoryLocks();
    let deals: Deal[] = [
      { id: "old", organizationId: "org-a", pipelineId: "pipe-1", contactId: "c1", stagePosition: 1, updatedAt: 1, createdAt: 1 },
      { id: "front", organizationId: "org-a", pipelineId: "pipe-1", contactId: "c1", stagePosition: 3, updatedAt: 2, createdAt: 2 },
      { id: "other-org", organizationId: "org-b", pipelineId: "pipe-1", contactId: "c1", stagePosition: 1, updatedAt: 1, createdAt: 1 },
    ];
    let refs: Ref[] = [
      { id: "n1", dealId: "old" },
      { id: "n2", dealId: "front" },
      { id: "n3", dealId: "other-org" },
    ];

    async function unify(org: string, pipeline: string) {
      const held: Array<{ key: string; mode: Mode }> = [];
      const tx = makeLockTx(locks, held);
      const snapshotDeals = deals.map((d) => ({ ...d }));
      const snapshotRefs = refs.map((r) => ({ ...r }));
      try {
        await lockOpenCommercialDealUnify(tx as never, org, pipeline);
        const mine = deals.filter((d) => d.organizationId === org && d.pipelineId === pipeline);
        const byContact = new Map<string, Deal[]>();
        for (const deal of mine) {
          const list = byContact.get(deal.contactId) ?? [];
          list.push(deal);
          byContact.set(deal.contactId, list);
        }
        const pairs: Array<{ loserId: string; keeperId: string }> = [];
        for (const group of byContact.values()) {
          const ranked = [...group].sort(
            (a, b) =>
              b.stagePosition - a.stagePosition ||
              b.updatedAt - a.updatedAt ||
              a.createdAt - b.createdAt,
          );
          const keeper = ranked[0];
          if (!keeper) continue;
          for (const loser of ranked.slice(1)) pairs.push({ loserId: loser.id, keeperId: keeper.id });
        }
        const frozen = pairs.map((p) => ({ ...p }));
        for (const pair of frozen) {
          refs = refs.map((r) => (r.dealId === pair.loserId ? { ...r, dealId: pair.keeperId } : r));
          deals = deals.filter((d) => d.id !== pair.loserId);
        }
        return frozen;
      } catch (err) {
        deals = snapshotDeals;
        refs = snapshotRefs;
        throw err;
      } finally {
        for (const lock of [...held].reverse()) locks.release(lock.key, lock.mode);
      }
    }

    await Promise.all([unify("org-a", "pipe-1"), unify("org-a", "pipe-1")]);
    expect(deals.map((d) => d.id).sort()).toEqual(["front", "other-org"]);
    expect(refs.find((r) => r.id === "n1")?.dealId).toBe("front");
    expect(refs.find((r) => r.id === "n3")?.dealId).toBe("other-org");
  });

  it("rollback no meio da unificação não apaga o perdedor nem move referência", async () => {
    const calls: string[] = [];
    const tx = {
      async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        const text = sqlText(strings, values);
        calls.push(text);
        if (text.includes("DELETE FROM deals")) throw new Error("boom");
        return values.length;
      },
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        calls.push(sqlText(strings, values));
        expect(values).toContain("org-a");
        expect(values).not.toContain("org-b");
        return [{ loser_id: "old", keeper_id: "front" }];
      },
    };

    await expect(
      unifyDuplicateOpenDealsInPipeline(tx as never, "pipe-1", "org-a"),
    ).rejects.toThrow("boom");

    const exclusive = calls.findIndex((text) => text.includes("pg_advisory_xact_lock("));
    const shared = calls.findIndex((text) => text.includes("pg_advisory_xact_lock_shared"));
    const lockedRows = calls.findIndex((text) => text.includes("FOR UPDATE"));
    const ranked = calls.findIndex((text) => text.includes("stage_position DESC"));
    const deleted = calls.findIndex((text) => text.includes("DELETE FROM deals"));
    expect(shared).toBe(-1);
    expect(exclusive).toBeGreaterThanOrEqual(0);
    expect(lockedRows).toBeGreaterThan(exclusive);
    expect(ranked).toBeGreaterThan(lockedRows);
    expect(deleted).toBe(calls.length - 1);
    expect(calls.some((text) => text.includes("unnest"))).toBe(true);
    expect(calls.some((text) => text.includes('UPDATE notes'))).toBe(true);
  });

  it("allowDuplicateDeals true → false: a criação em curso segura o shared e a seguinte relê false", async () => {
    const locks = new AdvisoryLocks();
    let allowDuplicate = true;
    const deals: Deal[] = [
      {
        id: "keeper",
        organizationId: "org-a",
        pipelineId: "pipe-1",
        contactId: "c1",
        stagePosition: 2,
        updatedAt: 2,
        createdAt: 1,
      },
    ];
    const order: string[] = [];
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    async function create(label: string, pauseAfterShared: boolean) {
      const held: Array<{ key: string; mode: Mode }> = [];
      const tx = makeLockTx(locks, held);
      try {
        await lockOpenCommercialPipelineShared(tx as never, "org-a", "pipe-1");
        order.push(`${label}:shared`);
        if (pauseAfterShared) await readGate;
        const forbids = !allowDuplicate;
        order.push(`${label}:read:${forbids ? "forbid" : "allow"}`);
        if (forbids) {
          await lockOpenCommercialContactExclusive(tx as never, "org-a", "pipe-1", "c1");
          order.push(`${label}:contact`);
          const existing = canonical(deals, "org-a", "pipe-1", "c1");
          if (existing) return existing;
        }
        const row: Deal = {
          id: `${label}-new`,
          organizationId: "org-a",
          pipelineId: "pipe-1",
          contactId: "c1",
          stagePosition: 1,
          updatedAt: deals.length,
          createdAt: deals.length,
        };
        deals.push(row);
        order.push(`${label}:inserted`);
        return row;
      } finally {
        for (const lock of [...held].reverse()) locks.release(lock.key, lock.mode);
      }
    }

    async function unify() {
      const held: Array<{ key: string; mode: Mode }> = [];
      const tx = makeLockTx(locks, held);
      try {
        order.push("unify:waiting");
        await lockOpenCommercialDealUnify(tx as never, "org-a", "pipe-1");
        order.push("unify:exclusive");
        allowDuplicate = false;
        const mine = deals.filter((d) => d.organizationId === "org-a" && d.contactId === "c1");
        const ranked = [...mine].sort(
          (a, b) =>
            b.stagePosition - a.stagePosition ||
            b.updatedAt - a.updatedAt ||
            a.createdAt - b.createdAt,
        );
        const keeper = ranked[0];
        for (const loser of ranked.slice(1)) {
          const idx = deals.findIndex((d) => d.id === loser.id);
          if (idx >= 0) deals.splice(idx, 1);
        }
        order.push("unify:done");
        return keeper;
      } finally {
        for (const lock of [...held].reverse()) locks.release(lock.key, lock.mode);
      }
    }

    const first = create("first", true);
    for (let i = 0; i < 20 && !order.includes("first:shared"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(order).toContain("first:shared");

    const unifyTask = unify();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toContain("unify:waiting");
    expect(order).not.toContain("unify:exclusive");

    releaseRead();
    const created = await first;
    await unifyTask;

    expect(created.id).toBe("first-new");
    expect(order.indexOf("first:shared")).toBeLessThan(order.indexOf("unify:exclusive"));
    expect(order).toContain("first:read:allow");
    expect(order).not.toContain("first:contact");
    expect(deals.map((d) => d.id)).toEqual(["keeper"]);

    const late = await create("late", false);
    expect(order).toContain("late:read:forbid");
    expect(order.indexOf("unify:done")).toBeLessThan(order.indexOf("late:shared"));
    expect(order.indexOf("late:shared")).toBeLessThan(order.indexOf("late:contact"));
    expect(late.id).toBe("keeper");
    expect(deals).toHaveLength(1);
  });
});
