/**
 * GET /api/painel/portal-aluno: contrato da aba "Ao vivo" do portal.
 * O teste que mais importa é o de privacidade: nada do aluno sai na resposta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "u1", organizationId: "org1", role: "MANAGER", isSuperAdmin: false } as Record<string, unknown>,
  viaToken: true,
  linhas: [] as unknown[],
  telefones: [] as unknown[],
  coorte: [] as unknown[],
  falhaAgora: false,
  negado: false,
  rawCalls: 0,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@/lib/api-auth", () => ({
  authenticateApiRequest: async () => ({ ok: true, user: h.user, viaToken: h.viaToken }),
  runWithApiUserContext: (_u: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/authz/resource-policy", () => ({
  requirePermissionForUser: async () =>
    h.negado ? new Response(JSON.stringify({ message: "Sem permissão." }), { status: 403 }) : null,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    automation: {
      findMany: async () => [
        {
          id: "a1",
          name: "BV - Calouros",
          active: true,
          updatedAt: new Date("2026-11-03T14:17:00Z"),
          steps: [{ id: "oferta", type: "send_whatsapp_template" }],
        },
      ],
    },
    $queryRaw: async (q: { strings?: string[]; sql?: string }) => {
      h.rawCalls += 1;
      const texto = q.sql ?? (q.strings ?? []).join("?");
      if (texto.includes("BOOL_OR")) return h.coorte;
      return texto.includes("c.phone") ? h.telefones : h.linhas;
    },
  },
}));
vi.mock("@/services/painel-agora", () => ({
  getPainelAgora: async (clock: string) => {
    if (h.falhaAgora) throw new Error("banco fora");
    return {
      asOf: "2026-11-04T16:00:00Z",
      awaitingReply: 108,
      inService: 167,
      longestWait: {
        ms: clock === "business" ? 178_000_000 : 667_000_000,
        contactName: "Aluna Secreta",
        agentName: "Atendente X",
        conversationId: "conv_secreta",
        overSla: true,
        slaMinutes: 60,
      },
      agents: { online: 10, total: 22 },
    };
  },
}));
vi.mock("@/services/painel-service", () => ({
  getPainelServiceExceptions: async () => [
    { key: "no_reply", count: 75, href: "" },
    { key: "open_24h", count: 197, href: "" },
    { key: "unassigned", count: 139, href: "" },
    { key: "send_failure", count: 1, href: "" },
  ],
}));
vi.mock("@/services/painel-team", () => ({
  getPainelTeamRanking: async () => ({
    rows: [{ id: "u9", name: "Atendente Y", attended: 12, finished: 7, serviceMeanMs: 1, serviceMedianMs: 2, serviceSample: 3 }],
    capped: false,
  }),
}));

import { GET } from "./route";
import { chaveTelefone, embaralharTelefone } from "@/services/painel-portal-aluno";

const pedir = (qs: string, token = "eduit_abc") =>
  GET(new Request(`https://x.test/api/painel/portal-aluno?${qs}`, { headers: { authorization: `Bearer ${token}` } }));
const OK = "automacoes=a1&desde=2026-10-29&alcance=oferta";

beforeEach(() => {
  h.user = { id: "u1", organizationId: "org1", role: "MANAGER", isSuperAdmin: false };
  h.viaToken = true;
  h.falhaAgora = false;
  h.negado = false;
  h.rawCalls = 0;
  h.linhas = [
    { automationId: "a1", stepId: "oferta", status: "SUCCESS", dia: "2026-10-29", n: 30, ultimo: new Date("2026-10-29T20:00:00Z") },
    { automationId: "a1", stepId: "oferta", status: "FAILED", dia: "2026-11-04", n: 1, ultimo: new Date("2026-11-04T15:00:00Z") },
  ];
  h.coorte = [
    { stepId: "varA", phone: "5511912345678", em: new Date("2026-11-10T12:00:00Z"), ok: false },
    { stepId: "varA", phone: "1112345678", em: new Date("2026-11-10T11:00:00Z"), ok: true },
    { stepId: "varB", phone: "21987654321", em: new Date("2026-11-10T13:00:00Z"), ok: false },
    { stepId: "varB", phone: null, em: new Date("2026-11-10T13:00:00Z"), ok: true },
  ];
  h.telefones = [
    { stepId: "oferta", phone: "+55 (11) 91234-5678" },
    { stepId: "oferta", phone: "1112345678" }, // mesmo número, sem o nono dígito
    { stepId: "oferta", phone: null },
  ];
});

describe("GET /api/painel/portal-aluno", () => {
  it("recusa quem não é ADMIN nem MANAGER e sem org", async () => {
    h.user = { ...h.user, role: "MEMBER" };
    expect((await pedir(OK)).status).toBe(403);
    h.user = { ...h.user, role: "ADMIN", organizationId: null };
    expect((await pedir(OK)).status).toBe(403);
  });

  it("recusa quem não tem permissão de ver automações", async () => {
    h.negado = true;
    expect((await pedir(OK)).status).toBe(403);
    expect(h.rawCalls).toBe(0);
  });

  it("exige automações e data válida", async () => {
    expect((await pedir("desde=2026-10-29")).status).toBe(400);
    expect((await pedir("automacoes=a1&desde=2026-13-45")).status).toBe(400);
    expect((await pedir("automacoes=';drop&desde=2026-10-29")).status).toBe(400);
  });

  it("agrega por dia, passo e status", async () => {
    const j = await (await pedir(OK)).json();
    expect(j.automacoes.ok).toBe(true);
    const a = j.automacoes.data[0];
    expect(a.nome).toBe("BV - Calouros");
    expect(a.porDia).toEqual([
      { dia: "2026-10-29", passo: "oferta", status: "SUCCESS", n: 30 },
      { dia: "2026-11-04", passo: "oferta", status: "FAILED", n: 1 },
    ]);
    expect(a.ultimoRegistroEm).toBe("2026-11-04T15:00:00.000Z");
  });

  it("não devolve nada do aluno e leva as duas medidas de espera", async () => {
    const r = await pedir(OK);
    const texto = JSON.stringify(await r.json());
    ["Aluna Secreta", "conv_secreta", "91234", "12345678", "Atendente X", "serviceMean"].forEach((s) =>
      expect(texto).not.toContain(s),
    );
    const j = JSON.parse(texto);
    expect(j.atendimento.data.maiorEsperaComercialMs).toBe(178_000_000);
    expect(j.atendimento.data.maiorEsperaCorridaMs).toBe(667_000_000);
    expect(j.atendimento.data.semResponsavel).toBe(139);
    expect(j.atendentes.data.hoje[0]).toEqual({ id: "u9", nome: "Atendente Y", atendidas: 12, encerradas: 7 });
  });

  it("embaralha o telefone com o token e junta o nono dígito", async () => {
    const j = await (await pedir(OK, "eduit_abc")).json();
    const esperado = embaralharTelefone("eduit_abc", "11912345678");
    expect(j.alcance.data.oferta).toEqual([esperado]);
    expect(esperado).not.toEqual(embaralharTelefone("outro", "11912345678"));
  });

  it("coorte traz a primeira passagem, inclusive de quem falhou, sem o telefone", async () => {
    const r = await pedir(OK + "&coorte=varA,varB");
    const texto = JSON.stringify(await r.json());
    expect(texto).not.toContain("91234");
    expect(texto).not.toContain("98765");
    const j = JSON.parse(texto);
    expect(j.coorte.data.varA).toEqual([
      { k: embaralharTelefone("eduit_abc", "11912345678"), em: "2026-11-10T11:00:00.000Z", ok: true },
    ]);
    expect(j.coorte.data.varB).toEqual([
      { k: embaralharTelefone("eduit_abc", "21987654321"), em: "2026-11-10T13:00:00.000Z", ok: false },
    ]);
  });

  it("sessão de navegador não recebe alcance nem coorte", async () => {
    h.viaToken = false;
    const j = await (await pedir(OK + "&coorte=varA")).json();
    expect(j.alcance.data.oferta).toEqual([]);
    expect(j.coorte.data.varA).toEqual([]);
  });

  it("um bloco que falha não derruba os outros", async () => {
    h.falhaAgora = true;
    const r = await pedir(OK);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.atendimento.ok).toBe(false);
    expect(j.automacoes.ok).toBe(true);
    expect(JSON.stringify(j)).not.toContain("banco fora");
  });
});

describe("chaveTelefone", () => {
  it.each([
    ["5511912345678", "1112345678"],
    ["11912345678", "1112345678"],
    ["1112345678", "1112345678"],
    ["123", null],
    [null, null],
  ])("%s", (entrada, saida) => expect(chaveTelefone(entrada)).toBe(saida));
});
