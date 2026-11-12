/**
 * Rotas `/api/integrations/*`: autenticação (Bearer e sessão), permissão,
 * isolamento por organização e trava de público.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", async () => (await import("./harness")).prismaModule);
vi.mock("@/lib/analytics", async () => (await import("./harness")).analyticsModule);
vi.mock("@/lib/auth", async () => (await import("./harness")).authModule);
vi.mock("@/services/api-tokens", async () => (await import("./harness")).apiTokensModule);
vi.mock("@/lib/queue", async () => (await import("./harness")).queueModule);
vi.mock("@/lib/api-access-audit", async () => (await import("./harness")).auditModule);
vi.mock("@/lib/rate-limit", async () => (await import("./harness")).rateLimitModule);
vi.mock("@/lib/authz", async (importOriginal) =>
  (await import("./harness")).authzModule(await importOriginal<typeof import("@/lib/authz")>()),
);
vi.mock("@/lib/metrics", () => ({ observeHttpRequest: vi.fn() }));
vi.mock("@/lib/org-rate-limit", () => ({ enforceOrgApiRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/rate-limit-reject-log", () => ({ logRateLimitReject: vi.fn() }));
vi.mock("@/lib/api-cost-limit", () => ({ enforceApiCostLimits: vi.fn().mockResolvedValue(null) }));
vi.mock("@/services/painel-hours", async () => {
  const { parseBusinessHours } = await import("@/services/painel-period");
  return {
    loadPainelSlaMinutes: async () => 15,
    loadPainelHours: async () => parseBusinessHours(null),
  };
});

import { POST as createCampaign } from "../campaigns/route";
import { GET as getCampaign } from "../campaigns/[id]/route";
import { POST as cancel } from "../campaigns/[id]/cancel/route";
import { POST as launch } from "../campaigns/[id]/launch/route";
import { POST as pause } from "../campaigns/[id]/pause/route";
import { GET as recipients } from "../campaigns/[id]/recipients/route";
import { POST as resume } from "../campaigns/[id]/resume/route";
import { GET as stats } from "../campaigns/[id]/stats/route";
import { GET as serviceQueue } from "../service-queue/route";
import {
  addCampaign,
  campaignRow,
  params,
  request,
  resetWorld,
  TOKEN_A,
  TOKEN_A_SEM_PERMISSAO,
  TOKEN_B,
  USER_A,
  USER_A_SEM_PERMISSAO,
  world,
} from "./harness";

type Auth = { token?: string };
type RouteCase = {
  name: string;
  permission: string;
  /** Status da campanha em que a chamada dá certo. */
  seedStatus?: string;
  okStatus: number;
  call: (auth: Auth, campaignId: string) => Promise<Response>;
};

const DRAFT_BODY = {
  name: "Aviso",
  type: "TEMPLATE",
  channelId: "channel-a",
  templateName: "aviso",
  templateComponents: [{ type: "body", parameters: [{ type: "text", text: "{{contact.name | first}}" }] }],
  sendRate: 5,
  filters: { tagIds: ["tag-1"] },
};

const base = "/api/integrations/campaigns";
const post = (path: string, auth: Auth, body?: unknown) =>
  request(path, { method: "POST", token: auth.token, body });

