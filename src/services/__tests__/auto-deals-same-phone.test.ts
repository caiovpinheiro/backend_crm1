/**
 * Inbound não abre deal quando o telefone já tem card em outro contato.
 * A busca é pelo deal (variantes com/sem o 9 e legado), sem teto de linhas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dealFindFirst: vi.fn(),
  dealCreate: vi.fn(),
  contactFindUnique: vi.fn(),
  contactFindFirst: vi.fn(),
  contactFindMany: vi.fn(),
  pipelineFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    deal: {
      findFirst: (...args: unknown[]) => h.dealFindFirst(...args),
      create: (...args: unknown[]) => h.dealCreate(...args),
      aggregate: vi.fn(),
    },
    contact: {
      findUnique: (...args: unknown[]) => h.contactFindUnique(...args),
      findFirst: (...args: unknown[]) => h.contactFindFirst(...args),
      findMany: (...args: unknown[]) => h.contactFindMany(...args),
    },
    pipeline: { findFirst: (...args: unknown[]) => h.pipelineFindFirst(...args) },
    channel: { findUnique: vi.fn() },
    stage: { findFirst: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@/lib/cache/keys", () => ({ scheduleBoardInvalidation: vi.fn() }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (data: unknown) => data }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org" }));
vi.mock("@/services/automation-triggers", () => ({ fireTrigger: vi.fn() }));
vi.mock("@/services/deals", () => ({ nextDealNumber: vi.fn() }));
vi.mock("@/services/lead-distribution", () => ({ getNextOwner: vi.fn() }));
vi.mock("@/services/pipelines", () => ({
  allocateStageSlug: vi.fn(),
  isStageNumberUniqueViolation: () => false,
  nextStageNumber: vi.fn(),
}));

import {
  ensureOpenDealForContact,
  findExistingContactOnPhone,
} from "@/services/auto-deals";

const SELF = "c-new";
const OTHER = "c-old";
const PHONE_WITH_9 = "+5511987654321";
const PHONE_WITHOUT_9 = "+551187654321";

type DealQuery = {
  where?: {
    contactId?: string | { in?: string[] };
    status?: string;
    contact?: { phone?: { in?: string[] }; id?: { not?: string } };
  };
  take?: number;
};

function queryOf(call: unknown[]): DealQuery {
  return (call[0] ?? {}) as DealQuery;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.contactFindMany.mockResolvedValue([]);
  h.contactFindFirst.mockResolvedValue(null);
  h.pipelineFindFirst.mockResolvedValue(null);
  h.contactFindUnique.mockResolvedValue({ phone: PHONE_WITH_9 });
});

describe("findExistingContactOnPhone", () => {
  it("acha o deal aberto pelo telefone, com e sem o 9, sem cortar a lista", async () => {
    h.dealFindFirst.mockImplementation(async (args: DealQuery) => {
      const phoneIn = args.where?.contact?.phone?.in ?? [];
      if (args.where?.status === "OPEN" && phoneIn.includes(PHONE_WITHOUT_9)) {
        return { id: "deal-old", contactId: OTHER };
      }
      return null;
    });

    const hit = await findExistingContactOnPhone(PHONE_WITHOUT_9, SELF);

    expect(hit).toEqual({ contactId: OTHER, dealId: "deal-old", open: true });
    const openCall = h.dealFindFirst.mock.calls.map(queryOf).find((q) => q.where?.status === "OPEN");
    expect(openCall?.where?.contact?.phone?.in).toEqual(
      expect.arrayContaining([PHONE_WITH_9, PHONE_WITHOUT_9]),
    );
    expect(openCall?.where?.contact?.id).toEqual({ not: SELF });
    expect(openCall?.take).toBeUndefined();
    expect(h.contactFindMany).not.toHaveBeenCalled();
  });

  it("cai no telefone legado quando o E.164 não tem deal", async () => {
    h.dealFindFirst.mockImplementation(async (args: DealQuery) => {
      if (args.where?.contact?.phone) return null;
      const ids = args.where?.contactId;
      if (args.where?.status === "OPEN" && ids && typeof ids === "object" && ids.in?.includes("c-leg")) {
        return { id: "deal-leg", contactId: "c-leg" };
      }
      return null;
    });
    h.contactFindMany.mockResolvedValue([{ id: "c-leg", phone: "11987654321" }]);

    const hit = await findExistingContactOnPhone(PHONE_WITH_9);

    expect(hit).toEqual({ contactId: "c-leg", dealId: "deal-leg", open: true });
    expect(h.contactFindMany.mock.calls[0]?.[0]?.take).toBeUndefined();
  });
});

describe("ensureOpenDealForContact — telefone já tem card", () => {
  function mockDeals(hit: { id: string; contactId: string; open: boolean } | null) {
    h.dealFindFirst.mockImplementation(async (args: DealQuery) => {
      if (typeof args.where?.contactId === "string") return null;
      if (!hit) return null;
      if (args.where?.status === "OPEN") {
        return hit.open ? { id: hit.id, contactId: hit.contactId } : null;
      }
      if (args.where?.contact?.phone) {
        return { id: hit.id, contactId: hit.contactId };
      }
      return null;
    });
  }

  it("não cria deal quando outro contato da mesma linha tem card aberto", async () => {
    mockDeals({ id: "deal-old", contactId: OTHER, open: true });

    const result = await ensureOpenDealForContact({
      contactId: SELF,
      contactName: "Mário",
    });

    expect(result).toEqual({ status: "existing", dealId: "deal-old" });
    expect(h.dealCreate).not.toHaveBeenCalled();
  });

  it("não cria deal quando o outro contato só tem card fechado", async () => {
    mockDeals({ id: "deal-lost", contactId: OTHER, open: false });

    const result = await ensureOpenDealForContact({
      contactId: SELF,
      contactName: "Mário",
    });

    expect(result).toEqual({ status: "skipped", reason: "contact_has_closed_deal" });
    expect(h.dealCreate).not.toHaveBeenCalled();
  });

  it("não cria deal quando o próprio contato já tem card aberto", async () => {
    h.dealFindFirst.mockResolvedValue({ id: "deal-self", status: "OPEN" });

    const result = await ensureOpenDealForContact({
      contactId: SELF,
      contactName: "Mário",
    });

    expect(result).toEqual({ status: "existing", dealId: "deal-self" });
    expect(h.contactFindUnique).not.toHaveBeenCalled();
    expect(h.dealCreate).not.toHaveBeenCalled();
  });

  it("não cria deal quando o próprio contato já tem card ganho ou perdido", async () => {
    h.dealFindFirst.mockResolvedValue({ id: "deal-won", status: "WON" });

    const result = await ensureOpenDealForContact({
      contactId: SELF,
      contactName: "Mário",
    });

    expect(result).toEqual({ status: "skipped", reason: "contact_has_closed_deal" });
    expect(h.dealCreate).not.toHaveBeenCalled();
  });
});
