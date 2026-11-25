/**
 * Rastreio (UTM/campanha/anúncio) no MCP contra Postgres LOCAL.
 *
 * Regras: só admin e gestor com `tracking:read`; operador nunca recebe nem
 * filtra, mesmo dono do negócio e com o escopo ligado; identificadores de
 * clique não saem; escopo desligado por padrão; isolamento entre orgs.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  hostnameFromConnectionUrl,
  isDigitalOceanManagedHost,
} from "@/lib/warn-public-do-managed-hosts";

function isSafeLocalPostgres(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  const host = hostnameFromConnectionUrl(url);
  if (!host || isDigitalOceanManagedHost(host)) return false;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const LOCAL = isSafeLocalPostgres(process.env.DATABASE_URL);
const sfx = randomBytes(4).toString("hex");
const BASE = "http://localhost:3001";
const BASE_SCOPES = ["leads:read", "conversations:read", "messages:read", "metrics:read", "team:read", "campaigns:read"];
const WITH_TRACKING = [...BASE_SCOPES, "tracking:read"];
const ids: Record<string, string> = {};

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };

async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const { POST } = await import("@/app/api/mcp/server/route");
  const res = await POST(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  expect(res.status).toBe(200);
  return (JSON.parse(await res.text()) as { result: ToolResult }).result;
}

async function connect(userId: string, orgId: string): Promise<string> {
  const oauth = await import("@/services/mcp/oauth");
  const c = await oauth.registerClient({ client_name: "Teste MCP Track", redirect_uris: ["https://ok.example/cb"] }, null);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const v = await oauth.validateAuthorizeRequest({
    response_type: "code", client_id: c.client_id, redirect_uri: "https://ok.example/cb",
    code_challenge: challenge, code_challenge_method: "S256",
  });
  if (!v.ok) throw new Error(v.error.description);
  const ap = await oauth.approveAuthorization({ id: userId, organizationId: orgId }, v.value, v.value.requestedScopes);
  const code = new URL(ap.redirectTo).searchParams.get("code")!;
  const t = await oauth.exchangeAuthorizationCode({
    client: (await oauth.findClient(c.client_id))!, code, codeVerifier: verifier,
    redirectUri: "https://ok.example/cb", resource: null,
  });
  return t.access_token;
}

async function setOrg(orgId: string, actor: string, scopes: string[], extra: Record<string, unknown> = {}) {
  const { updateMcpOrgConfig } = await import("@/services/mcp/settings");
  await updateMcpOrgConfig(orgId, actor, { enabled: true, allowedScopes: scopes as never, ...extra });
}

const TRACK_A = {
  adUtmSource: "Meta", adUtmMedium: "whatsapp_ads", adUtmCampaign: "vagas-sp", adUtmContent: "Vaga em Vila Prudente",
  referrer: "https://fb.me/abc", adHeadline: "Vaga em Vila Prudente e São Mateus", adSourceId: "120249741987620302",
  adResolvedId: "120249741987620302", adResolvedName: "Anúncio Vila Prudente", adResolvedCampaignId: "c-777",
  adResolvedCampaignName: "Campanha Vagas SP", adResolvedAdsetName: "Conjunto Zona Leste",
  // Identificadores de clique: NUNCA podem sair pelo MCP.
  adCtwaClid: "CTWA-SEGREDO-123", gclid: "GCLID-SEGREDO", fbclid: "FBCLID-SEGREDO", googleClientId: "GCID-SEGREDO",
};

describe.skipIf(!LOCAL)("MCP rastreio (Postgres local)", () => {
  beforeAll(async () => {
    const { prismaBase: db } = await import("@/lib/prisma-base");
    for (const k of ["A", "B"]) {
      ids[`org${k}`] = (await db.organization.create({ data: { name: `MCPT ${k} ${sfx}`, slug: `mcpt-${k.toLowerCase()}-${sfx}` }, select: { id: true } })).id;
    }
    const mk = async (key: string, org: string, role: "ADMIN" | "MANAGER" | "MEMBER") => {
      ids[key] = (await db.user.create({ data: { name: `U ${key}`, email: `mcpt-${key}-${sfx}@t.local`, role, organizationId: ids[org] }, select: { id: true } })).id;
    };
    await mk("adminA", "orgA", "ADMIN");
    await mk("managerA", "orgA", "MANAGER");
    await mk("memberA", "orgA", "MEMBER");
    await mk("adminB", "orgB", "ADMIN");
    const funnel = async (org: string, tag: string) => {
      const p = await db.pipeline.create({ data: { organizationId: ids[org], name: `F${tag}`, slug: `f${tag}-${sfx}`, isDefault: true }, select: { id: true } });
      return (await db.stage.create({ data: { organizationId: ids[org], pipelineId: p.id, name: "Novo", slug: `n${tag}-${sfx}`, number: 1, position: 0 }, select: { id: true } })).id;
    };
    const stA = await funnel("orgA", "a");
    const stB = await funnel("orgB", "b");
    const cA1 = await db.contact.create({ data: { organizationId: ids.orgA, number: 1, name: "Lead Meta", ...TRACK_A }, select: { id: true } });
    const cA2 = await db.contact.create({ data: { organizationId: ids.orgA, number: 2, name: "Lead Google", adUtmSource: "google", adUtmCampaign: "marca" }, select: { id: true } });
    const cB = await db.contact.create({ data: { organizationId: ids.orgB, number: 1, name: "Lead B", adUtmSource: "Meta", adUtmCampaign: "vagas-sp", adResolvedCampaignName: "Campanha Vagas SP", adResolvedId: "120249741987620302" }, select: { id: true } });
    const now = new Date();
    ids.dealMeta = (await db.deal.create({ data: { organizationId: ids.orgA, number: 1, title: "Negócio Meta (operador)", value: 500, status: "WON", closedAt: now, stageId: stA, contactId: cA1.id, ownerId: ids.memberA }, select: { id: true } })).id;
    await db.deal.create({ data: { organizationId: ids.orgA, number: 2, title: "Negócio Meta 2", value: 0, stageId: stA, contactId: cA1.id, ownerId: ids.adminA } });
    await db.deal.create({ data: { organizationId: ids.orgA, number: 3, title: "Negócio Google", value: 0, stageId: stA, contactId: cA2.id, ownerId: ids.adminA } });
    await db.deal.create({ data: { organizationId: ids.orgB, number: 1, title: "Negócio B Meta", value: 999, status: "WON", closedAt: now, stageId: stB, contactId: cB.id, ownerId: ids.adminB } });
  }, 90_000);

  afterAll(async () => {
    if (!ids.orgA) return;
    const { prismaBase: db } = await import("@/lib/prisma-base");
    const orgs = [ids.orgA, ids.orgB];
    for (const m of ["mcpAuditLog", "mcpToken", "mcpConnection", "deal", "contact", "stage", "pipeline", "auditLog", "organizationSetting"] as const) {
      await (db[m] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
    }
    await db.mcpOAuthClient.deleteMany({ where: { clientName: "Teste MCP Track" } });
    await db.user.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
  }, 60_000);

  it("escopo tracking:read vem desligado por padrão", async () => {
    const { parseMcpConfig } = await import("@/services/mcp/settings");
    expect(parseMcpConfig(null).allowedScopes).not.toContain("tracking:read");
  });

  it("escopo desligado na org: sem rastreio e filtros recusados, mesmo para admin", async () => {
    await setOrg(ids.orgA, ids.adminA, BASE_SCOPES);
    const t = await connect(ids.adminA, ids.orgA);
    const lead = await call(t, "get_lead", { id: ids.dealMeta });
    expect(lead.structuredContent!.tracking).toBeUndefined();
    const list = await call(t, "list_leads", {});
    expect((list.structuredContent!.items as Record<string, unknown>[])[0].tracking).toBeUndefined();
    expect((await call(t, "list_leads", { utmCampaign: "vagas-sp" })).isError).toBe(true);
    const sales = await call(t, "get_sales_metrics", {});
    expect(sales.structuredContent!.byCampaign).toBeUndefined();
  });

  it("admin com o escopo: UTMs, campanha e anúncio — sem identificadores de clique", async () => {
    await setOrg(ids.orgA, ids.adminA, WITH_TRACKING);
    const t = await connect(ids.adminA, ids.orgA);
    const lead = await call(t, "get_lead", { id: ids.dealMeta });
    const tr = lead.structuredContent!.tracking as Record<string, Record<string, string> | string | null>;
    expect(tr.utm).toMatchObject({ source: "Meta", medium: "whatsapp_ads", campaign: "vagas-sp" });
    expect(tr.meta).toMatchObject({ adId: "120249741987620302", campaignName: "Campanha Vagas SP", adName: "Anúncio Vila Prudente", adsetName: "Conjunto Zona Leste" });
    expect(tr.referrer).toBe("https://fb.me/abc");
    expect(JSON.stringify(lead)).not.toMatch(/SEGREDO/);
  });

  it("admin filtra leads por UTM e anúncio", async () => {
    const t = await connect(ids.adminA, ids.orgA);
    const titles = async (args: Record<string, unknown>) =>
      ((await call(t, "list_leads", args)).structuredContent!.items as { title: string }[]).map((d) => d.title).sort();
    expect(await titles({ utmCampaign: "VAGAS-SP" })).toEqual(["Negócio Meta (operador)", "Negócio Meta 2"]);
    expect(await titles({ utmSource: "google" })).toEqual(["Negócio Google"]);
    expect(await titles({ adId: "120249741987620302" })).toHaveLength(2);
    expect(await titles({ adCampaign: "Campanha Vagas SP" })).toHaveLength(2);
    expect(await titles({ utmCampaign: "nao-existe" })).toEqual([]);
  });

  it("resultados por campanha e anúncio (admin e gestor)", async () => {
    await setOrg(ids.orgA, ids.adminA, WITH_TRACKING, { allowAllUsers: true });
    for (const who of ["adminA", "managerA"]) {
      const t = await connect(ids[who], ids.orgA);
      const sales = await call(t, "get_sales_metrics", { period: "last_30" });
      const byCampaign = sales.structuredContent!.byCampaign as { name: string; deals: number; won: number; wonValue: number }[];
      expect(byCampaign.find((c) => c.name === "Campanha Vagas SP")).toMatchObject({ deals: 2, won: 1, wonValue: 500 });
      expect(byCampaign.find((c) => c.name === "marca")).toMatchObject({ deals: 1 });
      const byAd = sales.structuredContent!.byAd as { name: string; deals: number }[];
      expect(byAd.find((a) => a.name === "Anúncio Vila Prudente")?.deals).toBe(2);
    }
    await setOrg(ids.orgA, ids.adminA, WITH_TRACKING, { allowAllUsers: false });
  });

  it("operador NUNCA vê nem filtra rastreio — nem no próprio negócio, com o escopo ligado", async () => {
    await setOrg(ids.orgA, ids.adminA, WITH_TRACKING, { allowAllUsers: true });
    const t = await connect(ids.memberA, ids.orgA);
    const lead = await call(t, "get_lead", { id: ids.dealMeta });
    expect(lead.isError).toBeFalsy();
    expect(lead.structuredContent!.tracking).toBeUndefined();
    const list = await call(t, "list_leads", {});
    expect((list.structuredContent!.items as Record<string, unknown>[]).every((d) => d.tracking === undefined)).toBe(true);
    const f = await call(t, "list_leads", { utmCampaign: "vagas-sp" });
    expect(f.isError).toBe(true);
    expect((await call(t, "list_leads", { adId: "120249741987620302" })).isError).toBe(true);
    const sales = await call(t, "get_sales_metrics", {});
    expect(sales.structuredContent!.byCampaign).toBeUndefined();
    expect(JSON.stringify([lead, list, sales])).not.toMatch(/vagas-sp|Campanha Vagas SP|fb\.me|120249741987620302/);
    await setOrg(ids.orgA, ids.adminA, WITH_TRACKING, { allowAllUsers: false });
  });

  it("isolamento: campanhas e leads de outra org não entram", async () => {
    await setOrg(ids.orgB, ids.adminB, WITH_TRACKING);
    const tA = await connect(ids.adminA, ids.orgA);
    const salesA = await call(tA, "get_sales_metrics", { period: "last_30" });
    const camp = (salesA.structuredContent!.byCampaign as { name: string; wonValue: number }[]).find((c) => c.name === "Campanha Vagas SP")!;
    expect(camp.wonValue).toBe(500); // sem os 999 da org B
    const listA = await call(tA, "list_leads", { utmCampaign: "vagas-sp" });
    expect(JSON.stringify(listA)).not.toContain("Negócio B Meta");
    const tB = await connect(ids.adminB, ids.orgB);
    const listB = await call(tB, "list_leads", { utmCampaign: "vagas-sp" });
    expect((listB.structuredContent!.items as { title: string }[]).map((d) => d.title)).toEqual(["Negócio B Meta"]);
  });
});
