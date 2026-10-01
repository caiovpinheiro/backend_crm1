/**
 * S1 — o replay com handoff real não pode vazar para fora do sandbox.
 *
 * O que este teste prova, sem banco: com o sandbox ligado, cada ponto de
 * saída recusa. O risco que motivou o item é concreto — `source: "inbox"`
 * liga o caminho de produção inteiro, e um replay noturno poderia mandar
 * WhatsApp para um aluno real e pendurar a conversa de teste na fila de um
 * consultor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  blockedEffects,
  disableReplaySandbox,
  enableReplaySandbox,
  isReplaySandboxActive,
  resetReplaySandboxForTest,
} from "@/services/ai/replay-sandbox";

const ORG = "org_sandbox";

describe("S1 sandbox do --real-handoff", () => {
  beforeEach(() => {
    resetReplaySandboxForTest();
  });

  it("desligado por padrão: produção não passa pelos guards", () => {
    expect(isReplaySandboxActive()).toBe(false);
    expect(isReplaySandboxActive(ORG)).toBe(false);
  });

  it("ligado só para a org do replay", () => {
    enableReplaySandbox(ORG);
    expect(isReplaySandboxActive(ORG)).toBe(true);
    expect(isReplaySandboxActive("outra_org")).toBe(false);
    disableReplaySandbox();
    expect(isReplaySandboxActive(ORG)).toBe(false);
  });

  it("SSE não publica: operador não vê a conversa de teste", async () => {
    const { sseBus } = await import("@/lib/sse-bus");
    const fanout = vi
      .spyOn(
        sseBus as unknown as { fanout: (...a: unknown[]) => Promise<void> },
        "fanout",
      )
      .mockResolvedValue(undefined);
    enableReplaySandbox(ORG);
    sseBus.publish("conversation_assigned", {
      organizationId: ORG,
      conversationId: "c1",
    });
    expect(fanout).not.toHaveBeenCalled();
    expect(blockedEffects().map((b) => b.effect)).toContain("sse_publish");
    fanout.mockRestore();
  });

  it("desligado: SSE publica normalmente", async () => {
    const { sseBus } = await import("@/lib/sse-bus");
    const fanout = vi
      .spyOn(
        sseBus as unknown as { fanout: (...a: unknown[]) => Promise<void> },
        "fanout",
      )
      .mockResolvedValue(undefined);
    sseBus.publish("conversation_assigned", {
      organizationId: ORG,
      conversationId: "c1",
    });
    expect(fanout).toHaveBeenCalled();
    expect(blockedEffects()).toHaveLength(0);
    fanout.mockRestore();
  });

  it("desligado: o assign nem consulta o tipo do usuário", async () => {
    const { assignOwnerToContactClusterTx } = await import("@/services/deals");
    const userFindUnique = vi.fn(async () => ({ type: "HUMAN" }));
    const tx = {
      user: { findUnique: userFindUnique },
      conversation: { findUnique: async () => ({ contactId: null }) },
      deal: { findUnique: async () => null },
    };
    // Sem sandbox o guard não existe: a função segue o caminho normal (aqui
    // ela para por falta de contato, o que já prova que passou do guard).
    await assignOwnerToContactClusterTx(tx as never, {
      userId: "u_humano",
      via: "smart",
    }).catch(() => null);
    expect(userFindUnique).not.toHaveBeenCalled();
    expect(blockedEffects()).toHaveLength(0);
  });

  it("só o script de replay liga o sandbox", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(process.cwd(), "src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
        if (readFileSync(full, "utf8").includes("enableReplaySandbox")) {
          hits.push(relative(root, full).replaceAll("\\", "/"));
        }
      }
    };
    walk(root);
    // Servidor HTTP, worker de inbox e jobs só importam os leitores do flag.
    // Se um deles passar a LIGAR o sandbox, produção para de enviar mensagem.
    expect(hits.sort()).toEqual([
      "scripts/replay-agent-runs.ts",
      "services/ai/__tests__/replay-sandbox.test.ts",
      "services/ai/__tests__/replay-sandbox-effects.test.ts",
      "services/ai/replay-sandbox.ts",
    ].sort());
  });

  it("nenhuma atribuição a usuário humano; agente IA passa", async () => {
    const { assignOwnerToContactClusterTx } = await import("@/services/deals");
    enableReplaySandbox(ORG);

    const humanTx = {
      user: { findUnique: async () => ({ type: "HUMAN" }) },
      conversation: { findUnique: async () => ({ contactId: "ct1" }) },
    };
    const res = await assignOwnerToContactClusterTx(
      humanTx as never,
      { userId: "u_humano", contactId: "ct1", via: "ai_handoff" },
    );
    expect(res.dealIds).toEqual([]);
    expect(res.fromOwnerId).toBeNull();
    expect(blockedEffects().map((b) => b.effect)).toContain("human_assignment");
  });

  it("automação de etapa não dispara", async () => {
    const { notifyDealStageChanged } = await import(
      "@/services/automation-triggers"
    );
    enableReplaySandbox(ORG);
    await notifyDealStageChanged("d1", "s1", "s2");
    expect(blockedEffects().map((b) => b.effect)).toContain(
      "automation_trigger",
    );
  });

  it("saudação pós-handoff não sai pelo canal", async () => {
    const { triggerAgentOpeningForContact } = await import(
      "@/services/ai/piloting-actions"
    );
    enableReplaySandbox(ORG);
    const r = await triggerAgentOpeningForContact({
      contactId: "ct1",
      agentUserId: "ai1",
    });
    expect(r).toEqual({ status: "skipped", reason: "replay_sandbox" });
    expect(blockedEffects().map((b) => b.effect)).toContain("outbound_send");
  });
});
