import { describe, expect, it } from "vitest";

import { ServerTiming } from "@/lib/server-timing";

function parse(header: string) {
  return Object.fromEntries(
    header.split(", ").map((p) => {
      const m = /^([A-Za-z-]+);dur=([\d.]+)(?:;desc="([^"]*)")?$/.exec(p)!;
      return [m[1], { dur: Number(m[2]), desc: m[3] }];
    }),
  );
}

describe("ServerTiming.describeCache", () => {
  it("um status: cache;desc=hit, com a espera somada", () => {
    const t = new ServerTiming();
    t.describeCache(new Map([["tabulations", "hit"]]), 4);
    t.describeCache(new Map([["tabulations", "hit"]]), 1);
    const p = parse(t.header());
    expect(p.cache.desc).toBe("hit");
    expect(p.cache.dur).toBeCloseTo(5, 1);
  });

  it("blocos iguais viram um status; diferentes listam bloco=status", () => {
    const same = new ServerTiming();
    same.describeCache(
      new Map([
        ["deptHour", "miss"],
        ["ranking", "miss"],
      ]),
    );
    expect(parse(same.header()).cache.desc).toBe("miss");

    const mixed = new ServerTiming();
    mixed.describeCache(
      new Map([
        ["deptHour", "hit"],
        ["ranking", "miss"],
      ]),
    );
    expect(parse(mixed.header()).cache.desc).toBe("deptHour=hit ranking=miss");
  });

  it("sem blocos calculados pelo cache, não cria a fase", () => {
    const t = new ServerTiming();
    t.describeCache(new Map());
    expect(parse(t.header()).cache).toBeUndefined();
  });

  it("total é sempre a última fase", () => {
    const t = new ServerTiming();
    t.add("auth", 1);
    t.describeCache(new Map([["x", "hit"]]));
    t.add("serialize", 1);
    expect(Object.keys(parse(t.header())).at(-1)).toBe("total");
  });
});
