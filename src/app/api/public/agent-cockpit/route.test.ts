/**
 * GET /api/public/agent-cockpit e /cases — o cockpit nativo do CRM (página
 * Agentes de IA) chama estas rotas same-origin com o cookie de sessão. A
 * organização vem da sessão e vale o teto por sessão.
 *
 * O cockpit monitor externo (cabeçalho `X-Cockpit-Access` + org fixa em env)
 * foi removido: o cabeçalho não autentica nem troca a organização, mesmo com
 * as envs antigas ainda definidas no ambiente.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  validateToken: vi.fn(),
  getCockpitData: vi.fn(),
  getAcademicCockpitCases: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/services/api-tokens", () => ({ validateToken: mocks.validateToken }));
vi.mock("@/services/distribution/cockpit", () => ({
  getCockpitData: mocks.getCockpitData,
}));
vi.mock("@/services/ai/cockpit-academic-cases", () => ({
  getAcademicCockpitCases: mocks.getAcademicCockpitCases,
}));
vi.mock("@/lib/api-access-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-access-audit")>();
  return {
    ...actual,
    logApiAccessAuthReject: vi.fn(),
    logApiAccessCompleted: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { GET } from "@/app/api/public/agent-cockpit/route";
import { GET as GET_CASES } from "@/app/api/public/agent-cockpit/cases/route";
import { resetOrgRpmMemoryForTests } from "@/lib/org-rate-limit";
import { resetRateLimitersForTests } from "@/lib/rate-limit";
import { resetRateLimitRejectLogForTests } from "@/lib/rate-limit-reject-log";
import { getOrgIdOrThrow } from "@/lib/request-context";

const SESSION_ORG = "org_sessao";
const ENV_ORG = "org_env_antiga";
const LEGACY_SECRET = "segredo-de-teste-do-cockpit-externo";

function session(orgId = SESSION_ORG, userId = "user_1") {
  return {
    user: { id: userId, name: "Fulano", email: "f@acme.test", organizationId: orgId },
  };
}

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.test${path}`, { headers });
}

const ENV_KEYS = [
  "COCKPIT_ACCESS_SECRET",
  "COCKPIT_ORGANIZATION_ID",
  "COCKPIT_ALLOWED_ORIGINS",
  "SESSION_RATE_LIMIT_RPM",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Envs do cockpit externo ainda presentes (ex.: antes de apagar no
  // EasyPanel) não podem reabrir o caminho.
  process.env.COCKPIT_ACCESS_SECRET = LEGACY_SECRET;
  process.env.COCKPIT_ORGANIZATION_ID = ENV_ORG;
  process.env.COCKPIT_ALLOWED_ORIGINS = "https://cockpit-externo.example";
  delete process.env.SESSION_RATE_LIMIT_RPM;
  resetRateLimitersForTests();
  resetRateLimitRejectLogForTests({ emit: () => {} });
  resetOrgRpmMemoryForTests();

  mocks.validateToken.mockResolvedValue(null);
  mocks.getCockpitData.mockImplementation(async () => ({ orgId: getOrgIdOrThrow() }));
  mocks.getAcademicCockpitCases.mockImplementation(
    async (args: { organizationId: string; key: string; page: number }) => ({
      cases: [],
      page: args.page,
      pageSize: 50,
      total: 0,
      orgId: args.organizationId,
    }),
  );
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetRateLimitRejectLogForTests();
  resetRateLimitersForTests();
});

describe("GET /api/public/agent-cockpit — cockpit nativo (sessão)", () => {
  it("responde com as métricas da organização da sessão, sem cache", async () => {
    mocks.auth.mockResolvedValue(session());

    const res = await GET(req("/api/public/agent-cockpit"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ orgId: SESSION_ORG });
  });

  it("sem sessão responde 401 e não monta métricas", async () => {
    mocks.auth.mockResolvedValue(null);

    const res = await GET(req("/api/public/agent-cockpit"));

    expect(res.status).toBe(401);
    expect(mocks.getCockpitData).not.toHaveBeenCalled();
  });

  it("aplica o teto por sessão (429 ao estourar)", async () => {
    process.env.SESSION_RATE_LIMIT_RPM = "1";
    resetRateLimitersForTests();
    mocks.auth.mockResolvedValue(session(SESSION_ORG, "user_rl"));

    const first = await GET(req("/api/public/agent-cockpit"));
    const second = await GET(req("/api/public/agent-cockpit"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(mocks.getCockpitData).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/public/agent-cockpit — X-Cockpit-Access não dá mais acesso", () => {
  it("cabeçalho com o segredo antigo, sem sessão: 401", async () => {
    mocks.auth.mockResolvedValue(null);

    const res = await GET(
      req("/api/public/agent-cockpit", { "X-Cockpit-Access": LEGACY_SECRET }),
    );

    expect(res.status).toBe(401);
    expect(mocks.getCockpitData).not.toHaveBeenCalled();
  });

  it("cabeçalho com sessão não troca a organização pela da env", async () => {
    mocks.auth.mockResolvedValue(session());

    const res = await GET(
      req("/api/public/agent-cockpit", { "X-Cockpit-Access": LEGACY_SECRET }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ orgId: SESSION_ORG });
  });

  it("não devolve CORS para a origem do cockpit externo", async () => {
    mocks.auth.mockResolvedValue(session());

    const res = await GET(
      req("/api/public/agent-cockpit", { Origin: "https://cockpit-externo.example" }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("GET /api/public/agent-cockpit/cases", () => {
  it("sessão: consulta os casos da organização da sessão", async () => {
    mocks.auth.mockResolvedValue(session());

    const res = await GET_CASES(
      req("/api/public/agent-cockpit/cases?key=handoff&page=2"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.getAcademicCockpitCases).toHaveBeenCalledWith({
      organizationId: SESSION_ORG,
      key: "handoff",
      page: 2,
    });
  });

  it("X-Cockpit-Access sem sessão: 401", async () => {
    mocks.auth.mockResolvedValue(null);

    const res = await GET_CASES(
      req("/api/public/agent-cockpit/cases?key=handoff", {
        "X-Cockpit-Access": LEGACY_SECRET,
      }),
    );

    expect(res.status).toBe(401);
    expect(mocks.getAcademicCockpitCases).not.toHaveBeenCalled();
  });
});
