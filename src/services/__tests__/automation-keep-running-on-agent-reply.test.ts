/**
 * "Continuar mesmo se o consultor responder": mensagem do consultor
 * (cancelActiveContextsForContactIfAny) não encerra o contexto de automação
 * com `keepRunningOnAgentReply`; as demais continuam sendo encerradas.
 * Regressão: espera de formulário FLOW morria quando a consultora tirava
 * uma dúvida do cliente e a resposta do formulário chegava sem contexto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Ctx = {
  id: string;
  contactId: string;
  status: string;
  timeoutAt: Date | null;
  automation: { id: string; name: string; keepRunningOnAgentReply: boolean; steps: unknown[] };
};

const db = vi.hoisted(() => ({ contexts: [] as Ctx[] }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationContext: {
      findFirst: async ({ where }: { where: { contactId: string } }) =>
        db.contexts.find(
          (c) => c.contactId === where.contactId && ["RUNNING", "PAUSED"].includes(c.status),
        ) ?? null,
      findMany: async ({ where }: { where: { contactId: string } }) =>
        db.contexts.filter(
          (c) => c.contactId === where.contactId && ["RUNNING", "PAUSED"].includes(c.status),
        ),
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.contexts.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Ctx> }) => {
        const c = db.contexts.find((x) => x.id === where.id)!;
        Object.assign(c, data);
        return { ...c, organizationId: "org-1", automationId: c.automation.id };
      },
    },
  },
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/realtime-events", () => ({ publishAutomationState: vi.fn() }));

import {
  cancelActiveContextsForContact,
  cancelActiveContextsForContactIfAny,
} from "@/services/automation-context";

function ctx(id: string, keep: boolean): Ctx {
  return {
    id,
    contactId: "contato-1",
    status: "PAUSED",
    timeoutAt: null,
    automation: { id: `auto-${id}`, name: id, keepRunningOnAgentReply: keep, steps: [] },
  };
}

beforeEach(() => {
  db.contexts = [ctx("formulario", true), ctx("boas-vindas", false)];
});

describe("mensagem do consultor", () => {
  it("encerra só as automações sem a opção; a do formulário segue esperando", async () => {
    const n = await cancelActiveContextsForContactIfAny("contato-1");
    expect(n).toBe(1);
    expect(db.contexts.find((c) => c.id === "formulario")?.status).toBe("PAUSED");
    expect(db.contexts.find((c) => c.id === "boas-vindas")?.status).toBe("COMPLETED");
  });

  it("sem a opção em nenhuma: comportamento de antes (encerra todas)", async () => {
    db.contexts = [ctx("a", false), ctx("b", false)];
    expect(await cancelActiveContextsForContactIfAny("contato-1")).toBe(2);
    expect(db.contexts.every((c) => c.status === "COMPLETED")).toBe(true);
  });

  it("outros encerramentos (handoff do inbound) não mudam: encerram mesmo com a opção", async () => {
    expect(await cancelActiveContextsForContact("contato-1")).toBe(2);
  });
});

describe("cliente responde depois que o consultor falou", () => {
  const consultorFalouNaEspera = {
    humanAttending: true,
    hasHumanReply: true,
    pausedAt: new Date("2026-11-05T13:40:18Z"),
    lastHumanReplyAt: new Date("2026-11-05T13:47:41Z"),
  };

  it("sem a opção: encerra (comportamento de antes)", async () => {
    const { humanReplyEndsContext } = await import("@/services/automation-context");
    expect(humanReplyEndsContext(false, consultorFalouNaEspera)).toBe(true);
  });

  it("com a opção: não encerra, o fluxo segue esperando", async () => {
    const { humanReplyEndsContext } = await import("@/services/automation-context");
    expect(humanReplyEndsContext(true, consultorFalouNaEspera)).toBe(false);
  });
});
