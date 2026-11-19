/**
 * Regras puras e de banco do "Trocar de organização" (`org-switch.ts`):
 * vínculo (par canônico + versões), filtro de elegibilidade (isolamento:
 * só o mesmo e-mail, humano, verificado, org ACTIVE) e o ticket.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userFindMany: vi.fn(),
  linkFindUnique: vi.fn(),
  linkUpdate: vi.fn(),
  logAuditAsync: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    user: {
      findUnique: mocks.userFindUnique,
      findFirst: mocks.userFindFirst,
      findMany: mocks.userFindMany,
    },
    userAccountLink: { findUnique: mocks.linkFindUnique, update: mocks.linkUpdate },
  },
}));
vi.mock("@/lib/cache/redis-client", () => ({ getCacheClient: () => null }));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: mocks.logAuditAsync }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  canonicalPair,
  clearOrgSwitchTicketsForTests,
  consumeOrgSwitch,
  findEligibleTarget,
  isLinkCurrent,
  issueOrgSwitchTicket,
  listEligibleTargets,
  loadSourceAccount,
  orgSwitchTicketFrom,
} from "./org-switch";

const SOURCE = { id: "uA", email: "p@x.test", organizationId: "orgA", sessionVersion: 2 };
const SOURCE_ROW = {
  id: "uA",
  email: "p@x.test",
  type: "HUMAN",
  isErased: false,
  isSuperAdmin: false,
  organizationId: "orgA",
  sessionVersion: 2,
  organization: { status: "ACTIVE" },
};
const TARGET_ROW = {
  id: "uB",
  name: "P",
  email: "p@x.test",
  role: "MEMBER",
  avatarUrl: null,
  hashedPassword: "h",
  mfaSecret: null,
  mfaEnabledAt: null,
  sessionVersion: 7,
  organizationId: "orgB",
  organization: { id: "orgB", slug: "beta", name: "Beta", logoUrl: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearOrgSwitchTicketsForTests();
  mocks.userFindUnique.mockResolvedValue(SOURCE_ROW);
  mocks.userFindFirst.mockResolvedValue(TARGET_ROW);
  mocks.linkFindUnique.mockResolvedValue({ userAId: "uA", userBId: "uB", userAVersion: 2, userBVersion: 7 });
  mocks.linkUpdate.mockResolvedValue({});
});

describe("vínculo", () => {
  it("par canônico independe da ordem e leva a versão de cada lado", () => {
    const a = { id: "uA", sessionVersion: 2 };
    const b = { id: "uB", sessionVersion: 7 };
    const want = { userAId: "uA", userBId: "uB", userAVersion: 2, userBVersion: 7 };
    expect(canonicalPair(a, b)).toEqual(want);
    expect(canonicalPair(b, a)).toEqual(want);
  });

  it("vale só com as MESMAS versões dos dois lados (revogação em qualquer lado invalida)", () => {
    const link = { userAId: "uA", userBId: "uB", userAVersion: 2, userBVersion: 7 };
    expect(isLinkCurrent(link, { id: "uA", sessionVersion: 2 }, { id: "uB", sessionVersion: 7 })).toBe(true);
    expect(isLinkCurrent(link, { id: "uB", sessionVersion: 7 }, { id: "uA", sessionVersion: 2 })).toBe(true);
    expect(isLinkCurrent(link, { id: "uA", sessionVersion: 3 }, { id: "uB", sessionVersion: 7 })).toBe(false);
    expect(isLinkCurrent(link, { id: "uA", sessionVersion: 2 }, { id: "uB", sessionVersion: 8 })).toBe(false);
    expect(isLinkCurrent(link, { id: "uA", sessionVersion: 2 }, { id: "uC", sessionVersion: 7 })).toBe(false);
    expect(isLinkCurrent(null, { id: "uA", sessionVersion: 2 }, { id: "uB", sessionVersion: 7 })).toBe(false);
  });
});

describe("contas elegíveis (isolamento multi-tenant)", () => {
  it("origem inelegível: apagada, IA, super-admin, sem org ou org não ACTIVE", async () => {
    for (const over of [
      { isErased: true },
      { type: "AI" },
      { isSuperAdmin: true },
      { organizationId: null },
      { organization: { status: "SUSPENDED" } },
    ]) {
      mocks.userFindUnique.mockResolvedValueOnce({ ...SOURCE_ROW, ...over });
      expect(await loadSourceAccount("uA")).toBeNull();
    }
    mocks.userFindUnique.mockResolvedValueOnce(SOURCE_ROW);
    expect(await loadSourceAccount("uA")).toEqual(SOURCE);
  });

  it("destino: mesmo e-mail da conta de origem, outro usuário, humano, verificado, com senha, org ACTIVE", async () => {
    mocks.userFindMany.mockResolvedValue([TARGET_ROW]);
    await listEligibleTargets(SOURCE);
    const where = mocks.userFindMany.mock.calls[0][0].where;
    expect(where).toEqual({
      email: "p@x.test",
      id: { not: "uA" },
      type: "HUMAN",
      isErased: false,
      isSuperAdmin: false,
      hashedPassword: { not: null },
      emailVerifiedAt: { not: null },
      organizationId: { not: null },
      organization: { status: "ACTIVE" },
    });
  });

  it("busca por org também filtra pelo e-mail; nunca devolve a própria conta", async () => {
    await findEligibleTarget(SOURCE, { organizationId: "orgB" });
    expect(mocks.userFindFirst.mock.calls[0][0].where).toMatchObject({
      email: "p@x.test",
      organizationId: "orgB",
      organization: { status: "ACTIVE" },
    });
    mocks.userFindFirst.mockResolvedValueOnce({ ...TARGET_ROW, id: "uA" });
    expect(await findEligibleTarget(SOURCE, { userId: "uA" })).toBeNull();
  });
});

describe("ticket", () => {
  it("lê o ticket só do campo `orgSwitch` do update()", () => {
    expect(orgSwitchTicketFrom({ orgSwitch: "abc" })).toBe("abc");
    for (const v of [null, undefined, "x", {}, { orgSwitch: 1 }, { orgSwitch: "" }, { sessionRenewal: "abc" }]) {
      expect(orgSwitchTicketFrom(v)).toBeNull();
    }
  });

  it("consumo devolve as claims do destino e audita nas duas orgs", async () => {
    const { token, expiresInSec } = await issueOrgSwitchTicket({ fromUserId: "uA", sid: "s1", toUserId: "uB" });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresInSec).toBe(60);
    const claims = await consumeOrgSwitch({ ticket: token, userId: "uA", sid: "s1" });
    expect(claims).toEqual({
      id: "uB",
      name: "P",
      email: "p@x.test",
      role: "MEMBER",
      organizationId: "orgB",
      organizationSlug: "beta",
      picture: null,
      sessionVersion: 7,
    });
    // O destino é procurado pelo id do ticket E pelo e-mail da origem.
    expect(mocks.userFindFirst.mock.calls[0][0].where).toMatchObject({ id: "uB", email: "p@x.test" });
    const orgs = mocks.logAuditAsync.mock.calls.map((c) => c[0].organizationId);
    expect(orgs).toEqual(["orgA", "orgB"]);
  });

  it("uso único, ligado ao usuário e à sessão", async () => {
    const t1 = await issueOrgSwitchTicket({ fromUserId: "uA", sid: "s1", toUserId: "uB" });
    expect(await consumeOrgSwitch({ ticket: t1.token, userId: "uA", sid: "s1" })).not.toBeNull();
    expect(await consumeOrgSwitch({ ticket: t1.token, userId: "uA", sid: "s1" })).toBeNull();

    const t2 = await issueOrgSwitchTicket({ fromUserId: "uA", sid: "s1", toUserId: "uB" });
    expect(await consumeOrgSwitch({ ticket: t2.token, userId: "uX", sid: "s1" })).toBeNull();
    // Tentativa recusada também queima o ticket.
    expect(await consumeOrgSwitch({ ticket: t2.token, userId: "uA", sid: "s1" })).toBeNull();

    const t3 = await issueOrgSwitchTicket({ fromUserId: "uA", sid: "s1", toUserId: "uB" });
    expect(await consumeOrgSwitch({ ticket: t3.token, userId: "uA", sid: "s2" })).toBeNull();

    expect(await consumeOrgSwitch({ ticket: "curto", userId: "uA", sid: "s1" })).toBeNull();
  });

  it("expira em 60 s", async () => {
    vi.useFakeTimers();
    try {
      const t = await issueOrgSwitchTicket({ fromUserId: "uA", sid: "s1", toUserId: "uB" });
      vi.advanceTimersByTime(61_000);
      expect(await consumeOrgSwitch({ ticket: t.token, userId: "uA", sid: "s1" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("vínculo invalidado entre a emissão e o consumo (revogação): não troca", async () => {
    const t = await issueOrgSwitchTicket({ fromUserId: "uA", sid: "s1", toUserId: "uB" });
    mocks.linkFindUnique.mockResolvedValue({ userAId: "uA", userBId: "uB", userAVersion: 2, userBVersion: 6 });
    expect(await consumeOrgSwitch({ ticket: t.token, userId: "uA", sid: "s1" })).toBeNull();
  });

  it("banco fora do ar no consumo: não troca e não lança", async () => {
    const t = await issueOrgSwitchTicket({ fromUserId: "uA", sid: "s1", toUserId: "uB" });
    mocks.userFindUnique.mockRejectedValue(new Error("db down"));
    expect(await consumeOrgSwitch({ ticket: t.token, userId: "uA", sid: "s1" })).toBeNull();
  });
});
