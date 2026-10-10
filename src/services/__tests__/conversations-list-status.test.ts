/**
 * `services/conversations` — listagem e mudança de status sem Postgres (CL-15).
 *
 * Cobre:
 *  - `buildConversationListWhere`: predicado de cada aba (`tabToWhere` é
 *    interno; entra pela aba), união de abas, `todos` com categorias do
 *    MEMBER, visibilidade em AND com aba/busca, `status` só sem aba,
 *    escopo de canais permitidos, setting "reply do agente conta".
 *  - `getConversations`: colapso por contato+canal SÓ em Encerradas/
 *    Resolvendo (DISTINCT ON), nunca em fila quente ou união mista.
 *  - `updateConversationStatusInDb`: encerrar preenche `closedAt`, zera
 *    `hasError`, invalida badges (pela janela coalescida
 *    `scheduleTabCountsInvalidation`), devolve o deal ao funil de origem
 *    (`restoreDealToAcademicOrigin`), enfileira redistribuição; Acompanhar
 *    não encerra; reabrir limpa tabulação; desvincular atendente loga.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    queryRaw: vi.fn().mockResolvedValue([]),
    conversation: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    automationContext: { findMany: vi.fn().mockResolvedValue([]) },
    orgSetting: vi.fn().mockResolvedValue(null as string | null),
    scheduleTabCountsInvalidation: vi.fn(),
    ssePublish: vi.fn(),
    logEvent: vi.fn().mockResolvedValue(undefined),
    scheduleDrain: vi.fn().mockResolvedValue(undefined),
    clearContactOwnershipOnClose: vi.fn().mockResolvedValue(undefined),
  };
});

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

// O log saiu do `console` e foi para o logger estruturado: o teste espiona
// o logger e mantém a mesma garantia sobre o que é (e não é) logado.
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: vi.fn(),
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    conversation: h.conversation,
    automationContext: h.automationContext,
    contact: { count: vi.fn() },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  },
  allocateOrgNumber: vi.fn(),
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: h.ssePublish } }));
vi.mock("@/services/activity-log", () => ({
  logEvent: h.logEvent,
  userIdForFk: (v: unknown) => v ?? null,
}));
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingFor: h.orgSetting,
  getOrgSetting: vi.fn().mockResolvedValue(null),
  getOrgSettingBool: vi.fn().mockResolvedValue(false),
}));
// `conversations.ts` zera os badges pela janela coalescida de 15 s
// (`scheduleTabCountsInvalidation`), nunca pelo `invalidateInboxTabCounts`
// direto (ver `tab-counts-invalidation.test.ts`) — a costura observável é
// o agendamento; a purga em si é coberta lá.
vi.mock("@/lib/cache/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache/keys")>()),
  scheduleTabCountsInvalidation: h.scheduleTabCountsInvalidation,
}));
vi.mock("@/services/channels", () => ({
  parseInboxFilterChannelIds: (ids: string[]) => ({ ids, missing: [], deleted: false }),
}));
vi.mock("@/services/kanban-filters", () => ({
  SOURCE_NONE: "__none__",
  findContactIdsByPhoneDigits: vi.fn().mockResolvedValue([]),
  resolveConversationSearchCandidates: vi.fn(async () => ({
    contactIds: [],
    assignedToIds: [],
  })),
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async (c: unknown[]) => c),
}));
vi.mock("@/services/distribution/pending", () => ({
  scheduleProcessPendingDistributionQueue: h.scheduleDrain,
}));
vi.mock("@/services/deals", () => ({
  clearContactOwnershipOnClose: h.clearContactOwnershipOnClose,
}));

import type { Prisma } from "@prisma/client";

import {
  activeInboxQueueGuardWhere,
  encerradasTabWhere,
  resolvidosTabWhere,
} from "@/lib/inbox-queue-membership";
import { runWithContext } from "@/lib/request-context";
import {
  buildConversationListWhere,
  getConversations,
  updateConversationStatusInDb,
} from "@/services/conversations";

const ORG = "org-a";

function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: orgId, userId: "user-1", isSuperAdmin: false },
    fn,
  ) as Promise<T>;
}

/** Procura `needle` (por igualdade estrutural) em qualquer nó da árvore. */
function treeContains(tree: unknown, needle: unknown): boolean {
  if (JSON.stringify(tree) === JSON.stringify(needle)) return true;
  if (Array.isArray(tree)) return tree.some((n) => treeContains(n, needle));
  if (tree && typeof tree === "object") {
    return Object.values(tree as Record<string, unknown>).some((v) => treeContains(v, needle));
  }
  return false;
}