const ROUTES: RouteCase[] = [
  {
    name: "GET /service-queue",
    permission: "report:view",
    okStatus: 200,
    call: (a) => serviceQueue(request("/api/integrations/service-queue?clock=elapsed", a)),
  },
  {
    name: "POST /campaigns",
    permission: "campaign:create",
    okStatus: 201,
    call: (a) => createCampaign(post(base, a, DRAFT_BODY)),
  },
  {
    name: "GET /campaigns/{id}",
    permission: "campaign:view",
    okStatus: 200,
    call: (a, id) => getCampaign(request(`${base}/${id}`, a), params(id)),
  },
  {
    name: "POST /campaigns/{id}/launch",
    permission: "campaign:send",
    okStatus: 200,
    call: (a, id) => launch(post(`${base}/${id}/launch`, a), params(id)),
  },
  {
    name: "POST /campaigns/{id}/pause",
    permission: "campaign:send",
    seedStatus: "SENDING",
    okStatus: 200,
    call: (a, id) => pause(post(`${base}/${id}/pause`, a), params(id)),
  },
  {
    name: "POST /campaigns/{id}/resume",
    permission: "campaign:send",
    seedStatus: "PAUSED",
    okStatus: 200,
    call: (a, id) => resume(post(`${base}/${id}/resume`, a), params(id)),
  },
  {
    name: "POST /campaigns/{id}/cancel",
    permission: "campaign:cancel",
    seedStatus: "SENDING",
    okStatus: 200,
    call: (a, id) => cancel(post(`${base}/${id}/cancel`, a), params(id)),
  },
  {
    name: "GET /campaigns/{id}/stats",
    permission: "campaign:view",
    okStatus: 200,
    call: (a, id) => stats(request(`${base}/${id}/stats`, a), params(id)),
  },
  {
    name: "GET /campaigns/{id}/recipients",
    permission: "campaign:view",
    okStatus: 200,
    call: (a, id) => recipients(request(`${base}/${id}/recipients`, a), params(id)),
  },
];

const seed = (route: RouteCase) =>
  String(addCampaign({ status: route.seedStatus ?? "DRAFT" }).id);

beforeEach(() => {
  resetWorld();
});

describe.each(ROUTES)("$name", (route) => {
  it("401 sem credencial e com Bearer inválido", async () => {
    const id = seed(route);
    for (const auth of [{}, { token: "eduit_nao_existe" }]) {
      const res = await route.call(auth, id);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ message: "Não autorizado." });
    }
  });

  it("403 sem a permissão, com `required` no corpo (Bearer e sessão)", async () => {
    const id = seed(route);
    const viaToken = await route.call({ token: TOKEN_A_SEM_PERMISSAO }, id);
    expect(viaToken.status).toBe(403);
    expect(await viaToken.json()).toEqual({ message: "Acesso negado.", required: route.permission });

    world.session = { user: USER_A_SEM_PERMISSAO };
    const viaSession = await route.call({}, id);
    expect(viaSession.status).toBe(403);
    expect((await viaSession.json()).required).toBe(route.permission);
  });

  it("a permissão exata basta; outra do mesmo recurso não", async () => {
    world.permissions.set(USER_A_SEM_PERMISSAO.id, [route.permission]);
    const ok = await route.call({ token: TOKEN_A_SEM_PERMISSAO }, seed(route));
    expect(ok.status).toBe(route.okStatus);

    const other = route.permission === "campaign:view" ? "campaign:send" : "campaign:view";
    world.permissions.set(USER_A_SEM_PERMISSAO.id, [other]);
    const denied = await route.call({ token: TOKEN_A_SEM_PERMISSAO }, seed(route));
    expect(denied.status).toBe(403);
  });

  it("sucesso com Bearer", async () => {
    const res = await route.call({ token: TOKEN_A }, seed(route));
    expect(res.status).toBe(route.okStatus);
  });

  it("sucesso com sessão", async () => {
    world.session = { user: USER_A };
    const res = await route.call({}, seed(route));
    expect(res.status).toBe(route.okStatus);
  });
});

