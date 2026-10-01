/**
 * RT-6: `getScopeGrants` cacheado por org (60 s) e invalidado ao gravar.
 * Sem Redis o cache cai no Map em memória — o contrato é o mesmo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { organizationSetting: db },
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org_ctx",
  getRequestContext: () => undefined,
}));

import {
  getScopeGrants,
  parseScopeGrants,
  scopeGrantsCacheKey,
  setScopeGrantsForOrg,
} from "@/lib/authz/scope-grants";
import { cache } from "@/lib/cache";

const GRANTS_V1 = parseScopeGrants({ pipeline: { users: { u1: ["p1"] } } });
const GRANTS_V2 = parseScopeGrants({ pipeline: { users: { u1: ["p2"] } } });

describe("getScopeGrants — cache por org", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cache.del(
      scopeGrantsCacheKey("org_a"),
      scopeGrantsCacheKey("org_b"),
      scopeGrantsCacheKey("org_ctx"),
    );
    db.findUnique.mockResolvedValue({ value: JSON.stringify(GRANTS_V1) });
    db.upsert.mockResolvedValue({});
  });

  it("lê o Postgres uma vez e serve as leituras seguintes do cache", async () => {
    const a = await getScopeGrants("org_a");
    const b = await getScopeGrants("org_a");
    const c = await getScopeGrants("org_a");
    expect(db.findUnique).toHaveBeenCalledTimes(1);
    expect(a).toEqual(GRANTS_V1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("leituras concorrentes compartilham um único loader", async () => {
    await Promise.all([
      getScopeGrants("org_a"),
      getScopeGrants("org_a"),
      getScopeGrants("org_a"),
    ]);
    expect(db.findUnique).toHaveBeenCalledTimes(1);
  });

  it("chave por org: orgs diferentes não compartilham grants", async () => {
    await getScopeGrants("org_a");
    db.findUnique.mockResolvedValueOnce({ value: JSON.stringify(GRANTS_V2) });
    const b = await getScopeGrants("org_b");
    expect(db.findUnique).toHaveBeenCalledTimes(2);
    expect(b).toEqual(GRANTS_V2);
    expect(await getScopeGrants("org_a")).toEqual(GRANTS_V1);
  });

  it("sem argumento usa a org do RequestContext", async () => {
    await getScopeGrants();
    expect(db.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_key: { organizationId: "org_ctx", key: "permissions.scope.grants.v1" } },
      }),
    );
  });

  it("setScopeGrantsForOrg invalida: a leitura seguinte volta ao Postgres", async () => {
    expect(await getScopeGrants("org_a")).toEqual(GRANTS_V1);
    expect(db.findUnique).toHaveBeenCalledTimes(1);

    db.findUnique.mockResolvedValue({ value: JSON.stringify(GRANTS_V2) });
    await setScopeGrantsForOrg("org_a", GRANTS_V2);
    expect(db.upsert).toHaveBeenCalledTimes(1);

    expect(await getScopeGrants("org_a")).toEqual(GRANTS_V2);
    expect(db.findUnique).toHaveBeenCalledTimes(2);
  });

  it("valor ausente ou JSON inválido vira {} (e também é cacheado)", async () => {
    db.findUnique.mockResolvedValue({ value: "{nope" });
    expect(await getScopeGrants("org_a")).toEqual({});
    expect(await getScopeGrants("org_a")).toEqual({});
    expect(db.findUnique).toHaveBeenCalledTimes(1);
  });
});
