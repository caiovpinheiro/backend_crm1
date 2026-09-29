import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  exec: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentConfig: { findFirst: mocks.findFirst },
    $executeRawUnsafe: mocks.exec,
    $queryRawUnsafe: mocks.query,
  },
}));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { DraftConflictError, saveV2AgentDraft } from "../agents";

const config = normalizeV2Config({ name: "Agente de teste", tone: "Objetivo" });

describe("salvar rascunho com versão esperada", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue({ id: "agent-1", draftConfig: null, simpleConfig: config });
    mocks.query.mockResolvedValue([{ draftVersion: 4 }]);
  });

  it("grava quando o rascunho ainda é o que a tela carregou e devolve a versão nova", async () => {
    mocks.exec.mockResolvedValue(1);
    const r = await saveV2AgentDraft("agent-1", "org-1", { config, expectedDraftVersion: 3 });
    expect(r.draftVersion).toBe(4);
    const sql = mocks.exec.mock.calls[0][0] as string;
    expect(sql).toContain('"draftVersion" = "draftVersion" + 1');
    expect(sql).toContain('AND "draftVersion" = $4');
    expect(mocks.exec.mock.calls[0].slice(1)).toEqual([JSON.stringify(config), "agent-1", "org-1", 3]);
  });

  it("outra aba salvou antes: não sobrescreve e responde conflito com a versão atual", async () => {
    mocks.exec.mockResolvedValue(0);
    mocks.query.mockResolvedValue([{ draftVersion: 5 }]);
    await expect(saveV2AgentDraft("agent-1", "org-1", { config, expectedDraftVersion: 3 })).rejects.toBeInstanceOf(DraftConflictError);
    await expect(saveV2AgentDraft("agent-1", "org-1", { config, expectedDraftVersion: 3 })).rejects.toMatchObject({ code: "DRAFT_CONFLICT", draftVersion: 5 });
  });

  it("sem versão esperada (cliente antigo) grava como antes", async () => {
    mocks.exec.mockResolvedValue(1);
    await saveV2AgentDraft("agent-1", "org-1", { config });
    const sql = mocks.exec.mock.calls[0][0] as string;
    expect(sql).not.toContain('AND "draftVersion" = $4');
    expect(mocks.exec.mock.calls[0]).toHaveLength(4);
  });
});