describe("isolamento por organização", () => {
  const byId = ROUTES.filter((r) => r.name.includes("{id}"));

  it.each(byId)("$name: token de outra organização recebe 404 e nada muda", async (route) => {
    const id = seed(route);
    const before = { ...campaignRow(id) };
    const res = await route.call({ token: TOKEN_B }, id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Campanha não encontrada." });
    expect(campaignRow(id)).toEqual(before);
    expect(world.dispatched).toEqual([]);
  });

  it("criação grava na organização do token e recusa canal ou segmento de outra", async () => {
    const created = await createCampaign(post(base, { token: TOKEN_B }, { ...DRAFT_BODY, channelId: "channel-b" }));
    expect(created.status).toBe(201);
    const { campaign } = await created.json();
    expect(campaign.organizationId).toBe("org-b");
    expect(campaign.createdById).toBe("user-b");

    const foreignChannel = await createCampaign(post(base, { token: TOKEN_B }, DRAFT_BODY));
    expect(foreignChannel.status).toBe(400);
    expect(await foreignChannel.json()).toEqual({ message: "Canal não encontrado." });

    const foreignSegment = await createCampaign(
      post(base, { token: TOKEN_B }, { ...DRAFT_BODY, channelId: "channel-b", filters: undefined, segmentId: "segment-a" }),
    );
    expect(foreignSegment.status).toBe(400);
    expect(await foreignSegment.json()).toEqual({ message: "Segmento não encontrado." });
    expect(world.db.table("campaign")).toHaveLength(1);
  });

  it("fila de atendimento conta só a organização do token", async () => {
    const conv = (id: string, organizationId: string, extra: Record<string, unknown> = {}) => ({
      id,
      organizationId,
      status: "OPEN",
      closedAt: null,
      hasError: false,
      lastMessageDirection: "in",
      lastInboundAt: new Date(Date.now() - 20 * 60_000),
      contactId: `ct-${organizationId}`,
      assignedToId: null,
      ...extra,
    });
    world.db.insert(
      "contact",
      { id: "ct-org-a", organizationId: "org-a", name: "Contato A" },
      { id: "ct-org-b", organizationId: "org-b", name: "Contato B" },
    );
    world.db.insert(
      "conversation",
      conv("c1", "org-a"),
      conv("c2", "org-a", { lastInboundAt: new Date(Date.now() - 60_000) }),
      conv("c3", "org-a", { lastMessageDirection: "out", assignedToId: "user-a" }),
      conv("c4", "org-a", { status: "RESOLVED" }),
      conv("c5", "org-b"),
    );
    world.db.insert("agentStatus", { id: "s1", organizationId: "org-a", userId: "user-a", status: "ONLINE" });

    const res = await serviceQueue(request("/api/integrations/service-queue?clock=elapsed", { token: TOKEN_A }));
    const body = await res.json();
    expect(body).toMatchObject({
      awaitingReply: 2,
      inService: 1,
      longestWait: { overSla: true, slaMinutes: 15 },
      agents: { online: 1, total: 2 },
    });
    expect(Object.keys(body).sort()).toEqual(["agents", "asOf", "awaitingReply", "inService", "longestWait"]);
    // Sem nome de contato/atendente nem id de conversa.
    expect(Object.keys(body.longestWait).sort()).toEqual(["ms", "overSla", "slaMinutes"]);
    expect(body.longestWait.ms).toBeGreaterThanOrEqual(20 * 60_000);

    const other = await serviceQueue(request("/api/integrations/service-queue", { token: TOKEN_B }));
    expect(await other.json()).toMatchObject({ awaitingReply: 1, inService: 0, agents: { online: 0, total: 1 } });
  });
});

describe("trava de público", () => {
  const SEM_RESTRICAO: [string, unknown][] = [
    ["ausente", undefined],
    ["null", null],
    ["objeto vazio", {}],
    ["só hasPhone", { hasPhone: true }],
    ["lista de etiquetas vazia", { tagIds: [] }],
    ["busca em branco", { search: "   " }],
  ];

  it.each(SEM_RESTRICAO)("criar recusa filtro %s", async (_label, filters) => {
    const res = await createCampaign(post(base, { token: TOKEN_A }, { ...DRAFT_BODY, filters }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("AUDIENCE_FILTERS_REQUIRED");
    expect(world.db.table("campaign")).toHaveLength(0);
  });

  it.each([
    ["só chave desconhecida", { contactIds: ["c1"] }],
    ["chave desconhecida junto de uma válida", { tagIds: ["tag-1"], stageId: "s1" }],
    ["tipo errado", { tagIds: "tag-1" }],
    ["data inválida", { createdAfter: "ontem" }],
    ["lista em vez de objeto", ["tag-1"]],
  ])("criar recusa filtro com %s", async (_label, filters) => {
    const res = await createCampaign(post(base, { token: TOKEN_A }, { ...DRAFT_BODY, filters }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("AUDIENCE_FILTERS_INVALID");
    expect(world.db.table("campaign")).toHaveLength(0);
  });

  it("criar aceita segmento sem filtros e grava o contrato completo", async () => {
    const res = await createCampaign(
      post(base, { token: TOKEN_A }, { ...DRAFT_BODY, filters: undefined, segmentId: "segment-a" }),
    );
    expect(res.status).toBe(201);
    const { campaign } = await res.json();
    expect(campaign).toMatchObject({
      status: "DRAFT",
      organizationId: "org-a",
      createdById: "user-a",
      segmentId: "segment-a",
      channelId: "channel-a",
      templateName: "aviso",
      templateComponents: DRAFT_BODY.templateComponents,
      sendRate: 5,
    });
  });

  it.each([
    ["{}", {}],
    ["só chaves desconhecidas", { contactIds: ["c1"] }],
    ["só hasPhone", { hasPhone: true }],
  ])("lançar recusa rascunho com filtro %s e não enfileira", async (_label, filters) => {
    const id = String(addCampaign({ filters }).id);
    const res = await launch(post(`${base}/${id}/launch`, { token: TOKEN_A }), params(id));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("AUDIENCE_FILTERS_REQUIRED");
    expect(campaignRow(id)?.status).toBe("DRAFT");
    expect(world.dispatched).toEqual([]);
  });

  it("lançar aceita segmento (sem filtros) e filtro com chave extra já gravada", async () => {
    for (const overrides of [
      { segmentId: "segment-a", filters: null },
      { filters: { tagIds: ["tag-1"], legado: true } },
    ]) {
      const id = String(addCampaign(overrides).id);
      const res = await launch(post(`${base}/${id}/launch`, { token: TOKEN_A }), params(id));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Campanha iniciada.", status: "PROCESSING" });
      expect(campaignRow(id)?.status).toBe("PROCESSING");
    }
    expect(world.dispatched).toHaveLength(2);
  });
});

describe("contrato das respostas", () => {
  it("corpo inválido na criação → 400 com a mensagem do campo", async () => {
    const cases: [unknown, string][] = [
      [{ ...DRAFT_BODY, name: " " }, "Nome é obrigatório."],
      [{ ...DRAFT_BODY, type: "SMS" }, "Tipo de campanha inválido."],
      [{ ...DRAFT_BODY, channelId: undefined }, "Canal é obrigatório."],
      [{ ...DRAFT_BODY, scheduledAt: "amanhã" }, "scheduledAt inválido. Use ISO-8601."],
      [[], "Corpo inválido."],
    ];
    for (const [body, message] of cases) {
      const res = await createCampaign(post(base, { token: TOKEN_A }, body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message });
    }
    const notJson = await createCampaign(
      new Request("https://integrations.test/api/integrations/campaigns", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN_A}` },
        body: "{",
      }),
    );
    expect(notJson.status).toBe(400);
  });

  it("GET da campanha não devolve a configuração (credenciais) do canal", async () => {
    const id = String(addCampaign().id);
    const res = await getCampaign(request(`${base}/${id}`, { token: TOKEN_A }), params(id));
    const text = await res.text();
    expect(text).not.toContain("segredo-do-canal");
    const { campaign } = JSON.parse(text);
    expect(campaign.channel).toEqual({
      id: "channel-a",
      name: "Canal a",
      provider: "META_CLOUD_API",
      type: "WHATSAPP",
    });
    expect(campaign).toMatchObject({ id, status: "DRAFT", audienceTags: [{ id: "tag-1", name: "tag-1" }] });
  });

  it("ciclo de vida: transição inválida → 409; fila fora → 503 e volta a rascunho", async () => {
    const draft = String(addCampaign().id);
    const done = String(addCampaign({ status: "COMPLETED" }).id);
    const conflicts: [Promise<Response>, string][] = [
      [launch(post("", { token: TOKEN_A }), params(done)), "Apenas campanhas em rascunho podem ser lançadas."],
      [pause(post("", { token: TOKEN_A }), params(draft)), "Apenas campanhas em envio podem ser pausadas."],
      [resume(post("", { token: TOKEN_A }), params(draft)), "Apenas campanhas pausadas podem ser retomadas."],
      [cancel(post("", { token: TOKEN_A }), params(done)), "Esta campanha não pode ser cancelada."],
    ];
    for (const [pending, message] of conflicts) {
      const res = await pending;
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ message });
    }

    world.queueUp = false;
    const res = await launch(post("", { token: TOKEN_A }), params(draft));
    expect(res.status).toBe(503);
    expect(campaignRow(draft)?.status).toBe("DRAFT");
  });

  it("cancelar marca os pendentes como falha; stats e recipients filtram por status e código", async () => {
    const id = String(addCampaign({ status: "SENDING", totalRecipients: 4, sentCount: 1, failedCount: 2 }).id);
    world.db.insert(
      "contact",
      { id: "ct1", organizationId: "org-a", name: "Ana", phone: "5511999990001" },
      { id: "ct2", organizationId: "org-a", name: "Bia", phone: "5511999990002" },
    );
    const rec = (n: number, status: string, errorMessage: string | null, contactId = "ct1") => ({
      id: `r${n}`,
      organizationId: "org-a",
      campaignId: id,
      contactId,
      status,
      errorMessage,
      sentAt: null,
      createdAt: new Date(2026, 0, n),
    });
    world.db.insert(
      "campaignRecipient",
      rec(1, "SENT", null),
      rec(2, "FAILED", "Número sem WhatsApp (code 131026)", "ct2"),
      rec(3, "FAILED", "Falha de rede"),
      rec(4, "PENDING", null),
    );

    const list = async (query: string) => {
      const res = await recipients(request(`${base}/${id}/recipients${query}`, { token: TOKEN_A }), params(id));
      return { status: res.status, body: await res.json() };
    };
    const failed = await list("?status=FAILED");
    expect(failed.body.total).toBe(2);
    const byCode = await list("?status=FAILED&errorCode=131026");
    expect(byCode.body.items).toEqual([
      expect.objectContaining({
        id: "r2",
        contactId: "ct2",
        contact: { id: "ct2", name: "Bia", phone: "5511999990002" },
        status: "FAILED",
        errorCode: 131026,
      }),
    ]);
    expect(byCode.body.items[0]).not.toHaveProperty("organizationId");
    expect((await list("?errorCode=other&status=FAILED")).body.items.map((r: { id: string }) => r.id)).toEqual(["r3"]);
    expect((await list("?perPage=1&page=2")).body).toMatchObject({ total: 4, page: 2, perPage: 1, totalPages: 4 });
    expect((await list("?status=ENVIADO")).status).toBe(400);
    expect((await list("?errorCode=abc")).status).toBe(400);

    const statsRes = await stats(request(`${base}/${id}/stats`, { token: TOKEN_A }), params(id));
    expect(await statsRes.json()).toMatchObject({
      status: "SENDING",
      totalRecipients: 4,
      sentCount: 1,
      failedCount: 2,
      pendingCount: 1,
      failureReasons: expect.arrayContaining([expect.objectContaining({ code: 131026, count: 1 })]),
    });

    const cancelled = await cancel(post("", { token: TOKEN_A }), params(id));
    expect(await cancelled.json()).toEqual({ message: "Campanha cancelada.", status: "CANCELLED" });
    expect(campaignRow(id)?.status).toBe("CANCELLED");
    expect(world.db.table("campaignRecipient").find((r) => r.id === "r4")).toMatchObject({
      status: "FAILED",
      errorMessage: "Campanha cancelada.",
    });
  });
});
