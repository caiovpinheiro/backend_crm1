import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  events: [] as unknown[],
  agentFind: vi.fn(async () => [] as { id: string; user: { name: string | null } | null }[]),
}));

vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org-1" }));
vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    $queryRaw: async () => [],
    activityEvent: { count: async () => h.events.length, findMany: async () => h.events },
    tabulation: { findMany: async () => [] },
    user: { findMany: async () => [] },
    department: { findMany: async () => [] },
    aIAgentConfig: { findMany: h.agentFind },
  }),
}));

import {
  getTabulationAnalytics,
  resolveTabulationActor,
  type TabulationActorSource,
} from "@/services/tabulation-analytics";

const base: TabulationActorSource = {
  actorType: null,
  actorUserId: null,
  actorLabel: null,
  actorRef: null,
  actorUser: null,
  meta: {},
};
const ev = (over: Partial<TabulationActorSource>): TabulationActorSource => ({ ...base, ...over });

describe("resolveTabulationActor — por origem", () => {
  it("humano (outbox das ações da conversa): usuário com nome", () => {
    expect(
      resolveTabulationActor(
        ev({
          actorType: "HUMAN",
          actorUserId: "u1",
          actorUser: { name: "Ana", type: "HUMAN" },
          meta: { tabulationId: "t1" },
        }),
      ),
    ).toEqual({ kind: "user", id: "u1", name: "Ana" });
  });

  it("IA (runner → runWithActor): agente com nome e id do agente, mesmo com actorUserId do contexto", () => {
    expect(
      resolveTabulationActor(
        ev({
          actorType: "AI",
          actorLabel: "Sofia",
          actorRef: "agent_1",
          actorUserId: "u_humano_do_contexto",
          actorUser: { name: "Ana", type: "HUMAN" },
          meta: { source: "AI_AGENT" },
        }),
      ),
    ).toEqual({ kind: "ai_agent", id: "agent_1", name: "Sofia" });
  });

  it("IA sem rótulo gravado: completa o nome pelo id do agente", () => {
    expect(
      resolveTabulationActor(
        ev({ actorType: "AI", actorRef: "agent_1", meta: { source: "AI_AGENT" } }),
        new Map([["agent_1", "Sofia"]]),
      ),
    ).toEqual({ kind: "ai_agent", id: "agent_1", name: "Sofia" });
  });

  it("IA gravada sem contexto de ator (fechamento da IA): cai em meta.source AI_AGENT", () => {
    expect(
      resolveTabulationActor(ev({ actorType: "SYSTEM", actorLabel: "Sistema", meta: { source: "AI_AGENT", auto: true } })),
    ).toEqual({ kind: "ai_agent", id: null, name: "Sistema" });
  });

  it("usuário do tipo IA (actorUserId aponta para o usuário do agente)", () => {
    expect(
      resolveTabulationActor(
        ev({ actorType: "HUMAN", actorUserId: "u_ai", actorUser: { name: "Sofia", type: "AI" } }),
      ),
    ).toEqual({ kind: "ai_agent", id: "u_ai", name: "Sofia" });
  });

  it("automação: nome e id da automação; actorUserId do disparador não vira o ator", () => {
    expect(
      resolveTabulationActor(
        ev({
          actorType: "AUTOMATION",
          actorLabel: "Pós-venda",
          actorRef: "auto_1",
          actorUserId: "u1",
          actorUser: { name: "Ana", type: "HUMAN" },
          meta: { source: "automation", step: "tabulate_conversation" },
        }),
      ),
    ).toEqual({ kind: "automation", id: "auto_1", name: "Pós-venda" });
  });

  it("automação sem contexto de ator: meta.source automation", () => {
    expect(
      resolveTabulationActor(ev({ actorType: "SYSTEM", meta: { source: "automation" } })),
    ).toEqual({ kind: "automation", id: null, name: null });
  });

  it("outros (encerramento em massa, integração, sem ator): sistema", () => {
    expect(resolveTabulationActor(ev({ actorType: "SYSTEM", actorLabel: "Sistema", meta: { source: "bulk-sync" } }))).toEqual({
      kind: "system",
      id: null,
      name: "Sistema",
    });
    expect(resolveTabulationActor(ev({ actorType: "INTEGRATION" }))).toEqual({
      kind: "system",
      id: null,
      name: "Sistema",
    });
    expect(resolveTabulationActor(ev({}))).toEqual({ kind: "system", id: null, name: "Sistema" });
  });

  it("evento antigo sem actorType mas com usuário: usuário", () => {
    expect(
      resolveTabulationActor(ev({ actorUserId: "u1", actorUser: { name: "Ana", type: "HUMAN" } })),
    ).toEqual({ kind: "user", id: "u1", name: "Ana" });
  });
});

describe("getTabulationAnalytics — actor em cada item do log", () => {
  it("inclui actor, mantém actorUserId/actorName e busca o nome do agente só quando falta o rótulo", async () => {
    const at = new Date("2026-10-03T12:00:00Z");
    const row = (id: string, over: Record<string, unknown>) => ({
      id,
      occurredAt: at,
      conversationId: `c_${id}`,
      contactId: null,
      contact: null,
      meta: { tabulationId: "t1" },
      actorUserId: null,
      actorType: "SYSTEM",
      actorLabel: null,
      actorRef: null,
      actorUser: null,
      ...over,
    });
    h.events = [
      row("e1", { actorType: "HUMAN", actorUserId: "u1", actorUser: { id: "u1", name: "Ana", type: "HUMAN" } }),
      row("e2", { actorType: "AI", actorRef: "agent_1", meta: { tabulationId: "t1", source: "AI_AGENT" } }),
      row("e3", { actorType: "AUTOMATION", actorLabel: "Pós-venda", actorRef: "auto_1" }),
      row("e4", { actorType: "SYSTEM" }),
    ];
    h.agentFind.mockResolvedValueOnce([{ id: "agent_1", user: { name: "Sofia" } }]);

    const out = await getTabulationAnalytics({
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-10-06T00:00:00Z"),
    });

    expect(out.items.map((i) => i.actor)).toEqual([
      { kind: "user", id: "u1", name: "Ana" },
      { kind: "ai_agent", id: "agent_1", name: "Sofia" },
      { kind: "automation", id: "auto_1", name: "Pós-venda" },
      { kind: "system", id: null, name: "Sistema" },
    ]);
    // Campos antigos intactos.
    expect(out.items[0]).toMatchObject({ actorUserId: "u1", actorName: "Ana" });
    expect(out.items[1]).toMatchObject({ actorUserId: null, actorName: null });
    expect(h.agentFind).toHaveBeenCalledTimes(1);
  });
});
