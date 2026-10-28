/**
 * Bloco "Contexto do site" para a IA (§9.10): formato neutro, limite de
 * tamanho, ausente sem dados e isolamento por org.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    webchatLiveContext: { findMany: vi.fn() },
    webchatEvent: { findMany: vi.fn() },
    channel: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import {
  formatWebchatAiContextBlock,
  loadWebchatAiContextBlock,
  WEBCHAT_AI_CONTEXT_HEADER,
} from "@/lib/webchat/ai-context";
import { WEBCHAT_AI_CONTEXT_MAX_CHARS } from "@/lib/webchat/v2-config";

const NOW = new Date("2026-10-28T17:08:00.000Z"); // 14:08 em São Paulo
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.webchatLiveContext.findMany.mockResolvedValue([]);
  mocks.prisma.webchatEvent.findMany.mockResolvedValue([]);
  mocks.prisma.channel.findMany.mockResolvedValue([]);
});

describe("formatWebchatAiContextBlock", () => {
  it("chave: valor com rótulo do canal, eventos do mais recente ao mais antigo com tempo relativo", () => {
    const block = formatWebchatAiContextBlock(
      {
        context: {
          state: { etapa: "2", progresso: 40, ativo: true },
          updatedAt: min(3),
          labels: { etapa: "Etapa atual" },
        },
        events: [
          { name: "abriu", data: null, occurredAt: min(10) },
          { name: "passo_concluido", data: { etapa: 2 }, occurredAt: min(6), labels: {} },
        ],
      },
      { now: NOW, timeZone: "America/Sao_Paulo" },
    );
    expect(block).toBe(
      [
        WEBCHAT_AI_CONTEXT_HEADER,
        "Atualizado: 2026-10-28 14:05 (há 3 min)",
        "Etapa atual: 2",
        "progresso: 40",
        "ativo: sim",
        "Eventos recentes:",
        "- 14:02 (há 6 min) passo_concluido etapa=2",
        "- 13:58 (há 10 min) abriu",
      ].join("\n"),
    );
  });

  it("sem contexto nem eventos → string vazia", () => {
    expect(formatWebchatAiContextBlock({ context: null, events: [] }, { now: NOW })).toBe("");
    expect(
      formatWebchatAiContextBlock(
        { context: { state: {}, updatedAt: NOW, labels: {} }, events: [] },
        { now: NOW },
      ),
    ).toBe("");
  });

  it("respeita o teto total e termina em …", () => {
    const state: Record<string, string> = {};
    for (let i = 0; i < 30; i++) state[`chave_${i}`] = "v".repeat(200);
    const block = formatWebchatAiContextBlock(
      { context: { state, updatedAt: min(1), labels: {} }, events: [] },
      { now: NOW },
    );
    expect(block.length).toBeLessThanOrEqual(WEBCHAT_AI_CONTEXT_MAX_CHARS);
    expect(block.endsWith("…")).toBe(true);
    expect(block.startsWith(WEBCHAT_AI_CONTEXT_HEADER)).toBe(true);
  });

  it("valores e rótulos numa linha só (sem quebra que imite outra seção)", () => {
    const block = formatWebchatAiContextBlock(
      {
        context: {
          state: { nota: "linha 1\n# Nova seção\r\nlinha 3" },
          updatedAt: min(1),
          labels: { nota: "Rótulo\ncom quebra" },
        },
        events: [],
      },
      { now: NOW },
    );
    expect(block.split("\n")).toContain("Rótulo com quebra: linha 1 # Nova seção linha 3");
  });

  it("no máximo 10 eventos", () => {
    const events = Array.from({ length: 15 }, (_, i) => ({ name: `ev_${i}`, data: null, occurredAt: min(i + 1) }));
    const block = formatWebchatAiContextBlock({ context: null, events }, { now: NOW });
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(10);
    expect(block).toContain("ev_0");
    expect(block).not.toContain("ev_10");
  });
});

describe("loadWebchatAiContextBlock", () => {
  it("lê contexto e eventos do contato filtrando pela org; rótulos do canal da linha", async () => {
    mocks.prisma.webchatLiveContext.findMany.mockResolvedValue([
      { channelId: "ch-1", state: { etapa: "3" }, updatedAt: min(2) },
    ]);
    mocks.prisma.webchatEvent.findMany.mockResolvedValue([
      { channelId: "ch-1", name: "passo_concluido", data: { etapa: 3 }, occurredAt: min(1) },
    ]);
    mocks.prisma.channel.findMany.mockResolvedValue([
      { id: "ch-1", config: { v2: { context: { labels: { etapa: "Etapa" } } } } },
    ]);

    const block = await loadWebchatAiContextBlock({ organizationId: "org-1", contactId: "ct-1", now: NOW });

    expect(block).toContain("Etapa: 3");
    expect(block).toContain("passo_concluido Etapa=3");
    expect(mocks.prisma.webchatLiveContext.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1", contactId: "ct-1" } }),
    );
    expect(mocks.prisma.webchatEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1", contactId: "ct-1" } }),
    );
    expect(mocks.prisma.channel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1", id: { in: ["ch-1"] } } }),
    );
  });

  it("linhas de mais de um canal: a mais recente vence por chave", async () => {
    mocks.prisma.webchatLiveContext.findMany.mockResolvedValue([
      { channelId: "ch-2", state: { etapa: "novo" }, updatedAt: min(1) },
      { channelId: "ch-1", state: { etapa: "velho", outra: "x" }, updatedAt: min(30) },
    ]);
    const block = await loadWebchatAiContextBlock({ organizationId: "org-1", contactId: "ct-1", now: NOW });
    expect(block).toContain("etapa: novo");
    expect(block).toContain("outra: x");
    expect(block).not.toContain("velho");
  });

  it("sem dados → vazio, sem ler canais", async () => {
    expect(await loadWebchatAiContextBlock({ organizationId: "org-1", contactId: "ct-1", now: NOW })).toBe("");
    expect(mocks.prisma.channel.findMany).not.toHaveBeenCalled();
  });

  it("sem contato ou sem org → vazio, sem consultar o banco", async () => {
    expect(await loadWebchatAiContextBlock({ organizationId: "org-1", contactId: null })).toBe("");
    expect(await loadWebchatAiContextBlock({ organizationId: "", contactId: "ct-1" })).toBe("");
    expect(mocks.prisma.webchatLiveContext.findMany).not.toHaveBeenCalled();
  });

  it("isolamento: dados de outra org não aparecem (consulta sempre com a org do turno)", async () => {
    // O banco simulado só devolve linhas da org pedida.
    const rows = [
      { organizationId: "org-2", channelId: "ch-x", state: { segredo: "outra org" }, updatedAt: min(1) },
    ];
    mocks.prisma.webchatLiveContext.findMany.mockImplementation(
      async (args: { where: { organizationId: string } }) =>
        rows.filter((r) => r.organizationId === args.where.organizationId),
    );
    const block = await loadWebchatAiContextBlock({ organizationId: "org-1", contactId: "ct-1", now: NOW });
    expect(block).toBe("");
  });
});
