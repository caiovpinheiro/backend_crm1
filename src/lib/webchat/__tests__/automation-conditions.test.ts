/**
 * Condições de automação sobre o site (§9.10): contexto vivo (existe /
 * igual a / contém) e "evento X ocorreu nos últimos N min", no passo
 * Condição e nas condições do gatilho; isolamento por org.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type CtxRow = { organizationId: string; contactId: string; state: unknown; updatedAt: Date };
type EvRow = { id: string; organizationId: string; contactId: string; name: string; occurredAt: Date };

const db = vi.hoisted(() => ({ contexts: [] as CtxRow[], events: [] as EvRow[] }));

const mocks = vi.hoisted(() => ({
  prisma: {
    webchatLiveContext: {
      findMany: vi.fn(async (args: { where: { organizationId: string; contactId: string } }) =>
        db.contexts
          .filter((r) => r.organizationId === args.where.organizationId && r.contactId === args.where.contactId)
          .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
          .map((r) => ({ state: r.state })),
      ),
    },
    webchatEvent: {
      findFirst: vi.fn(
        async (args: { where: { organizationId: string; contactId: string; name: string; occurredAt: { gte: Date } } }) =>
          db.events.find(
            (e) =>
              e.organizationId === args.where.organizationId &&
              e.contactId === args.where.contactId &&
              e.name === args.where.name &&
              e.occurredAt >= args.where.occurredAt.gte,
          ) ?? null,
      ),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { normalizeConditionConfig, summarizeConditionConfig } from "@/lib/automation-condition";
import {
  createSiteConditionReader,
  evaluateSiteRule,
  evaluateSiteTriggerCondition,
  isSiteRule,
  parseWindowMinutes,
} from "@/lib/webchat/automation-conditions";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000);

const reader = (organizationId = "org-1", contactId = "ct-1") =>
  createSiteConditionReader({ organizationId, contactId, now: () => NOW });

beforeEach(() => {
  vi.clearAllMocks();
  db.contexts = [
    { organizationId: "org-1", contactId: "ct-1", state: { etapa: "Etapa 2", "plano.tipo": "B", vazio: "" }, updatedAt: ago(5) },
    { organizationId: "org-1", contactId: "ct-1", state: { etapa: "Etapa 3" }, updatedAt: ago(1) },
    { organizationId: "org-2", contactId: "ct-1", state: { so_na_outra: "x" }, updatedAt: ago(1) },
  ];
  db.events = [
    { id: "e1", organizationId: "org-1", contactId: "ct-1", name: "passo_concluido", occurredAt: ago(10) },
    { id: "e2", organizationId: "org-2", contactId: "ct-1", name: "evento_outra_org", occurredAt: ago(1) },
  ];
});

describe("passo Condição — siteContext.<chave>", () => {
  const rule = (field: string, op: string, value: unknown = "") => ({ field, op, value });

  it("existe / não existe", async () => {
    const r = reader();
    expect(await evaluateSiteRule(rule("siteContext.etapa", "exists"), r)).toBe(true);
    expect(await evaluateSiteRule(rule("siteContext.ausente", "exists"), r)).toBe(false);
    expect(await evaluateSiteRule(rule("siteContext.vazio", "exists"), r)).toBe(false);
    expect(await evaluateSiteRule(rule("siteContext.ausente", "not_exists"), r)).toBe(true);
    expect(await evaluateSiteRule(rule("siteContext.etapa", "not_exists"), r)).toBe(false);
  });

  it("igual a (sem diferenciar maiúsculas) — a linha mais recente vence", async () => {
    const r = reader();
    expect(await evaluateSiteRule(rule("siteContext.etapa", "eq", "etapa 3"), r)).toBe(true);
    expect(await evaluateSiteRule(rule("siteContext.etapa", "eq", "Etapa 2"), r)).toBe(false);
    expect(await evaluateSiteRule(rule("siteContext.etapa", "ne", "Etapa 2"), r)).toBe(true);
  });

  it("contém", async () => {
    const r = reader();
    expect(await evaluateSiteRule(rule("siteContext.etapa", "includes", "tapa"), r)).toBe(true);
    expect(await evaluateSiteRule(rule("siteContext.etapa", "includes", "zzz"), r)).toBe(false);
    expect(await evaluateSiteRule(rule("siteContext.etapa", "includes", ""), r)).toBe(false);
  });

  it("chave com ponto é lida inteira (não como caminho)", async () => {
    expect(await evaluateSiteRule(rule("siteContext.plano.tipo", "eq", "b"), reader())).toBe(true);
  });

  it("contexto lido uma vez por avaliação (cache)", async () => {
    const r = reader();
    await evaluateSiteRule(rule("siteContext.etapa", "exists"), r);
    await evaluateSiteRule(rule("siteContext.plano.tipo", "exists"), r);
    expect(mocks.prisma.webchatLiveContext.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("passo Condição — siteEvent.<nome> ocorreu nos últimos N min", () => {
  it("dentro / fora da janela, e a forma negativa", async () => {
    const r = reader();
    const f = "siteEvent.passo_concluido";
    expect(await evaluateSiteRule({ field: f, op: "occurred_within", value: "15" }, r)).toBe(true);
    expect(await evaluateSiteRule({ field: f, op: "occurred_within", value: 5 }, r)).toBe(false);
    expect(await evaluateSiteRule({ field: f, op: "not_occurred_within", value: 5 }, r)).toBe(true);
    expect(await evaluateSiteRule({ field: "siteEvent.outro", op: "occurred_within", value: 60 }, r)).toBe(false);
  });

  it("janela inválida não bate", async () => {
    const f = "siteEvent.passo_concluido";
    expect(await evaluateSiteRule({ field: f, op: "occurred_within", value: "abc" }, reader())).toBe(false);
    expect(await evaluateSiteRule({ field: f, op: "occurred_within", value: 0 }, reader())).toBe(false);
    expect(parseWindowMinutes(10_000_000)).toBe(365 * 24 * 60);
  });
});

describe("isolamento por org", () => {
  it("contexto e eventos de outra org nunca entram", async () => {
    const r = reader("org-1");
    expect(await evaluateSiteRule({ field: "siteContext.so_na_outra", op: "exists", value: "" }, r)).toBe(false);
    expect(
      await evaluateSiteRule({ field: "siteEvent.evento_outra_org", op: "occurred_within", value: 60 }, r),
    ).toBe(false);
    for (const call of mocks.prisma.webchatLiveContext.findMany.mock.calls) {
      expect(call[0].where.organizationId).toBe("org-1");
    }
    for (const call of mocks.prisma.webchatEvent.findFirst.mock.calls) {
      expect(call[0].where.organizationId).toBe("org-1");
    }
  });

  it("sem org ou sem contato: nada é consultado e nada bate", async () => {
    const r = createSiteConditionReader({ organizationId: null, contactId: "ct-1" });
    expect(await evaluateSiteRule({ field: "siteContext.etapa", op: "exists", value: "" }, r)).toBe(false);
    const r2 = createSiteConditionReader({ organizationId: "org-1", contactId: null });
    expect(await evaluateSiteRule({ field: "siteEvent.passo_concluido", op: "occurred_within", value: 60 }, r2)).toBe(false);
    expect(mocks.prisma.webchatLiveContext.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.webchatEvent.findFirst).not.toHaveBeenCalled();
  });
});

describe("condições do gatilho", () => {
  it("site_context: existe / igual a / contém", async () => {
    const r = reader();
    expect(await evaluateSiteTriggerCondition({ type: "site_context", key: "etapa" }, r)).toBe(true);
    expect(await evaluateSiteTriggerCondition({ type: "site_context", key: "ausente", op: "exists" }, r)).toBe(false);
    expect(await evaluateSiteTriggerCondition({ type: "site_context", key: "etapa", op: "eq", value: "Etapa 3" }, r)).toBe(true);
    expect(await evaluateSiteTriggerCondition({ type: "site_context", key: "etapa", op: "includes", value: "2" }, r)).toBe(false);
  });

  it("site_event: ocorreu / não ocorreu nos últimos N min", async () => {
    const r = reader();
    expect(await evaluateSiteTriggerCondition({ type: "site_event", name: "passo_concluido", minutes: 30 }, r)).toBe(true);
    expect(await evaluateSiteTriggerCondition({ type: "site_event", name: "passo_concluido", minutes: 5 }, r)).toBe(false);
    expect(
      await evaluateSiteTriggerCondition({ type: "site_event", name: "passo_concluido", minutes: 5, op: "not_occurred" }, r),
    ).toBe(true);
  });

  it("vazia não filtra; inválida não passa; outro tipo → null", async () => {
    const r = reader();
    expect(await evaluateSiteTriggerCondition({ type: "site_context", key: "" }, r)).toBe(true);
    expect(await evaluateSiteTriggerCondition({ type: "site_context", key: "x y" }, r)).toBe(false);
    expect(await evaluateSiteTriggerCondition({ type: "site_event", name: "passo_concluido", minutes: "x" }, r)).toBe(false);
    expect(await evaluateSiteTriggerCondition({ type: "tag", tagId: "t" }, r)).toBeNull();
  });
});

describe("config da condição", () => {
  it("normalize preserva os ops novos e o resumo é legível", () => {
    const cfg = normalizeConditionConfig({
      branches: [
        {
          rules: [
            { field: "siteContext.etapa", op: "exists", value: "" },
            { field: "siteEvent.passo_concluido", op: "occurred_within", value: "15" },
          ],
        },
      ],
    });
    expect(cfg.branches[0].rules.map((r) => r.op)).toEqual(["exists", "occurred_within"]);
    expect(cfg.branches[0].rules.every(isSiteRule)).toBe(true);
    expect(
      summarizeConditionConfig({
        branches: [{ rules: [{ field: "siteEvent.passo_concluido", op: "occurred_within", value: 15 }] }],
      }),
    ).toBe('evento "passo_concluido" ocorreu nos últimos 15 min');
  });
});
