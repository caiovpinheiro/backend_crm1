/**
 * S1 (complemento) — os três caminhos que gastam dinheiro ou acordam gente:
 * distribuição, envio de texto pelo canal e template da Graph API.
 *
 * Cada um é testado LIGADO e DESLIGADO. O par importa mais que o caso
 * isolado: um guard que sempre recusa protegeria o replay e quebraria a
 * produção, e o teste só do modo ligado não veria a diferença.
 *
 * Arquivo separado do `replay-sandbox.test.ts` porque aqui os módulos
 * precisam ser mockados antes do import (hoisting do `vi.mock`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendText = vi.fn(async () => ({ messages: [{ id: "wamid.1" }] }));
const sendTemplate = vi.fn(async () => ({ messages: [{ id: "wamid.2" }] }));
const responsibles = vi.fn(async () => [
  { userId: "u_consultor", name: "Consultora Ana", eligible: true, volume: 1 },
]);

vi.mock("@/lib/meta-whatsapp/client", () => ({
  metaClientFromConfig: () => ({
    configured: true,
    sendText,
    sendTemplate,
    sendTypingIndicator: vi.fn(),
    markAsRead: vi.fn(),
  }),
}));

vi.mock("@/services/organization-widgets", () => ({
  hasOrganizationWidget: vi.fn(async () => true),
}));
vi.mock("@/services/distribution/enabled", () => ({
  isDistributionEnabled: vi.fn(async () => true),
  DISTRIBUTION_ENABLED_KEY: "distribution.enabled",
}));
vi.mock("@/services/distribution/responsibles", () => ({
  getDistributionResponsibles: responsibles,
}));

const messageCreate = vi.fn(async () => ({
  id: "m1",
  content: "oi",
  createdAt: new Date(),
}));
const conversationUpdate = vi.fn(async () => ({}));

vi.mock("@/lib/prisma", () => {
  const conversation = {
    findUnique: vi.fn(async () => ({
      id: "conv1",
      organizationId: "org_sandbox",
      channelId: "ch1",
      channelRef: {
        id: "ch1",
        config: {},
        provider: "META",
        status: "CONNECTED",
        name: "WhatsApp",
      },
      waJid: null,
      departmentId: null,
      assignedToId: null,
      contactId: "ct1",
    })),
    findFirst: vi.fn(async () => null),
    update: conversationUpdate,
  };
  const known: Record<string, unknown> = {
    conversation,
    message: {
      create: messageCreate,
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    contact: { findUnique: vi.fn(async () => ({ phone: "5511999999999" })) },
    user: { findUnique: vi.fn(async () => ({ name: "Agente IA" })) },
  };
  // Model desconhecido devolve stub vazio: o teste é sobre quem chama o
  // canal, não sobre a query de cada gate do caminho.
  const stub = () =>
    new Proxy(
      {},
      { get: () => vi.fn(async () => null) },
    );
  const prisma = new Proxy(
    {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(stub())),
    } as Record<string, unknown>,
    {
      get: (t, p: string) =>
        t[p] ?? known[p] ?? (known[p] = stub()),
    },
  );
  return { prisma, allocateOrgNumber: vi.fn(async () => 1) };
});

vi.mock("@/lib/request-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgIdOrNull: () => "org_sandbox",
  getOrgIdOrThrow: () => "org_sandbox",
}));

import {
  blockedEffects,
  enableReplaySandbox,
  resetReplaySandboxForTest,
} from "@/services/ai/replay-sandbox";

const ORG = "org_sandbox";

describe("S1 efeitos caros no sandbox", () => {
  beforeEach(() => {
    resetReplaySandboxForTest();
    vi.clearAllMocks();
  });

  describe("distribuição (engine.ts)", () => {
    it("ligado: resolve o operador e não atribui", async () => {
      const { executeDistribution } = await import(
        "@/services/distribution/engine"
      );
      enableReplaySandbox(ORG);
      const r = await executeDistribution({
        conversationId: "conv1",
        contactId: "ct1",
        dealId: null,
        triggerSource: "AI_AGENT",
        reassign: true,
      });
      expect(r.simulated).toBe(true);
      expect(r.selectedUserId).toBe("u_consultor");
      expect(r.selectedUserName).toBe("Consultora Ana");
      // A atribuição escreve na conversa; a simulação não escreve nada.
      expect(conversationUpdate).not.toHaveBeenCalled();
      expect(blockedEffects().map((b) => b.effect)).toContain(
        "distribution_assign",
      );
    });

    it("desligado: segue o caminho normal de atribuição", async () => {
      const { executeDistribution } = await import(
        "@/services/distribution/engine"
      );
      const { hasOrganizationWidget } = await import(
        "@/services/organization-widgets"
      );
      // Sem o desvio do sandbox a chamada passa pelos gates de produção —
      // é justamente o primeiro deles que a simulação pula.
      vi.mocked(hasOrganizationWidget).mockResolvedValueOnce(false);
      const r = await executeDistribution({
        conversationId: "conv1",
        contactId: "ct1",
        dealId: null,
        triggerSource: "AI_AGENT",
        reassign: true,
      });
      expect(r.simulated).toBeUndefined();
      expect(r.reason).toBe("SMART_DISTRIBUTION_NOT_ENABLED");
      expect(blockedEffects()).toHaveLength(0);
    });
  });

  describe("sendAgentMessage (piloting-actions.ts)", () => {
    const args = {
      conversationId: "conv1",
      contactId: "ct1",
      agentUserId: "ai1",
      autonomyMode: "AUTONOMOUS" as const,
      text: "oi, tudo bem?",
      bypassAssigneeCheck: true,
      bypassDuplicateGuard: true,
    };

    async function send() {
      const { sendAgentMessage } = await import(
        "@/services/ai/piloting-actions"
      );
      const { runWithContext } = await import("@/lib/request-context");
      return runWithContext(
        { organizationId: ORG, userId: "ai1", isSuperAdmin: false },
        () => sendAgentMessage(args),
      );
    }

    it("ligado: não chama o canal, grava rascunho", async () => {
      enableReplaySandbox(ORG);
      const r = await send();
      expect(sendText).not.toHaveBeenCalled();
      expect(r.status).toBe("draft");
      expect(blockedEffects().map((b) => b.effect)).toContain("outbound_send");
    });

    it("desligado: chama o canal", async () => {
      await send();
      expect(sendText).toHaveBeenCalledWith(
        "5511999999999",
        "oi, tudo bem?",
      );
    });
  });

  describe("template Meta (tools.ts)", () => {
    async function callTemplateTool() {
      const { buildToolSet } = await import("@/services/ai/tools");
      const set = buildToolSet(
        {
          agentId: "a1",
          agentUserId: "ai1",
          agentName: "Agente",
          organizationId: ORG,
          conversationId: "conv1",
          contactId: "ct1",
          dealId: null,
        } as never,
        ["send_whatsapp_template"],
      );
      const tool = (
        set as unknown as Record<string, { execute: (a: unknown) => unknown }>
      ).send_whatsapp_template;
      return tool.execute({ templateName: "boas_vindas" });
    }

    it("ligado: não chama a Graph API", async () => {
      enableReplaySandbox(ORG);
      const r = (await callTemplateTool()) as { ok?: boolean };
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(blockedEffects().map((b) => b.effect)).toContain("outbound_send");
    });

    it("desligado: chama a Graph API", async () => {
      await callTemplateTool();
      expect(sendTemplate).toHaveBeenCalled();
    });
  });
});