/** Sub-árvore que casa parcialmente (todas as chaves de `partial` presentes e iguais). */
function treeHasMatch(tree: unknown, partial: Record<string, unknown>): boolean {
  if (tree && typeof tree === "object" && !Array.isArray(tree)) {
    const obj = tree as Record<string, unknown>;
    const ok = Object.entries(partial).every(
      ([k, v]) => k in obj && JSON.stringify(obj[k]) === JSON.stringify(v),
    );
    if (ok) return true;
  }
  if (Array.isArray(tree)) return tree.some((n) => treeHasMatch(n, partial));
  if (tree && typeof tree === "object") {
    return Object.values(tree as Record<string, unknown>).some((v) => treeHasMatch(v, partial));
  }
  return false;
}

function andOf(where: Prisma.ConversationWhereInput): Prisma.ConversationWhereInput[] {
  return Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
}

const GUARD = activeInboxQueueGuardWhere();

beforeEach(() => {
  vi.clearAllMocks();
  h.orgSetting.mockResolvedValue(null);
  h.queryRaw.mockResolvedValue([]);
  h.conversation.findMany.mockResolvedValue([]);
  h.automationContext.findMany.mockResolvedValue([]);
});

describe("buildConversationListWhere — abas", () => {
  async function tabWhere(tab: Parameters<typeof buildConversationListWhere>[0]["tab"]) {
    const where = await withOrg(ORG, () => buildConversationListWhere({ tab }));
    const parts = andOf(where);
    expect(parts).toHaveLength(1);
    return parts[0]!;
  }

  it("entrada: fila quente (guard), sem erro, sem dono com inbound OU humano sem reply; fora da fila Automação", async () => {
    const w = await tabWhere("entrada");
    expect(treeContains(w, GUARD)).toBe(true);
    expect(treeHasMatch(w, { hasError: false })).toBe(true);
    expect(treeHasMatch(w, { assignedToId: null, lastInboundAt: { not: null } })).toBe(true);
    expect(treeHasMatch(w, { assignedTo: { is: { type: "HUMAN" } } })).toBe(true);
    // setting OFF: só reply humano conta
    expect(treeHasMatch(w, { hasHumanReply: false })).toBe(true);
    expect(treeContains(w, { hasHumanReply: false, hasAgentReply: false })).toBe(false);
    // excluída da fila Automação (contexto vivo ou robô falou por último)
    expect(treeHasMatch(w, { hasAgentReply: true, hasHumanReply: false, lastMessageDirection: "out" })).toBe(true);
    expect(JSON.stringify(w)).toContain('"NOT"');
    // aba de fila quente NUNCA inclui RESOLVED
    expect(treeContains(w, { status: "RESOLVED" })).toBe(false);
  });

  it("esperando: humano responsável, já respondida, cliente falou por último", async () => {
    const w = await tabWhere("esperando");
    expect(treeContains(w, GUARD)).toBe(true);
    expect(treeHasMatch(w, {
      assignedTo: { is: { type: "HUMAN" } },
      lastMessageDirection: "in",
      hasError: false,
    })).toBe(true);
    expect(treeContains(w, { hasHumanReply: true })).toBe(true);
  });

  it("respondidas: mesmo recorte de esperando, mas nós falamos por último", async () => {
    const w = await tabWhere("respondidas");
    expect(treeHasMatch(w, {
      assignedTo: { is: { type: "HUMAN" } },
      lastMessageDirection: "out",
      hasError: false,
    })).toBe(true);
    expect(treeContains(w, GUARD)).toBe(true);
  });

  it("agente_ia: responsável do tipo AI, com guard de fila ativa", async () => {
    const w = await tabWhere("agente_ia");
    expect(w).toEqual({
      AND: [GUARD, { hasError: false, assignedTo: { is: { type: "AI" } } }],
    });
  });

  it("automacao: contexto RUNNING/PAUSED (ou bot falou por último) sem assignee IA e sem erro", async () => {
    const w = await tabWhere("automacao");
    expect(treeContains(w, GUARD)).toBe(true);
    expect(treeHasMatch(w, { hasError: false })).toBe(true);
    expect(treeHasMatch(w, { status: { in: ["RUNNING", "PAUSED"] } })).toBe(true);
    expect(treeHasMatch(w, { hasAgentReply: true, hasHumanReply: false, lastMessageDirection: "out" })).toBe(true);
    expect(treeContains(w, { assignedTo: { is: { type: "AI" } } })).toBe(false);
  });

  it("resolvidos / finalizados / erro / abertas / ligar usam os predicados compartilhados", async () => {
    expect(await tabWhere("resolvidos")).toEqual(resolvidosTabWhere());
    expect(await tabWhere("finalizados")).toEqual(encerradasTabWhere());
    expect(await tabWhere("erro")).toEqual({ AND: [GUARD, { hasError: true }] });
    expect(await tabWhere("abertas")).toEqual(GUARD);
    const ligar = await tabWhere("ligar");
    expect(treeHasMatch(ligar, {
      channel: "whatsapp",
      hasError: false,
      whatsappCallConsentStatus: "GRANTED",
    })).toBe(true);
    expect(treeContains(ligar, GUARD)).toBe(true);
  });

  it("finalizados só traz encerradas de verdade — deal GANHO/PERDIDO com ticket OPEN fica fora", async () => {
    const w = await tabWhere("finalizados");
    expect(treeContains(w, { status: "RESOLVED" })).toBe(true);
    expect(treeContains(w, { closedAt: { not: null } })).toBe(true);
    expect(JSON.stringify(w)).not.toMatch(/stage|deal|isWon|isLost/i);
  });

  it("setting 'reply do agente conta' muda Aguardando e Entrada", async () => {
    h.orgSetting.mockResolvedValue("true");
    const esperando = await tabWhere("esperando");
    expect(treeContains(esperando, { OR: [{ hasHumanReply: true }, { hasAgentReply: true }] })).toBe(true);
    const entrada = await tabWhere("entrada");
    expect(treeHasMatch(entrada, { hasHumanReply: false, hasAgentReply: false })).toBe(true);
  });

  it("várias abas viram OR; `todos` junto com outras vira só `todos`", async () => {
    const where = await withOrg(ORG, () =>
      buildConversationListWhere({ tab: ["erro", "resolvidos"] }),
    );
    expect(andOf(where)).toEqual([
      { OR: [{ AND: [GUARD, { hasError: true }] }, resolvidosTabWhere()] },
    ]);

    const todos = await withOrg(ORG, () =>
      buildConversationListWhere({ tab: ["todos", "erro"] }),
    );
    expect(todos).toEqual({});
  });

  it("`todos` de MEMBER vira OR das categorias permitidas (não vê a org inteira)", async () => {
    const where = await withOrg(ORG, () =>
      buildConversationListWhere({ tab: "todos", todosCategoryTabs: ["erro", "finalizados"] }),
    );
    expect(andOf(where)).toEqual([
      { OR: [{ AND: [GUARD, { hasError: true }] }, encerradasTabWhere()] },
    ]);
  });
});

