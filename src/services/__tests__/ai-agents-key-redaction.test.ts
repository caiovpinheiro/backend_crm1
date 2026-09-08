import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A chave OpenAI cifrada (`openaiApiKeyEnc`) NUNCA pode sair no corpo de
 * resposta. O GET já fazia o strip; o PUT devolvia o row cru do Prisma
 * direto pro cliente (`/api/ai-agents/[id]` → NextResponse.json(updated)).
 */

const AGENT_ROW = {
  id: "cfg-1",
  userId: "user-1",
  organizationId: "org-1",
  archetype: "SDR",
  model: "gpt-4o-mini",
  active: true,
  openaiApiKeyEnc: "enc:v1:CHAVE-CIFRADA-NAO-PODE-VAZAR",
  openaiApiKeyHint: "sk-…9abc",
};

const updateMock = vi.fn(async (_args: unknown) => ({ ...AGENT_ROW }));
// `_count` acompanha o `include` de getAIAgent/updateAIAgent — o gate de
// readiness (AUTONOMOUS) lê `_count.knowledgeDocs`.
const findUniqueMock = vi.fn(async (_args: unknown) => ({
  ...AGENT_ROW,
  user: { id: "user-1", name: "Ana" },
  _count: { knowledgeDocs: 0 },
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    aIAgentConfig: {
      findUnique: (args: unknown) => findUniqueMock(args),
      update: (args: unknown) => updateMock(args),
    },
    aIAgentConfigAudit: { create: vi.fn(async () => ({})) },
    user: { update: vi.fn(async () => ({})) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(client),
  };
  return { prisma: client };
});

vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: (data: unknown) => data,
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org-1",
  getRequestContext: () => ({ userId: "user-1" }),
}));

vi.mock("@/lib/public-id", () => ({
  nextUserNumber: async () => 1,
  NUMBERED_ORG_MODELS: new Set<string>(),
}));

vi.mock("@/lib/secret-crypto", () => ({
  encryptSecret: (v: string) => `enc:${v}`,
}));

import {
  getAIAgent,
  redactAgentOpenaiKey,
  toggleAIAgentActive,
  updateAIAgent,
} from "@/services/ai-agents";

describe("redactAgentOpenaiKey", () => {
  it("remove openaiApiKeyEnc e devolve hasOwnOpenaiKey + hint", () => {
    const safe = redactAgentOpenaiKey({ ...AGENT_ROW });
    expect(safe).not.toHaveProperty("openaiApiKeyEnc");
    expect(safe.hasOwnOpenaiKey).toBe(true);
    expect(safe.openaiApiKeyHint).toBe("sk-…9abc");
  });

  it("hasOwnOpenaiKey=false quando o agente não tem chave própria", () => {
    const safe = redactAgentOpenaiKey({
      ...AGENT_ROW,
      openaiApiKeyEnc: null,
    });
    expect(safe.hasOwnOpenaiKey).toBe(false);
    expect(safe).not.toHaveProperty("openaiApiKeyEnc");
  });
});

describe("updateAIAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retorno do update NÃO contém openaiApiKeyEnc", async () => {
    const updated = await updateAIAgent("cfg-1", { model: "gpt-4o" });

    expect(updated).not.toHaveProperty("openaiApiKeyEnc");
    expect(JSON.stringify(updated)).not.toContain("CHAVE-CIFRADA");
  });

  it("retorno do update contém hasOwnOpenaiKey e openaiApiKeyHint", async () => {
    const updated = await updateAIAgent("cfg-1", { model: "gpt-4o" });

    expect(updated.hasOwnOpenaiKey).toBe(true);
    expect(updated.openaiApiKeyHint).toBe("sk-…9abc");
  });
});

describe("getAIAgent / toggleAIAgentActive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET continua redigido (mesmo helper)", async () => {
    const agent = await getAIAgent("cfg-1");
    expect(agent).not.toHaveProperty("openaiApiKeyEnc");
    expect(agent?.hasOwnOpenaiKey).toBe(true);
  });

  it("toggle-active não devolve a chave cifrada", async () => {
    const toggled = await toggleAIAgentActive("cfg-1");
    expect(toggled).not.toHaveProperty("openaiApiKeyEnc");
    expect(toggled.active).toBe(true);
  });
});
