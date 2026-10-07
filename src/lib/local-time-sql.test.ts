import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { localTs } from "@/lib/local-time-sql";

describe("localTs", () => {
  it("marca a coluna como UTC antes de converter para São Paulo", () => {
    const q = Prisma.sql`SELECT EXTRACT(HOUR FROM ${localTs('conv."createdAt"')})::int AS h`;
    expect(q.sql).toBe(
      `SELECT EXTRACT(HOUR FROM ((conv."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'))::int AS h`,
    );
    expect(q.values).toEqual([]);
  });
});