describe("buildConversationListWhere — composição", () => {
  it("visibilidade vem primeiro e em AND com a aba (nunca substitui)", async () => {
    const visibilityWhere = { assignedToId: { in: ["user-1"] } };
    const where = await withOrg(ORG, () =>
      buildConversationListWhere({ tab: "erro", visibilityWhere }),
    );
    expect(andOf(where)).toEqual([visibilityWhere, { AND: [GUARD, { hasError: true }] }]);
  });

  it("busca + aba são AND: '#123' pesquisa o número do ticket mas mantém a aba", async () => {
    const where = await withOrg(ORG, () =>
      buildConversationListWhere({ tab: "finalizados", search: "#123" }),
    );
    const parts = andOf(where);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      OR: [{ inboxName: { contains: "#123", mode: "insensitive" } }, { number: 123 }],
    });
    expect(parts[1]).toEqual(encerradasTabWhere());
  });

  it("telefone com 11 dígitos não vira `number` (estouraria o Int4)", async () => {
    const where = await withOrg(ORG, () =>
      buildConversationListWhere({ search: "11987654321" }),
    );
    expect(treeContains(where, { number: 11987654321 })).toBe(false);
  });

  it("`status` só entra quando NÃO há aba", async () => {
    const semAba = await withOrg(ORG, () => buildConversationListWhere({ status: "PENDING" }));
    expect(andOf(semAba)).toEqual([{ status: "PENDING" }]);

    const comAba = await withOrg(ORG, () =>
      buildConversationListWhere({ status: "PENDING", tab: "erro" }),
    );
    expect(treeContains(comAba, { status: "PENDING" })).toBe(false);
  });

  it("allowedChannelIds (mesmo vazio) restringe canais; null não restringe", async () => {
    const restrito = await withOrg(ORG, () =>
      buildConversationListWhere({ allowedChannelIds: [] }),
    );
    expect(andOf(restrito)).toEqual([{ channelId: { in: [] } }]);

    const livre = await withOrg(ORG, () =>
      buildConversationListWhere({ allowedChannelIds: null }),
    );
    expect(livre).toEqual({});
  });

  it("filtros do painel: responsável, sem dono, etapa, tag, origem", async () => {
    const where = await withOrg(ORG, () =>
      buildConversationListWhere({
        ownerIds: ["u1"],
        ownerId: "u2",
        stageIds: ["s1"],
        tagIds: ["t1"],
        sources: ["meta", "__none__"],
      }),
    );
    const parts = andOf(where);
    expect(parts).toContainEqual({ assignedToId: { in: ["u1", "u2"] } });
    expect(parts).toContainEqual({ contact: { deals: { some: { stageId: { in: ["s1"] } } } } });
    expect(parts).toContainEqual({ contact: { tags: { some: { tagId: { in: ["t1"] } } } } });
    expect(treeContains(where, { contact: { source: { in: ["meta"] } } })).toBe(true);
    expect(treeContains(where, { contactId: null })).toBe(true);

    const semDono = await withOrg(ORG, () =>
      buildConversationListWhere({ withoutOwner: true, ownerIds: ["u1"] }),
    );
    expect(andOf(semDono)).toEqual([{ assignedToId: null }]);
  });
});

