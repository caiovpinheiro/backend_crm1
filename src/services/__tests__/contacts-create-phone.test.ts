/**
 * `services/contacts` — criação e telefone sem Postgres (CL-15).
 *
 * Cobre:
 *  - `createContact`: normaliza telefone para E.164 (com e sem o 9º dígito),
 *    descarta telefone impossível em vez de gravar lixo, carimba
 *    `organizationId` do contexto, numera pelo contador da org, loga
 *    CONTACT_CREATED, retenta só colisão de `number`.
 *  - `findContactIdByPhone`: dedupe tolerante ao 9º dígito, sempre
 *    restrito à org informada.
 *  - `isContactNumberUniqueViolation` / `isContactBsuidUniqueViolation`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  const tx = { contact: { create: vi.fn() } };
  return {
    tx,
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    contactFindFirst: vi.fn().mockResolvedValue(null),
    allocateOrgNumber: vi.fn().mockResolvedValue(7),
    logEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
    contact: { findFirst: h.contactFindFirst, create: vi.fn() },
  },
  allocateOrgNumber: h.allocateOrgNumber,
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/services/activity-log", () => ({ logEvent: h.logEvent }));
vi.mock("@/services/kanban-filters", () => ({
  resolveContactSearchCandidates: vi.fn().mockResolvedValue({ contactIds: [] }),
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async (c: unknown[]) => c),
}));

import { runWithContext } from "@/lib/request-context";
import {
  createContact,
  findContactIdByPhone,
  isContactBsuidUniqueViolation,
  isContactNumberUniqueViolation,
} from "@/services/contacts";

const ORG = "org-a";

function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: orgId, userId: "user-1", isSuperAdmin: false },
    fn,
  ) as Promise<T>;
}

function createdData(callIndex = 0): Record<string, unknown> {
  return (h.tx.contact.create.mock.calls[callIndex]![0] as { data: Record<string, unknown> })
    .data;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.allocateOrgNumber.mockResolvedValue(7);
  h.tx.contact.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "contact-new",
    createdAt: new Date("2026-09-30T10:00:00Z"),
    email: null,
    ...args.data,
  }));
});

describe("createContact — telefone", () => {
  it("normaliza celular com 9º dígito em formato livre para E.164", async () => {
    await withOrg(ORG, () => createContact({ name: "Ana", phone: "(11) 9 8765-4321" }));
    expect(createdData().phone).toBe("+5511987654321");
  });

  it("normaliza número sem o 9 (fixo/legado) mantendo 8 dígitos", async () => {
    await withOrg(ORG, () => createContact({ name: "Ana", phone: "11 8765-4321" }));
    expect(createdData().phone).toBe("+551187654321");
  });

  it("aceita DDI 55 explícito e já-E.164 sem duplicar prefixo", async () => {
    await withOrg(ORG, () => createContact({ name: "A", phone: "5511987654321" }));
    await withOrg(ORG, () => createContact({ name: "B", phone: "+5511987654321" }));
    expect(createdData(0).phone).toBe("+5511987654321");
    expect(createdData(1).phone).toBe("+5511987654321");
  });

  it("descarta telefone impossível (texto / dois números) em vez de gravar lixo", async () => {
    await withOrg(ORG, () => createContact({ name: "Farmácia", phone: "Farmácia" }));
    await withOrg(ORG, () =>
      createContact({ name: "Dup", phone: "+5585991940125, +558591940125" }),
    );
    expect(createdData(0).phone).toBeUndefined();
    expect(createdData(1).phone).toBeUndefined();
  });

  it("telefone vazio/null vira ausente", async () => {
    await withOrg(ORG, () => createContact({ name: "Sem fone", phone: "   " }));
    await withOrg(ORG, () => createContact({ name: "Null", phone: null }));
    expect(createdData(0).phone).toBeUndefined();
    expect(createdData(1).phone).toBeUndefined();
  });
});

describe("createContact — org, numeração e log", () => {
  it("carimba organizationId do contexto e numera pelo contador da MESMA org", async () => {
    await withOrg("org-b", () => createContact({ name: "Bia" }));
    expect(createdData().organizationId).toBe("org-b");
    expect(createdData().number).toBe(7);
    expect(h.allocateOrgNumber).toHaveBeenCalledWith("Contact", "org-b");
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });

  it("fora de contexto de org não cria nada", async () => {
    await expect(createContact({ name: "X" })).rejects.toThrow(/organization context ausente/);
    expect(h.tx.contact.create).not.toHaveBeenCalled();
    expect(h.allocateOrgNumber).not.toHaveBeenCalled();
  });

  it("loga CONTACT_CREATED com origem e telefone normalizado", async () => {
    await withOrg(ORG, () =>
      createContact({ name: "Ana", phone: "11987654321", source: "meta_ads" }),
    );
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CONTACT_CREATED",
        entityType: "CONTACT",
        entityId: "contact-new",
        contactId: "contact-new",
        meta: expect.objectContaining({ phone: "+5511987654321", source: "meta_ads" }),
      }),
    );
  });

  it("retenta em colisão de (organizationId, number) com número novo", async () => {
    h.tx.contact.create
      .mockRejectedValueOnce(
        Object.assign(new Error("unique"), {
          code: "P2002",
          meta: { target: ["organizationId", "number"] },
        }),
      )
      .mockResolvedValueOnce({
        id: "contact-new",
        createdAt: new Date(),
        name: "Ana",
        email: null,
        phone: null,
      });
    h.allocateOrgNumber.mockResolvedValueOnce(7).mockResolvedValueOnce(8);

    const row = await withOrg(ORG, () => createContact({ name: "Ana" }));
    expect(row.id).toBe("contact-new");
    expect(h.tx.contact.create).toHaveBeenCalledTimes(2);
    expect(createdData(0).number).toBe(7);
    expect(createdData(1).number).toBe(8);
  });

  it("outro P2002 (bsuid) sobe sem retry — caller reaproveita o contato", async () => {
    const err = Object.assign(new Error("unique"), {
      code: "P2002",
      meta: { target: ["organizationId", "whatsappBsuid"] },
    });
    h.tx.contact.create.mockRejectedValueOnce(err);
    await expect(withOrg(ORG, () => createContact({ name: "Ana" }))).rejects.toBe(err);
    expect(h.tx.contact.create).toHaveBeenCalledTimes(1);
    expect(isContactBsuidUniqueViolation(err)).toBe(true);
    expect(isContactNumberUniqueViolation(err)).toBe(false);
  });
});

describe("findContactIdByPhone — dedupe tolerante ao 9º dígito", () => {
  it("procura as duas grafias (com e sem 9) restrito à org e pega o mais antigo", async () => {
    h.contactFindFirst.mockResolvedValueOnce({ id: "c-old" });
    const id = await findContactIdByPhone(ORG, "(11) 98765-4321");
    expect(id).toBe("c-old");
    expect(h.contactFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        phone: { in: ["+5511987654321", "+551187654321"] },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("celular legado de 8 dígitos também casa com a forma de 9", async () => {
    await findContactIdByPhone(ORG, "1187654321");
    const where = (h.contactFindFirst.mock.calls[0]![0] as { where: { phone: { in: string[] } } })
      .where;
    expect(where.phone.in).toEqual(["+551187654321", "+5511987654321"]);
  });

  it("fixo (8 dígitos começando em 2-5) não ganha variante com 9", async () => {
    await findContactIdByPhone(ORG, "1133334444");
    const where = (h.contactFindFirst.mock.calls[0]![0] as { where: { phone: { in: string[] } } })
      .where;
    expect(where.phone.in).toEqual(["+551133334444"]);
  });

  it("telefone inválido/vazio: null sem consultar o banco", async () => {
    expect(await findContactIdByPhone(ORG, "abc")).toBeNull();
    expect(await findContactIdByPhone(ORG, null)).toBeNull();
    expect(h.contactFindFirst).not.toHaveBeenCalled();
  });

  it("nunca busca fora da org informada", async () => {
    await findContactIdByPhone("org-z", "+5511987654321");
    const where = (h.contactFindFirst.mock.calls[0]![0] as { where: { organizationId: string } })
      .where;
    expect(where.organizationId).toBe("org-z");
  });
});
