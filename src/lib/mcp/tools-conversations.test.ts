import { describe, expect, it } from "vitest";

import {
  classifyCloser,
  classifySender,
  decodeCursor,
  encodeCursor,
  parseBound,
} from "@/lib/mcp/tools-conversations";
import { isMcpOwnScopeOnly, MCP_DEFAULT_ORG_SCOPES, MCP_SCOPES } from "@/lib/mcp/scopes";

describe("MCP atendimento — regras puras", () => {
  it("quem encerrou: IA e fechamento em massa usam o mesmo caminho; só o ator separa", () => {
    expect(classifyCloser({ actorType: "AI", meta: { source: "bulk-sync" } })).toBe("ia");
    expect(classifyCloser({ actorType: "HUMAN", meta: { source: "bulk-sync" } })).toBe("massa");
    expect(classifyCloser({ actorType: "HUMAN", meta: { action: "close" } })).toBe("pessoa");
    expect(classifyCloser({ actorType: "AUTOMATION", meta: {} })).toBe("automacao");
    expect(classifyCloser({ actorType: "HUMAN", meta: { source: "automation" } })).toBe("automacao");
    expect(classifyCloser({ actorType: "SYSTEM", meta: { source: "idle_inbound" } })).toBe("inatividade");
    expect(classifyCloser({ actorType: "SYSTEM", meta: null })).toBe("sistema");
    expect(classifyCloser({ actorType: "HUMAN", meta: { action: "ai_tabulate_close" } })).toBe("ia");
    expect(classifyCloser({ actorType: "INTEGRATION", meta: {} })).toBe("integracao");
  });

  it("remetente da mensagem", () => {
    expect(classifySender({ direction: "in", authorType: "human", aiAgentUserId: null })).toBe("contato");
    expect(classifySender({ direction: "out", authorType: "human", aiAgentUserId: null })).toBe("atendente");
    expect(classifySender({ direction: "out", authorType: "bot", aiAgentUserId: "u1" })).toBe("agente_ia");
    expect(classifySender({ direction: "out", authorType: "bot", aiAgentUserId: null })).toBe("automacao");
    expect(classifySender({ direction: "out", authorType: "system", aiAgentUserId: null })).toBe("sistema");
  });

  it("cursor: ida e volta; recusa cursor de outra ordenação ou corrompido", () => {
    const c = encodeCursor({ s: "createdAt", o: "desc", v: "2026-11-03T15:00:00.000Z", id: "abc" });
    expect(decodeCursor(c, "createdAt", "desc").id).toBe("abc");
    expect(() => decodeCursor(c, "updatedAt", "desc")).toThrow();
    expect(() => decodeCursor(c, "createdAt", "asc")).toThrow();
    expect(() => decodeCursor("lixo", "createdAt", "desc")).toThrow();
  });

  it("período: dia inteiro em Brasília ou ISO; formato inválido é erro", () => {
    const from = parseBound("2026-11-10", false, "createdFrom")!;
    const to = parseBound("2026-11-10", true, "createdTo")!;
    expect(to.getTime() - from.getTime()).toBeGreaterThan(23 * 3600 * 1000);
    expect(from.toISOString()).toBe("2026-11-10T03:00:00.000Z");
    expect(parseBound("2026-11-10T12:00:00Z", false, "x")!.toISOString()).toBe("2026-11-10T12:00:00.000Z");
    expect(() => parseBound("ontem", false, "x")).toThrow();
  });

  it("escopos novos existem, mas ficam fora do padrão da org", () => {
    for (const s of ["events:read", "queue:read", "custom_fields:read", "audio:read"] as const) {
      expect(MCP_SCOPES).toContain(s);
      expect(MCP_DEFAULT_ORG_SCOPES).not.toContain(s);
    }
    expect(isMcpOwnScopeOnly({ role: "MEMBER", isAdmin: false })).toBe(true);
    expect(isMcpOwnScopeOnly({ role: "MANAGER", isAdmin: false })).toBe(false);
    expect(isMcpOwnScopeOnly({ role: "MEMBER", isAdmin: true })).toBe(false);
  });
});