describe("getConversations — colapso por contato+canal", () => {
  function flattenSqlValues(values: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const v of values) {
      if (v && typeof v === "object" && Array.isArray((v as { values?: unknown[] }).values)) {
        out.push(...flattenSqlValues((v as { values: unknown[] }).values));
      } else {
        out.push(v);
      }
    }
    return out;
  }

  /** `$queryRaw` recebe um template (strings, ...values) ou um `Prisma.Sql`. */
  function rawText(call: unknown[]): string {
    const [first] = call as [TemplateStringsArray | Prisma.Sql];
    return Array.isArray(first)
      ? first.join("?")
      : (first as Prisma.Sql).strings.join("?");
  }

  function rawValues(call: unknown[]): unknown[] {
    const [first, ...rest] = call as [TemplateStringsArray | Prisma.Sql, ...unknown[]];
    return Array.isArray(first) ? rest : [...(first as Prisma.Sql).values];
  }

  function rawSqls(): string[] {
    return h.queryRaw.mock.calls.map((call) => rawText(call));
  }

  it("Encerradas: DISTINCT ON contato+canal limitado à org do contexto", async () => {
    const page = await withOrg(ORG, () => getConversations({ tab: "finalizados" }));
    expect(page.items).toEqual([]);
    const sqls = rawSqls();
    const collapsed = sqls.find((s) => s.includes("DISTINCT ON"));
    expect(collapsed).toBeDefined();
    const call = h.queryRaw.mock.calls.find((c) => rawText(c).includes("DISTINCT ON"))!;
    // organizationId da org do contexto entra como parâmetro do SQL
    // (os fragmentos `Prisma.sql` aninhados carregam seus próprios `values`).
    expect(flattenSqlValues(rawValues(call))).toContain(ORG);
  });

  it("Resolvendo também colapsa; fila quente e união mista não", async () => {
    await withOrg(ORG, () => getConversations({ tab: "resolvidos" }));
    expect(rawSqls().some((s) => s.includes("DISTINCT ON"))).toBe(true);

    h.queryRaw.mockClear();
    await withOrg(ORG, () => getConversations({ tab: "entrada" }));
    expect(rawSqls().some((s) => s.includes("DISTINCT ON"))).toBe(false);

    h.queryRaw.mockClear();
    await withOrg(ORG, () => getConversations({ tab: ["finalizados", "entrada"] }));
    expect(rawSqls().some((s) => s.includes("DISTINCT ON"))).toBe(false);
  });

  it("com contactId não colapsa (todas as conversas do contato)", async () => {
    await withOrg(ORG, () => getConversations({ tab: "finalizados", contactId: "c1" }));
    expect(rawSqls().some((s) => s.includes("DISTINCT ON"))).toBe(false);
  });

  it("filtro ids: hidrata por id sem passar pela aba", async () => {
    h.conversation.findMany.mockResolvedValueOnce([]);
    await withOrg(ORG, () => getConversations({ ids: ["x"], tab: "finalizados" }));
    expect(h.queryRaw).not.toHaveBeenCalled();
    const call = h.conversation.findMany.mock.calls[0]![0] as { where: unknown };
    expect(treeContains(call.where, { id: { in: ["x"] } })).toBe(true);
  });
});

