import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { eventsFromRows, parseActionReportFilters } from "../actions-report";

const config = normalizeV2Config({
  name: "A",
  tone: "t",
  allowedPhoneNumbers: ["11999990000"],
  themes: [{ id: "t1", name: "Assunto 1", instructions: "x" }],
} as never);

const row = (extra: Record<string, unknown>) => ({
  id: "r1",
  conversationId: "c1",
  createdAt: new Date("2026-09-01T10:00:00Z"),
  inboundText: "oi",
  reply: null,
  handoff: false,
  error: null,
  prompt: "p",
  executedActions: [],
  discardedActions: [],
  facts: null,
  themeId: null,
  closed: null,
  appliedRuleId: null,
  conversationNumber: 12,
  contactName: "Cliente",
  contactPhone: "+55 11 98888-7777",
  ...extra,
});

const names = { stages: new Map([["s1", "Funil › Novo"]]), models: new Map([["m1", "Boas-vindas"]]) };

describe("relatório de ações", () => {
  it("cada turno vira as ações que ele fez, com detalhe legível", () => {
    const ev = eventsFromRows(
      [
        row({
          reply: "Pronto!",
          themeId: "t1",
          handoff: true,
          facts: { handoffCause: "no_source", source: "production" },
          executedActions: [
            { action: { type: "add_tag", tag: "Retorno" }, ok: true },
            { action: { type: "move_stage", stageId: "s1" }, ok: false, error: "No deal" },
            { action: { type: "set_theme", themeId: "t1" }, ok: true },
          ],
          discardedActions: [{ type: "send_message_model", modelId: "m1" }],
        }) as never,
      ],
      config,
      names,
    );
    expect(ev.map((e) => [e.type, e.status, e.detail])).toEqual([
      ["reply", "ok", "Pronto!"],
      ["add_tag", "ok", "Retorno"],
      ["move_stage", "failed", "Funil › Novo — No deal"],
      ["send_message_model", "discarded", "Boas-vindas"],
      ["handoff", "ok", "sem material"],
    ]);
    expect(ev[0]).toMatchObject({ themeName: "Assunto 1", source: "production", conversationNumber: 12 });
  });

  it("turno ignorado fica de fora; número de teste vira origem teste", () => {
    const ev = eventsFromRows(
      [
        row({ id: "x", error: "Phone number not in allowed test list" }) as never,
        row({ id: "t", reply: "oi!", contactPhone: "5511999990000" }) as never,
        row({ id: "f", error: "timeout do modelo" }) as never,
      ],
      config,
      names,
    );
    expect(ev.map((e) => [e.type, e.source])).toEqual([
      ["reply", "test"],
      ["failure", "production"],
    ]);
  });

  it("filtros da URL: período em dias de Brasília e listas", () => {
    const f = parseActionReportFilters(new URLSearchParams("from=2026-09-01&to=2026-09-02&types=add_tag,xpto&status=failed&source=test"));
    expect(f.from.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(f.to.toISOString()).toBe("2026-09-03T03:00:00.000Z");
    expect(f.types).toEqual(["add_tag"]);
    expect(f.statuses).toEqual(["failed"]);
    expect(f.sources).toEqual(["test"]);
  });
});
