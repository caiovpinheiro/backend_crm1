import { describe, expect, it } from "vitest";

import { agentPermissionWhere } from "@/lib/agent-permission-where";
import {
  TenantIsolationError,
  assertUniqueWhereOrg,
  assertWritableOrgId,
  deepInjectOrgId,
  extractOrgIdConstraint,
  mergeData,
  mergeWhere,
} from "@/lib/prisma-tenant-helpers";

const ORG_A = "org_a";
const ORG_B = "org_b";

describe("mergeWhere — AND externo, não substitui", () => {
  it("sem where: aplica só a org autenticada", () => {
    expect(mergeWhere(undefined, ORG_A)).toEqual({ organizationId: ORG_A });
    expect(mergeWhere(null, ORG_A)).toEqual({ organizationId: ORG_A });
  });

  it("where sem organizationId: preserva original e AND com a sessão", () => {
    const merged = mergeWhere({ id: "c1", status: "OPEN" }, ORG_A);
    expect(merged.id).toBe("c1");
    expect(merged.AND).toEqual([
      { id: "c1", status: "OPEN" },
      { organizationId: ORG_A },
    ]);
  });

  it("where com organizationId da sessão: preserva a condição original no AND", () => {
    const original = { id: "c1", organizationId: ORG_A };
    const merged = mergeWhere(original, ORG_A);
    expect(merged.AND).toEqual([original, { organizationId: ORG_A }]);
    expect(merged.id).toBe("c1");
    expect(merged.organizationId).toBeUndefined();
  });

  it("where com organizationId divergente: preserva B e AND com A (resultado vazio)", () => {
    const original = { id: "from-b", organizationId: ORG_B };
    const merged = mergeWhere(original, ORG_A);
    expect(merged.AND).toEqual([original, { organizationId: ORG_A }]);
    expect(merged.id).toBe("from-b");
    expect(merged.organizationId).toBeUndefined();
  });

  it("OR aninhado com org B não fura o AND da sessão", () => {
    const original = { OR: [{ organizationId: ORG_B }, { name: "x" }] };
    const merged = mergeWhere(original, ORG_A);
    expect(merged.AND).toEqual([original, { organizationId: ORG_A }]);
  });

  it("findUnique: eleva id no topo e não eleva organizationId", () => {
    const merged = mergeWhere({ id: "cuid1", organizationId: ORG_B }, ORG_A);
    expect(merged.id).toBe("cuid1");
    expect(merged.organizationId).toBeUndefined();
  });

  it("findUnique: eleva scalar unique (webhookToken) e AND com a sessão", () => {
    const original = { webhookToken: "tok-b" };
    const merged = mergeWhere(original, ORG_A);
    expect(merged.webhookToken).toBe("tok-b");
    expect(merged.AND).toEqual([original, { organizationId: ORG_A }]);
    expect(merged.organizationId).toBeUndefined();
  });

  it("filtro aninhado: original preservado no AND; sessão no AND externo", () => {
    const original = { contact: { organizationId: ORG_B, id: "c-b" } };
    const merged = mergeWhere(original, ORG_A);
    expect(merged.AND).toEqual([original, { organizationId: ORG_A }]);
    expect(merged.contact).toEqual(original.contact);
  });

  it("upsert/update: eleva seletor composto e NÃO o coloca no AND (WhereInput)", () => {
    const original = {
      organizationId_userId: { organizationId: ORG_B, userId: "u1" },
    };
    const merged = mergeWhere(original, ORG_A);
    expect(merged.organizationId_userId).toEqual(original.organizationId_userId);
    expect(merged.AND).toEqual([{ organizationId: ORG_A }]);
    const and0 = (merged.AND as unknown[])[0] as Record<string, unknown>;
    expect(and0.organizationId_userId).toBeUndefined();
  });

  it("updateMany/deleteMany/findMany: mesmo AND externo", () => {
    const merged = mergeWhere({ providerKey: "api4com" }, ORG_A);
    expect(merged.AND).toEqual([
      { providerKey: "api4com" },
      { organizationId: ORG_A },
    ]);
  });
});

describe("escritas — rejeição explícita de org divergente", () => {
  it("assertWritableOrgId aceita a org da sessão e rejeita B", () => {
    expect(() => assertWritableOrgId(ORG_A, ORG_A)).not.toThrow();
    expect(() => assertWritableOrgId(ORG_B, ORG_A)).toThrow(TenantIsolationError);
    expect(() =>
      assertWritableOrgId({ connect: { id: ORG_B } }, ORG_A),
    ).toThrow(TenantIsolationError);
  });

  it("create sem organizationId: injeta a sessão", () => {
    expect(deepInjectOrgId({ name: "Cat" }, ORG_A)).toEqual({
      name: "Cat",
      organizationId: ORG_A,
    });
  });

  it("create com organizationId de B: lança", () => {
    expect(() =>
      deepInjectOrgId({ name: "Cat", organizationId: ORG_B }, ORG_A),
    ).toThrow(TenantIsolationError);
  });

  it("update tentando transferir organizationId para B: lança", () => {
    expect(() =>
      deepInjectOrgId({ organizationId: ORG_B, active: false }, ORG_A),
    ).toThrow(TenantIsolationError);
  });

  it("mergeData com organizationId divergente lança (não reescreve)", () => {
    expect(() => mergeData({ organizationId: ORG_B }, ORG_A)).toThrow(
      TenantIsolationError,
    );
  });

  it("connectOrCreate.where recebe mergeWhere da sessão", () => {
    const injected = deepInjectOrgId(
      {
        product: {
          connectOrCreate: {
            where: { id: "prod-b" },
            create: { name: "P" },
          },
        },
      },
      ORG_A,
    ) as Record<string, unknown>;
    const rel = injected.product as {
      connectOrCreate: { where: Record<string, unknown>; create: unknown };
    };
    expect(rel.connectOrCreate.where.AND).toEqual([
      { id: "prod-b" },
      { organizationId: ORG_A },
    ]);
    expect(rel.connectOrCreate.create).toEqual({
      name: "P",
      organizationId: ORG_A,
    });
  });

  it("upsert com composto de outra org lança (não cria na sessão)", () => {
    expect(() =>
      assertUniqueWhereOrg(
        { organizationId_userId: { organizationId: ORG_B, userId: "u1" } },
        ORG_A,
      ),
    ).toThrow(TenantIsolationError);
    expect(() =>
      assertUniqueWhereOrg(
        { organizationId_userId: { organizationId: ORG_A, userId: "u1" } },
        ORG_A,
      ),
    ).not.toThrow();
  });

  it("extractOrgIdConstraint lê scalar e equals", () => {
    expect(extractOrgIdConstraint(ORG_A)).toBe(ORG_A);
    expect(extractOrgIdConstraint({ equals: ORG_B })).toBe(ORG_B);
  });
});

describe("agentPermissionWhere — não consulta só por userId", () => {
  it("exige organizationId do usuário validado", () => {
    expect(agentPermissionWhere("user-b", ORG_A)).toEqual({
      userId: "user-b",
      organizationId: ORG_A,
    });
  });

  it("sem org não vaza: usa sentinela em vez de omitir o filtro", () => {
    expect(agentPermissionWhere("user-b", null).organizationId).toBe("__none__");
    expect(agentPermissionWhere("user-b", undefined).organizationId).toBe(
      "__none__",
    );
  });
});