describe("updateConversationStatusInDb", () => {
  const CONV = {
    id: "conv-1",
    organizationId: ORG,
    status: "RESOLVED",
    contactId: "contact-1",
    contact: { id: "contact-1" },
    assignedToId: null,
    closedAt: new Date("2026-09-30T12:00:00Z"),
    followUpAt: null,
    externalId: null,
  };

  beforeEach(() => {
    h.conversation.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      ...CONV,
      ...args.data,
    }));
  });

  it("encerrar: closedAt, hasError=false, invalida badges da org e enfileira redistribuição", async () => {
    await withOrg(ORG, () => updateConversationStatusInDb("conv-1", "RESOLVED"));

    const data = h.conversation.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.status).toBe("RESOLVED");
    expect(data.closedAt).toBeInstanceOf(Date);
    expect(data.hasError).toBe(false);
    expect(data.followUpAt).toBeNull();
    expect(data).not.toHaveProperty("tabulationId");

    expect(h.scheduleTabCountsInvalidation).toHaveBeenCalledWith(ORG);
    await vi.waitFor(() => expect(h.scheduleDrain).toHaveBeenCalled());
    expect(h.scheduleDrain).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "capacity_released", userId: null }),
    );
  });

  it("encerrar com tabulação grava tabulationId", async () => {
    await withOrg(ORG, () =>
      updateConversationStatusInDb("conv-1", "RESOLVED", { tabulationId: "tab-1" }),
    );
    const data = h.conversation.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.tabulationId).toBe("tab-1");
  });

  it("Acompanhar (followUp): fica OPEN, sem closedAt, não devolve deal, publica conversation_updated com organizationId", async () => {
    await withOrg(ORG, () =>
      updateConversationStatusInDb("conv-1", "RESOLVED", { followUp: true, tabulationId: "tab-1" }),
    );
    const data = h.conversation.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("closedAt");
    expect(data.followUpAt).toBeInstanceOf(Date);
    expect(data.tabulationId).toBe("tab-1");
    expect(h.scheduleDrain).not.toHaveBeenCalled();
    expect(h.ssePublish).toHaveBeenCalledWith(
      "conversation_updated",
      expect.objectContaining({ organizationId: ORG, conversationId: "conv-1" }),
    );
  });

  it("reabrir: closedAt=null, tabulação limpa, badges invalidados, deal não é devolvido", async () => {
    await withOrg(ORG, () => updateConversationStatusInDb("conv-1", "OPEN"));
    const data = h.conversation.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ status: "OPEN", closedAt: null, tabulationId: null, followUpAt: null });
    expect(data).not.toHaveProperty("hasError");
    expect(h.scheduleTabCountsInvalidation).toHaveBeenCalledWith(ORG);
  });

  it("PENDING não invalida badges nem mexe em closedAt", async () => {
    await withOrg(ORG, () => updateConversationStatusInDb("conv-1", "PENDING"));
    const data = h.conversation.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toEqual({ status: "PENDING" });
    expect(h.scheduleTabCountsInvalidation).not.toHaveBeenCalled();
  });

  it("encerrar desvinculando atendente: registra ASSIGNEE_CHANGED, limpa deal/contato e libera capacidade do atendente", async () => {
    h.conversation.findUnique.mockResolvedValueOnce({
      assignedToId: "user-7",
      contactId: "contact-1",
      assignedTo: { name: "Ana", aiAgentConfig: null },
    });

    await withOrg(ORG, () =>
      updateConversationStatusInDb("conv-1", "RESOLVED", {
        clearAssignedTo: true,
        clearDepartment: true,
      }),
    );

    const data = h.conversation.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ assignedToId: null, departmentId: null });

    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ASSIGNEE_CHANGED",
        conversationId: "conv-1",
        oldValue: "Ana",
        newValue: null,
        meta: expect.objectContaining({ fromUserId: "user-7", reason: "conversation_closed" }),
      }),
    );
    expect(h.ssePublish).toHaveBeenCalledWith(
      "conversation_timeline_updated",
      expect.objectContaining({ organizationId: ORG, conversationId: "conv-1" }),
    );
    expect(h.clearContactOwnershipOnClose).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "contact-1", clearedUserId: "user-7" }),
    );
    await vi.waitFor(() => expect(h.scheduleDrain).toHaveBeenCalled());
    expect(h.scheduleDrain).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-7" }),
    );
  });

  it("Acompanhar não desvincula atendente mesmo com clearAssignedTo", async () => {
    await withOrg(ORG, () =>
      updateConversationStatusInDb("conv-1", "RESOLVED", { followUp: true, clearAssignedTo: true }),
    );
    const data = h.conversation.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("assignedToId");
  });

});
