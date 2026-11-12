/**
 * As rotas de sessão (`/api/campaigns/*`, `/api/painel/service`) não mudaram
 * com a chegada de `/api/integrations/*`:
 *   - continuam só com sessão (token válido sem cookie → 401);
 *   - continuam sem a trava de público;
 *   - o ciclo de vida responde igual nas rotas de integração (sessão de um
 *     lado, token do outro: mesmo status e corpo), então as duas superfícies
 *     não divergem em silêncio.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
vi.mock("@/lib/cache", async (importOriginal) =>
  (await import("./harness")).cacheModule(await importOriginal<typeof import("@/lib/cache")>()),
);
vi.mock("@/lib/metrics", () => ({ observeHttpRequest: vi.fn() }));
vi.mock("@/lib/org-rate-limit", () => ({ enforceOrgApiRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/rate-limit-reject-log", () => ({ logRateLimitReject: vi.fn() }));
vi.mock("@/lib/api-cost-limit", () => ({ enforceApiCostLimits: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/session-version-check", () => ({
  isSessionVersionCurrent: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/services/painel-service", () => ({
  getPainelService: vi.fn().mockResolvedValue({ agora: { ok: true } }),
  parseServiceSections: () => new Set(["agora"]),
}));

import { GET as oldGet } from "@/app/api/campaigns/[id]/route";
import { POST as oldCancel } from "@/app/api/campaigns/[id]/cancel/route";
import { POST as oldLaunch } from "@/app/api/campaigns/[id]/launch/route";
import { POST as oldPause } from "@/app/api/campaigns/[id]/pause/route";
import { GET as oldRecipients } from "@/app/api/campaigns/[id]/recipients/route";
import { POST as oldResume } from "@/app/api/campaigns/[id]/resume/route";
import { GET as oldStats } from "@/app/api/campaigns/[id]/stats/route";
import { POST as oldCreate } from "@/app/api/campaigns/route";
import { GET as oldPainelService } from "@/app/api/painel/service/route";

import { POST as newCancel } from "../campaigns/[id]/cancel/route";
import { POST as newLaunch } from "../campaigns/[id]/launch/route";
import { POST as newPause } from "../campaigns/[id]/pause/route";
import { POST as newResume } from "../campaigns/[id]/resume/route";
import {
  addCampaign,
  campaignRow,
  params,
  request,
  resetWorld,
  TOKEN_A,
  USER_A,
  world,
} from "./harness";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const DRAFT_BODY = { name: "Aviso", type: "TEMPLATE", channelId: "channel-a", templateName: "aviso" };

beforeEach(() => {
  resetWorld();
});

describe("rotas de sessão continuam só com sessão", () => {
  it("token Bearer válido, sem cookie → 401 em todas", async () => {
    const id = String(addCampaign().id);
    const auth = { token: TOKEN_A };
    const post = (body?: unknown) => request("/api/campaigns", { ...auth, method: "POST", body });
    const responses = await Promise.all([
      oldCreate(post(DRAFT_BODY)),
      oldGet(request("/x", auth), params(id)),
      oldLaunch(post(), params(id)),
      oldPause(post(), params(id)),
      oldResume(post(), params(id)),
      oldCancel(post(), params(id)),
      oldStats(request("/x", auth), params(id)),
      oldRecipients(request("/x", auth), params(id)),
      oldPainelService(request("/api/painel/service?section=agora", auth)),
    ]);
    for (const res of responses as Response[]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ message: "Não autorizado." });
    }
    expect(campaignRow(id)?.status).toBe("DRAFT");
    expect(world.db.table("campaign")).toHaveLength(1);
  });

  it("os arquivos das rotas de sessão não passam pelos módulos novos", () => {
    const files = [
      "campaigns/route.ts",
      "campaigns/[id]/route.ts",
      "campaigns/[id]/launch/route.ts",
      "campaigns/[id]/pause/route.ts",
      "campaigns/[id]/resume/route.ts",
      "campaigns/[id]/cancel/route.ts",
      "campaigns/[id]/stats/route.ts",
      "campaigns/[id]/recipients/route.ts",
      "painel/service/route.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), "src/app/api", file), "utf8");
      expect(source, file).toContain("withOrgContext(");
      expect(source, file).not.toMatch(/campaign-lifecycle|campaign-audience-guard|integrations-api|api-auth/);
    }
  });
});

describe("rotas de sessão continuam sem a trava de público", () => {
  beforeEach(() => {
    world.session = { user: USER_A };
  });

  it("criar com filtro vazio ou sem filtro → 201 (contrato antigo)", async () => {
    for (const filters of [{}, undefined, { contactIds: ["c1"] }]) {
      const res = (await oldCreate(
        request("/api/campaigns", { method: "POST", body: { ...DRAFT_BODY, filters } }),
      )) as Response;
      expect(res.status).toBe(201);
      expect((await res.json()).campaign).toMatchObject({ name: "Aviso", organizationId: "org-a" });
    }
  });

  it("lançar rascunho com `filters: {}` → 200 e enfileira (comportamento antigo)", async () => {
    const id = String(addCampaign({ filters: {} }).id);
    const res = (await oldLaunch(request("/x", { method: "POST" }), params(id))) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Campanha iniciada.", status: "PROCESSING" });
    expect(world.dispatched).toHaveLength(1);
  });

  it("painel de atendimentos responde só com login, sem permissão extra", async () => {
    world.permissions.set(USER_A.id, []);
    const res = (await oldPainelService(request("/api/painel/service?section=agora"))) as Response;
    expect(res.status).toBe(200);
  });
});

describe("ciclo de vida: rota de sessão e rota de integração respondem igual", () => {
  const STATUSES = ["DRAFT", "SCHEDULED", "PROCESSING", "SENDING", "PAUSED", "COMPLETED", "CANCELLED", "FAILED"];
  const ACTIONS: [string, Handler, Handler][] = [
    ["launch", oldLaunch as Handler, newLaunch],
    ["pause", oldPause as Handler, newPause],
    ["resume", oldResume as Handler, newResume],
    ["cancel", oldCancel as Handler, newCancel],
  ];
  // Rascunhos que o lançamento recusa por motivo que não é a trava de público.
  const BROKEN_DRAFTS: Record<string, unknown>[] = [
    { channelId: null },
    { channelId: "channel-off" },
    { segmentId: null, filters: null },
    { templateName: null },
    { type: "TEXT", textContent: null },
    { type: "AUTOMATION", automationId: null },
    { useLastConversationChannel: true, channelId: null },
    { scheduledAt: new Date("2999-01-01T12:00:00Z") },
  ];

  async function run(handler: Handler, overrides: Record<string, unknown>, queueUp = true) {
    resetWorld();
    world.session = { user: USER_A };
    world.queueUp = queueUp;
    world.db.insert("channel", {
      id: "channel-off",
      organizationId: "org-a",
      name: "Desconectado",
      status: "DISCONNECTED",
    });
    const id = String(addCampaign(overrides).id);
    world.db.insert("campaignRecipient", {
      id: "r1",
      organizationId: "org-a",
      campaignId: id,
      contactId: "ct1",
      status: "PENDING",
    });
    // A rota de sessão ignora o Authorization; a de integração ignora o cookie.
    const res = await handler(request("/x", { method: "POST", token: TOKEN_A }), params(id));
    return {
      http: res.status,
      body: await res.json(),
      campaign: campaignRow(id)?.status,
      recipient: world.db.table("campaignRecipient")[0]?.status,
      dispatched: world.dispatched.length,
    };
  }

  it.each(ACTIONS)("%s em todos os status", async (_name, oldHandler, newHandler) => {
    for (const status of STATUSES) {
      expect(await run(newHandler, { status }), status).toEqual(await run(oldHandler, { status }));
    }
  });

  it("launch: rascunhos incompletos, agendado e fila indisponível", async () => {
    for (const overrides of BROKEN_DRAFTS) {
      const label = JSON.stringify(overrides);
      expect(await run(newLaunch, overrides), label).toEqual(await run(oldLaunch as Handler, overrides));
    }
    expect(await run(newLaunch, {}, false)).toEqual(await run(oldLaunch as Handler, {}, false));
  });
});
