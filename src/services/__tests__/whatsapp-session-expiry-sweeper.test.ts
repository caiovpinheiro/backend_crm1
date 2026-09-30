/**
 * Sweeper de expiração de sessão WhatsApp (banco falso, sem Redis).
 *
 * - O corte inferior da janela e o filtro de org ficam ANTES do GROUP BY
 *   (a versão anterior agregava todas as mensagens de entrada de todas as
 *   orgs a cada minuto e só descartava no HAVING).
 * - O corte superior continua no HAVING.
 * - Prova de equivalência do predicado, sem banco: filtrar `t > oldest`
 *   antes de agregar dá o mesmo conjunto de grupos que `MAX(t) > oldest`.
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  automationFindMany: vi.fn(),
  queryRaw: vi.fn(),
  claimCreate: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    automation: { findMany: h.automationFindMany },
    $queryRaw: h.queryRaw,
    automationSessionExpiryClaim: { create: h.claimCreate },
  },
}));
vi.mock("@/lib/queue", () => ({ enqueueAutomationJob: h.enqueue }));
vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: (_orgId: string, fn: () => unknown) => fn(),
}));

import { sweepWhatsappSessionExpiryTriggers } from "@/services/whatsapp-session-expiry-sweeper";
import { WHATSAPP_SESSION_WINDOW_MS } from "@/services/whatsapp-session-expiry";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function lastSql(): { text: string; values: unknown[] } {
  const call = h.queryRaw.mock.calls.at(-1);
  expect(call).toBeDefined();
  const sql = (call as unknown[])[0] as Prisma.Sql;
  return { text: sql.strings.join("?"), values: sql.values };
}

/** Trecho da CTE: do `FROM` até o fim do `HAVING`. */
function sessionsCte(text: string): { where: string; having: string } {
  const groupBy = text.indexOf("GROUP BY");
  const having = text.indexOf("HAVING");
  const cteEnd = text.indexOf(")\n    SELECT");
  expect(groupBy).toBeGreaterThan(0);
  expect(having).toBeGreaterThan(groupBy);
  expect(cteEnd).toBeGreaterThan(having);
  return {
    where: text.slice(text.indexOf('FROM "conversations" c'), groupBy),
    having: text.slice(having, cteEnd),
  };
}

beforeEach(() => {
  h.automationFindMany.mockReset();
  h.queryRaw.mockReset();
  h.claimCreate.mockReset();
  h.enqueue.mockReset();
  h.queryRaw.mockResolvedValue([]);
  h.claimCreate.mockResolvedValue({});
  h.enqueue.mockResolvedValue(undefined);
});

describe("sweepWhatsappSessionExpiryTriggers: SQL dos candidatos", () => {
  it("sem automação configurada não consulta mensagens", async () => {
    h.automationFindMany.mockResolvedValue([]);
    const result = await sweepWhatsappSessionExpiryTriggers(NOW);
    expect(result).toEqual({ candidates: 0, claimed: 0 });
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("corte inferior e orgs configuradas entram antes do GROUP BY; só o superior fica no HAVING", async () => {
    h.automationFindMany.mockResolvedValue([
      { id: "auto-1", organizationId: "org-a", triggerConfig: { hoursBeforeExpiry: 2 } },
      { id: "auto-2", organizationId: "org-b", triggerConfig: { hoursBeforeExpiry: 4 } },
      { id: "auto-3", organizationId: "org-a", triggerConfig: { hoursBeforeExpiry: 1 } },
      // Sem horas válidas: não conta como configurada.
      { id: "auto-x", organizationId: "org-z", triggerConfig: { hoursBeforeExpiry: 0 } },
    ]);

    await sweepWhatsappSessionExpiryTriggers(NOW);

    const { text, values } = lastSql();
    const { where, having } = sessionsCte(text);

    // Corte inferior: junto do JOIN em messages (antes de agregar).
    expect(where).toMatch(/m\."createdAt" > \?/);
    expect(having).not.toMatch(/> \?/);
    // Corte superior: continua depois de agregar.
    expect(having).toMatch(/MAX\(m\."createdAt"\) <= \?/);
    expect(where).not.toMatch(/<= \?/);
    // Só as orgs com automação válida, sem repetir.
    expect(where).toMatch(/c\."organizationId" IN \(\?,\?\)/);

    // Ordem dos parâmetros: corte inferior (JOIN), orgs (WHERE), corte
    // superior (HAVING) — o maior `hoursBeforeExpiry` configurado (4 h).
    const oldest = new Date(NOW.getTime() - WHATSAPP_SESSION_WINDOW_MS);
    const newest = new Date(oldest.getTime() + 4 * HOUR_MS);
    expect(values).toEqual([oldest, "org-a", "org-b", newest]);
  });

  it("candidato dentro da janela vira claim e job da automação da mesma org", async () => {
    h.automationFindMany.mockResolvedValue([
      { id: "auto-1", organizationId: "org-a", triggerConfig: { hoursBeforeExpiry: 2 } },
      { id: "auto-2", organizationId: "org-b", triggerConfig: { hoursBeforeExpiry: 2 } },
    ]);
    // Sessão expira em 1 h: dentro do horizonte de 2 h.
    const lastInboundAt = new Date(NOW.getTime() - WHATSAPP_SESSION_WINDOW_MS + HOUR_MS);
    h.queryRaw.mockResolvedValue([
      {
        organizationId: "org-a",
        conversationId: "conv-1",
        contactId: "contact-1",
        channel: "whatsapp",
        channelId: "ch-1",
        lastInboundAt,
      },
    ]);

    const result = await sweepWhatsappSessionExpiryTriggers(NOW);

    expect(result).toEqual({ candidates: 1, claimed: 1 });
    expect(h.claimCreate).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0]).toMatchObject({
      automationId: "auto-1",
      context: { event: "whatsapp_session_expiring", contactId: "contact-1" },
    });
  });
});

describe("predicado da janela: WHERE t > oldest ≡ HAVING MAX(t) > oldest", () => {
  const oldest = 100;
  const newest = 140;

  /** Versão anterior: agrega tudo e filtra depois. */
  function havingOnly(group: number[]): number | null {
    if (group.length === 0) return null;
    const max = Math.max(...group);
    return max > oldest && max <= newest ? max : null;
  }

  /** Versão nova: filtra o corte inferior antes, o superior depois. */
  function whereThenHaving(group: number[]): number | null {
    const kept = group.filter((t) => t > oldest);
    if (kept.length === 0) return null;
    const max = Math.max(...kept);
    return max <= newest ? max : null;
  }

  const cases: Array<[string, number[]]> = [
    ["vazio", []],
    ["tudo antes do corte", [10, 50, 100]],
    ["exatamente no corte inferior (exclusivo)", [100]],
    ["um inbound dentro da janela", [10, 120]],
    ["vários dentro da janela", [101, 120, 140]],
    ["exatamente no corte superior (inclusivo)", [140]],
    ["inbound mais novo que a janela esconderia a sessão", [120, 141]],
    ["só depois da janela", [200, 300]],
    ["antigo + novo demais", [10, 500]],
  ];

  for (const [name, group] of cases) {
    it(name, () => {
      expect(whereThenHaving(group)).toBe(havingOnly(group));
    });
  }

  it("varredura determinística de combinações", () => {
    const points = [0, 99, 100, 101, 120, 140, 141, 999];
    for (let mask = 0; mask < 1 << points.length; mask++) {
      const group = points.filter((_, i) => mask & (1 << i));
      expect(whereThenHaving(group), JSON.stringify(group)).toBe(havingOnly(group));
    }
  });
});
