/**
 * Integração MCP contra Postgres LOCAL (mesma regra de
 * `tenant-isolation.integration.test.ts`: DATABASE_URL remota → skip).
 *
 * Cobre, com dados controlados em duas organizações:
 *   - OAuth: DCR, PKCE (verifier errado, reuso de código), refresh com
 *     rotação e detecção de reuso, revogação RFC 7009;
 *   - endpoint `/mcp` real (route handler + transporte Streamable HTTP):
 *     initialize, tools/list e as 8 ferramentas;
 *   - escopos da conexão e escopos liberados pela org;
 *   - RBAC/visibilidade (MEMBER só vê os próprios negócios; equipe só gestor);
 *   - isolamento entre organizações; token `eduit_` recusado;
 *   - revogação de conexão e desligamento do MCP com efeito imediato.
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

type Ids = {
  orgA: string;
  orgB: string;
  adminA: string;
  memberA: string;
  adminB: string;
  pipelineA: string;
  pipelineB: string;
  dealAdmin: string;
  dealMember: string;
  dealB: string;
  dealBNumber: number;
  convA: string;
  convB: string;
  campaignA: string;
  campaignB: string;
};
const ids = {} as Ids;

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}, id = 1) {
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
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  const result = r.body.result as { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  return result;
}

async function tokenRequest(form: Record<string, string>) {
  const { POST } = await import("@/app/api/mcp/oauth/token/route");
  const res = await POST(
    new Request(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** DCR → authorize (validação) → consentimento → troca do código. */
async function connect(userId: string, orgId: string, scopes: string[] | null = null) {
  const { POST: register } = await import("@/app/api/mcp/oauth/register/route");
  const reg = await register(
    new Request(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Teste MCP", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] }),
    }),
  );
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkcePair();
  const oauth = await import("@/services/mcp/oauth");
  const v = await oauth.validateAuthorizeRequest({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: scopes ? scopes.join(" ") : null,
    state: "xyz",
    resource: `${BASE}/mcp`,
  });
  if (!v.ok) throw new Error(v.error.description);
  const approved = await oauth.approveAuthorization(
    { id: userId, organizationId: orgId },
    v.value,
    v.value.requestedScopes,
  );
  const redirect = new URL(approved.redirectTo);
  expect(redirect.searchParams.get("state")).toBe("xyz");
  const code = redirect.searchParams.get("code")!;
  const tok = await tokenRequest({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    resource: `${BASE}/mcp`,
  });
  expect(tok.status).toBe(200);
  return {
    clientId: client.client_id,
    code,
    verifier,
    access: tok.body.access_token,
    refresh: tok.body.refresh_token,
    connectionId: approved.connectionId,
  };
}

describe.skipIf(!LOCAL)("MCP integration (Postgres local)", () => {
  beforeAll(async () => {
    process.env.MCP_PUBLIC_URL = BASE;
    const { prismaBase } = await import("@/lib/prisma-base");
    const mkOrg = (n: string) =>
      prismaBase.organization.create({ data: { name: `MCP ${n} ${sfx}`, slug: `mcp-${n}-${sfx}` }, select: { id: true } });
    const [oa, ob] = await Promise.all([mkOrg("a"), mkOrg("b")]);
    ids.orgA = oa.id;
    ids.orgB = ob.id;
    const mkUser = (org: string, n: string, role: "ADMIN" | "MEMBER") =>
      prismaBase.user.create({
        data: { name: `U ${n}`, email: `mcp-${n}-${sfx}@test.local`, role, organizationId: org },
        select: { id: true },
      });
    ids.adminA = (await mkUser(ids.orgA, "adminA", "ADMIN")).id;
    ids.memberA = (await mkUser(ids.orgA, "memberA", "MEMBER")).id;
    ids.adminB = (await mkUser(ids.orgB, "adminB", "ADMIN")).id;

    const mkFunnel = async (org: string, tag: string) => {
      const p = await prismaBase.pipeline.create({
        data: { organizationId: org, name: `Funil ${tag}`, slug: `funil-${tag}-${sfx}`, isDefault: true },
        select: { id: true },
      });
      const s1 = await prismaBase.stage.create({
        data: { organizationId: org, pipelineId: p.id, name: "Novo", slug: `novo-${tag}-${sfx}`, number: 1, position: 0 },
        select: { id: true },
      });
      const s2 = await prismaBase.stage.create({
        data: { organizationId: org, pipelineId: p.id, name: "Proposta", slug: `prop-${tag}-${sfx}`, number: 2, position: 1 },
        select: { id: true },
      });
      return { pipeline: p.id, s1: s1.id, s2: s2.id };
    };
    const fa = await mkFunnel(ids.orgA, "a");
    const fb = await mkFunnel(ids.orgB, "b");
    ids.pipelineA = fa.pipeline;
    ids.pipelineB = fb.pipeline;

    const contactA = await prismaBase.contact.create({
      data: { organizationId: ids.orgA, number: 1, name: "Maria Cliente", phone: "5511999998888", email: "maria@cliente.com" },
      select: { id: true },
    });
    const contactA2 = await prismaBase.contact.create({
      data: { organizationId: ids.orgA, number: 2, name: "João Lead", phone: "5511988887777" },
      select: { id: true },
    });
    const contactB = await prismaBase.contact.create({
      data: { organizationId: ids.orgB, number: 1, name: "Segredo Org B", phone: "5521977776666" },
      select: { id: true },
    });
    ids.dealAdmin = (
      await prismaBase.deal.create({
        data: { organizationId: ids.orgA, number: 1, title: "Negócio do Admin", value: 1500, stageId: fa.s2, contactId: contactA.id, ownerId: ids.adminA },
        select: { id: true },
      })
    ).id;
    ids.dealMember = (
      await prismaBase.deal.create({
        data: { organizationId: ids.orgA, number: 2, title: "Negócio do Membro", value: 800, stageId: fa.s1, contactId: contactA2.id, ownerId: ids.memberA },
        select: { id: true },
      })
    ).id;
    await prismaBase.deal.create({
      data: { organizationId: ids.orgA, number: 3, title: "Negócio Ganho", value: 3000, status: "WON", stageId: fa.s2, contactId: contactA.id, ownerId: ids.adminA, closedAt: new Date() },
    });
    const dB = await prismaBase.deal.create({
      data: { organizationId: ids.orgB, number: 7, title: "Negócio Secreto B", value: 99999, stageId: fb.s1, contactId: contactB.id, ownerId: ids.adminB },
      select: { id: true, number: true },
    });
    ids.dealB = dB.id;
    ids.dealBNumber = dB.number;

    const convA = await prismaBase.conversation.create({
      data: { organizationId: ids.orgA, channel: "whatsapp", contactId: contactA.id, assignedToId: ids.adminA, status: "OPEN", number: 1, lastMessageAt: new Date() },
      select: { id: true },
    });
    ids.convA = convA.id;
    await prismaBase.message.createMany({
      data: [
        { organizationId: ids.orgA, conversationId: convA.id, content: "Olá, quero um orçamento", direction: "in", createdAt: new Date(Date.now() - 60_000) },
        { organizationId: ids.orgA, conversationId: convA.id, content: "Claro! Envio hoje.", direction: "out", createdAt: new Date(Date.now() - 30_000) },
        { organizationId: ids.orgA, conversationId: convA.id, content: "NOTA INTERNA SIGILOSA", direction: "out", isPrivate: true },
      ],
    });
    const convB = await prismaBase.conversation.create({
      data: { organizationId: ids.orgB, channel: "whatsapp", contactId: contactB.id, assignedToId: ids.adminB, status: "OPEN", number: 1 },
      select: { id: true },
    });
    ids.convB = convB.id;
    await prismaBase.message.create({
      data: { organizationId: ids.orgB, conversationId: convB.id, content: "mensagem da org B", direction: "in" },
    });
    ids.campaignA = (
      await prismaBase.campaign.create({
        data: { organizationId: ids.orgA, name: "Black Friday", type: "TEXT", createdById: ids.adminA, totalRecipients: 100, sentCount: 90, deliveredCount: 80, readCount: 50, repliedCount: 10, failedCount: 10 },
        select: { id: true },
      })
    ).id;
    ids.campaignB = (
      await prismaBase.campaign.create({
        data: { organizationId: ids.orgB, name: "Campanha B", type: "TEXT", createdById: ids.adminB },
        select: { id: true },
      })
    ).id;

    const { updateMcpOrgConfig } = await import("@/services/mcp/settings");
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { enabled: true });
    await updateMcpOrgConfig(ids.orgB, ids.adminB, { enabled: true });
  }, 60_000);

  afterAll(async () => {
    if (!ids.orgA) return;
    const { prismaBase } = await import("@/lib/prisma-base");
    const orgs = [ids.orgA, ids.orgB];
    await prismaBase.mcpAuditLog.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.mcpToken.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.mcpConnection.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.mcpOAuthClient.deleteMany({ where: { clientName: "Teste MCP" } });
    await prismaBase.message.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.conversation.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.campaign.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.activityEvent.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.deal.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.contact.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.stage.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.pipeline.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.auditLog.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.organizationSetting.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.user.deleteMany({ where: { organizationId: { in: orgs } } });
    await prismaBase.organization.deleteMany({ where: { id: { in: orgs } } });
  }, 60_000);

  // ── Descoberta ────────────────────────────────────────────────────────
  it("publica metadados OAuth (RFC 9728 / 8414)", async () => {
    const pr = await import("@/app/api/mcp/well-known/protected-resource/route");
    const as = await import("@/app/api/mcp/well-known/authorization-server/route");
    const prm = await (await pr.GET(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`))).json();
    expect(prm.resource).toBe(`${BASE}/mcp`);
    expect(prm.authorization_servers).toEqual([BASE]);
    const asm = await (await as.GET(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json();
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asm.registration_endpoint).toBe(`${BASE}/oauth/register`);
  });

  it("/mcp sem token → 401 com WWW-Authenticate apontando o resource metadata", async () => {
    const { POST } = await import("@/app/api/mcp/server/route");
    const res = await POST(new Request(`${BASE}/mcp`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("token de API `eduit_` (admin) NÃO autoriza o /mcp", async () => {
    const { generateToken } = await import("@/services/api-tokens");
    const { token } = await generateToken(ids.adminA, ids.orgA, `mcp-test-${sfx}`);
    const r = await rpc(token, "tools/list");
    expect(r.status).toBe(401);
    const { prismaBase } = await import("@/lib/prisma-base");
    await prismaBase.apiToken.deleteMany({ where: { name: `mcp-test-${sfx}` } });
  });

  // ── OAuth ─────────────────────────────────────────────────────────────
  it("DCR recusa redirect_uri perigosa e http fora de loopback", async () => {
    const { validateRedirectUri } = await import("@/services/mcp/oauth");
    expect(validateRedirectUri("javascript:alert(1)")).toBe(false);
    expect(validateRedirectUri("http://evil.com/cb")).toBe(false);
    expect(validateRedirectUri("https://chatgpt.com/cb")).toBe(true);
    expect(validateRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(validateRedirectUri("cursor://anysphere.cursor-retrieval/oauth/cb")).toBe(true);
  });

  it("authorize exige PKCE S256 e redirect registrado", async () => {
    const oauth = await import("@/services/mcp/oauth");
    const c = await oauth.registerClient({ client_name: "Teste MCP", redirect_uris: ["https://ok.example/cb"] }, null);
    const noPkce = await oauth.validateAuthorizeRequest({ response_type: "code", client_id: c.client_id, redirect_uri: "https://ok.example/cb" });
    expect(noPkce.ok).toBe(false);
    const plain = await oauth.validateAuthorizeRequest({
      response_type: "code", client_id: c.client_id, redirect_uri: "https://ok.example/cb",
      code_challenge: pkcePair().challenge, code_challenge_method: "plain",
    });
    expect(plain.ok).toBe(false);
    const badRedirect = await oauth.validateAuthorizeRequest({
      response_type: "code", client_id: c.client_id, redirect_uri: "https://attacker.example/cb",
      code_challenge: pkcePair().challenge, code_challenge_method: "S256",
    });
    expect(badRedirect.ok).toBe(false);
    if (!badRedirect.ok) expect(badRedirect.redirectable).toBe(false);
  });

  it("troca de código: verifier errado falha; código é de uso único", async () => {
    const conn = await connect(ids.adminA, ids.orgA);
    const reuse = await tokenRequest({
      grant_type: "authorization_code",
      client_id: conn.clientId,
      code: conn.code,
      code_verifier: conn.verifier,
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
    // Reuso do código revoga os tokens emitidos a partir dele.
    const r = await rpc(conn.access, "tools/list");
    expect(r.status).toBe(401);

    const oauth = await import("@/services/mcp/oauth");
    const v = await oauth.validateAuthorizeRequest({
      response_type: "code", client_id: conn.clientId,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      code_challenge: pkcePair().challenge, code_challenge_method: "S256",
    });
    if (!v.ok) throw new Error("validate");
    const ap = await oauth.approveAuthorization({ id: ids.adminA, organizationId: ids.orgA }, v.value, v.value.requestedScopes);
    const code = new URL(ap.redirectTo).searchParams.get("code")!;
    const noRedirect = await tokenRequest({ grant_type: "authorization_code", client_id: conn.clientId, code, code_verifier: pkcePair().verifier });
    expect(noRedirect.body.error).toBe("invalid_grant");
    const v2 = await oauth.validateAuthorizeRequest({
      response_type: "code", client_id: conn.clientId,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      code_challenge: pkcePair().challenge, code_challenge_method: "S256",
    });
    if (!v2.ok) throw new Error("validate");
    const ap2 = await oauth.approveAuthorization({ id: ids.adminA, organizationId: ids.orgA }, v2.value, v2.value.requestedScopes);
    const code2 = new URL(ap2.redirectTo).searchParams.get("code")!;
    const wrong = await tokenRequest({
      grant_type: "authorization_code", client_id: conn.clientId, code: code2,
      code_verifier: pkcePair().verifier, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    });
    expect(wrong.body.error).toBe("invalid_grant");
    expect(wrong.body.error_description).toContain("code_verifier");
  });

  it("refresh rotaciona; reuso do refresh antigo derruba a família", async () => {
    const conn = await connect(ids.adminA, ids.orgA);
    const r1 = await tokenRequest({ grant_type: "refresh_token", client_id: conn.clientId, refresh_token: conn.refresh });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(conn.refresh);
    expect((await rpc(r1.body.access_token, "tools/list")).status).toBe(200);
    // Força o reuso fora da janela de retry.
    const { prismaBase } = await import("@/lib/prisma-base");
    const { hashSecret } = await import("@/services/mcp/oauth");
    await prismaBase.mcpToken.update({
      where: { tokenHash: hashSecret(conn.refresh) },
      data: { usedAt: new Date(Date.now() - 120_000) },
    });
    const reuse = await tokenRequest({ grant_type: "refresh_token", client_id: conn.clientId, refresh_token: conn.refresh });
    expect(reuse.body.error).toBe("invalid_grant");
    expect((await rpc(r1.body.access_token, "tools/list")).status).toBe(401);
  });

  // ── Ferramentas (dados controlados) ───────────────────────────────────
  it("initialize + tools/list expõem as 8 ferramentas somente leitura", async () => {
    const conn = await connect(ids.adminA, ids.orgA);
    const init = await rpc(conn.access, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("bwipo-crm");
    const list = await rpc(conn.access, "tools/list");
    const names = (list.body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[]);
    expect(names.map((t) => t.name).sort()).toEqual([
      "get_campaign_results", "get_conversation_messages", "get_lead", "get_pipeline_metrics",
      "get_sales_metrics", "get_team_performance", "list_conversations", "list_leads",
    ]);
    expect(names.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("as 8 ferramentas respondem com dados reais da org A (admin)", async () => {
    const { access } = await connect(ids.adminA, ids.orgA);

    const leads = await callTool(access, "list_leads", {});
    expect(leads.isError).toBeFalsy();
    const items = leads.structuredContent!.items as { title: string; contact: { phone: string } }[];
    expect(items.map((d) => d.title).sort()).toEqual(["Negócio Ganho", "Negócio do Admin", "Negócio do Membro"]);
    // Telefone mascarado por padrão.
    expect(items.every((d) => !d.contact.phone.includes("99999"))).toBe(true);

    const filtered = await callTool(access, "list_leads", { status: "WON" });
    expect((filtered.structuredContent!.items as unknown[]).length).toBe(1);

    const lead = await callTool(access, "get_lead", { id: "1" });
    expect(lead.isError).toBeFalsy();
    expect(lead.structuredContent!.title).toBe("Negócio do Admin");
    expect(lead.structuredContent!.stage).toMatchObject({ name: "Proposta" });

    const convs = await callTool(access, "list_conversations", {});
    expect(convs.isError).toBeFalsy();
    expect((convs.structuredContent!.items as { id: string }[]).map((c) => c.id)).toEqual([ids.convA]);

    const msgs = await callTool(access, "get_conversation_messages", { conversationId: ids.convA });
    expect(msgs.isError).toBeFalsy();
    const texts = (msgs.structuredContent!.messages as { text: string }[]).map((m) => m.text);
    expect(texts).toEqual(["Olá, quero um orçamento", "Claro! Envio hoje."]);
    expect(JSON.stringify(msgs)).not.toContain("SIGILOSA");

    const sales = await callTool(access, "get_sales_metrics", { period: "last_30" });
    expect(sales.isError).toBeFalsy();
    expect(sales.structuredContent!.summary).toBeTruthy();

    const team = await callTool(access, "get_team_performance", { period: "last_30" });
    expect(team.isError).toBeFalsy();
    expect(Array.isArray(team.structuredContent!.sellers)).toBe(true);

    const funnel = await callTool(access, "get_pipeline_metrics", { pipelineId: ids.pipelineA });
    expect(funnel.isError).toBeFalsy();
    expect((funnel.structuredContent!.stages as { name: string }[]).map((s) => s.name)).toEqual(["Novo", "Proposta"]);

    const camps = await callTool(access, "get_campaign_results", {});
    expect((camps.structuredContent!.items as { name: string }[]).map((c) => c.name)).toEqual(["Black Friday"]);
    const camp = await callTool(access, "get_campaign_results", { campaignId: ids.campaignA });
    expect(camp.isError).toBeFalsy();
    expect(camp.structuredContent!.stats).toMatchObject({ sent: 90, read: 50 });
  }, 60_000);

  it("isolamento: org A nunca enxerga dados da org B", async () => {
    const { access } = await connect(ids.adminA, ids.orgA);
    const leadB = await callTool(access, "get_lead", { id: ids.dealB });
    expect(leadB.isError).toBe(true);
    const leadBNum = await callTool(access, "get_lead", { id: String(ids.dealBNumber) });
    expect(leadBNum.isError).toBe(true);
    const msgsB = await callTool(access, "get_conversation_messages", { conversationId: ids.convB });
    expect(msgsB.isError).toBe(true);
    const campB = await callTool(access, "get_campaign_results", { campaignId: ids.campaignB });
    expect(campB.isError).toBe(true);
    const funnelB = await callTool(access, "get_pipeline_metrics", { pipelineId: ids.pipelineB });
    expect(funnelB.isError).toBe(true);
    const search = await callTool(access, "list_leads", { search: "Secreto" });
    expect((search.structuredContent!.items as unknown[]).length).toBe(0);
    expect(JSON.stringify([leadB, msgsB, campB, search])).not.toMatch(/Secreto|org B|99999/);
  }, 60_000);

  it("RBAC: MEMBER só vê os próprios negócios e não acessa desempenho da equipe", async () => {
    const { updateMcpOrgConfig } = await import("@/services/mcp/settings");
    // MEMBER sem `mcp:connect` não conecta…
    const oauth = await import("@/services/mcp/oauth");
    const c = await oauth.registerClient({ client_name: "Teste MCP", redirect_uris: ["https://ok.example/cb"] }, null);
    const v = await oauth.validateAuthorizeRequest({
      response_type: "code", client_id: c.client_id, redirect_uri: "https://ok.example/cb",
      code_challenge: pkcePair().challenge, code_challenge_method: "S256",
    });
    if (!v.ok) throw new Error("validate");
    await expect(
      oauth.approveAuthorization({ id: ids.memberA, organizationId: ids.orgA }, v.value, v.value.requestedScopes),
    ).rejects.toMatchObject({ error: "access_denied" });
    // …até a org liberar para todos.
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { allowAllUsers: true });
    const { access } = await connect(ids.memberA, ids.orgA);
    const leads = await callTool(access, "list_leads", {});
    expect((leads.structuredContent!.items as { title: string }[]).map((d) => d.title)).toEqual(["Negócio do Membro"]);
    const adminDeal = await callTool(access, "get_lead", { id: ids.dealAdmin });
    expect(adminDeal.isError).toBe(true);
    const team = await callTool(access, "get_team_performance", {});
    expect(team.isError).toBe(true);
    const sales = await callTool(access, "get_sales_metrics", {});
    expect(sales.structuredContent!.onlyOwnDeals).toBe(true);
    const msgs = await callTool(access, "get_conversation_messages", { conversationId: ids.convA });
    expect(msgs.isError).toBe(true);
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { allowAllUsers: false });
    // Permissão retirada → a conexão existente para de funcionar.
    expect((await rpc(access, "tools/list")).status).toBe(401);
  }, 60_000);

  it("escopos: conexão sem messages:read e escopo retirado pela org", async () => {
    const { access } = await connect(ids.adminA, ids.orgA, ["leads:read"]);
    const msgs = await callTool(access, "get_conversation_messages", { conversationId: ids.convA });
    expect(msgs.isError).toBe(true);
    expect(msgs.content[0].text).toContain("messages:read");
    expect((await callTool(access, "list_leads", {})).isError).toBeFalsy();

    const { updateMcpOrgConfig } = await import("@/services/mcp/settings");
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { allowedScopes: ["metrics:read"] });
    expect((await callTool(access, "list_leads", {})).isError).toBe(true);
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { allowedScopes: ["leads:read", "conversations:read", "messages:read", "metrics:read", "team:read", "campaigns:read"] });
  }, 60_000);

  it("revogação: conexão revogada, RFC 7009 e MCP desligado têm efeito imediato", async () => {
    const oauth = await import("@/services/mcp/oauth");
    const a = await connect(ids.adminA, ids.orgA);
    expect((await rpc(a.access, "tools/list")).status).toBe(200);
    await oauth.revokeConnection(ids.orgA, a.connectionId, ids.adminA);
    expect((await rpc(a.access, "tools/list")).status).toBe(401);
    const ref = await tokenRequest({ grant_type: "refresh_token", client_id: a.clientId, refresh_token: a.refresh });
    expect(ref.body.error).toBe("invalid_grant");

    // Admin da org B não revoga conexão da org A.
    const b = await connect(ids.adminA, ids.orgA);
    expect(await oauth.revokeConnection(ids.orgB, b.connectionId, ids.adminB)).toBe(false);
    expect((await rpc(b.access, "tools/list")).status).toBe(200);

    // RFC 7009 pelo cliente.
    const { POST: revoke } = await import("@/app/api/mcp/oauth/revoke/route");
    const rr = await revoke(
      new Request(`${BASE}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: b.refresh, client_id: b.clientId }).toString(),
      }),
    );
    expect(rr.status).toBe(200);
    expect((await rpc(b.access, "tools/list")).status).toBe(401);

    // MCP desligado na org.
    const c = await connect(ids.adminA, ids.orgA);
    const { updateMcpOrgConfig } = await import("@/services/mcp/settings");
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { enabled: false });
    expect((await rpc(c.access, "tools/list")).status).toBe(401);
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { enabled: true });
    expect((await rpc(c.access, "tools/list")).status).toBe(200);
  }, 60_000);

  it("auditoria grava ferramenta e filtros sem texto livre nem conteúdo", async () => {
    const { access, connectionId } = await connect(ids.adminA, ids.orgA);
    await callTool(access, "list_leads", { search: "Maria 5511999998888" });
    const { prismaBase } = await import("@/lib/prisma-base");
    const row = await prismaBase.mcpAuditLog.findFirst({
      where: { connectionId, tool: "list_leads" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.status).toBe("ok");
    expect(JSON.stringify(row?.args)).not.toContain("5511999998888");
    const all = await prismaBase.mcpAuditLog.findMany({ where: { organizationId: ids.orgA } });
    expect(JSON.stringify(all)).not.toMatch(/bwmcp_|orçamento/);
  });

  it("retenção: apaga tokens expirados e histórico antigo, preserva CODE e dados recentes", async () => {
    const { prismaBase } = await import("@/lib/prisma-base");
    const { purgeMcpData } = await import("@/services/mcp/retention");
    const { access, connectionId } = await connect(ids.adminA, ids.orgA);
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    await prismaBase.mcpToken.updateMany({ where: { connectionId }, data: { expiresAt: old } });
    await prismaBase.mcpAuditLog.create({
      data: { organizationId: ids.orgA, connectionId, tool: "list_leads", status: "ok", createdAt: new Date(Date.now() - 400 * 24 * 3600 * 1000) },
    });
    const recent = await prismaBase.mcpAuditLog.create({
      data: { organizationId: ids.orgA, connectionId, tool: "list_leads", status: "ok" },
    });
    const r = await purgeMcpData();
    expect(r.tokens).toBeGreaterThanOrEqual(2);
    expect(r.audit).toBeGreaterThanOrEqual(1);
    const kinds = (await prismaBase.mcpToken.findMany({ where: { connectionId }, select: { kind: true } })).map((t) => t.kind);
    expect(kinds).toEqual(["CODE"]);
    expect(await prismaBase.mcpAuditLog.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect((await rpc(access, "tools/list")).status).toBe(401);
  });

  it("escopo só desconhecido (ex.: openid) não quebra: pede todos e o usuário escolhe", async () => {
    const oauth = await import("@/services/mcp/oauth");
    const c = await oauth.registerClient({ client_name: "Teste MCP", redirect_uris: ["https://ok.example/cb"] }, null);
    const v = await oauth.validateAuthorizeRequest({
      response_type: "code", client_id: c.client_id, redirect_uri: "https://ok.example/cb",
      code_challenge: pkcePair().challenge, code_challenge_method: "S256", scope: "openid offline_access",
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.requestedScopes).toContain("leads:read");
  });

  it("get_lead com número fora do int4 é 'não encontrado', não erro interno", async () => {
    const { access } = await connect(ids.adminA, ids.orgA);
    const r = await callTool(access, "get_lead", { id: "99999999999" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("não encontrado");
  });

  it("troca de senha / sair de todos os dispositivos derruba a conexão MCP", async () => {
    const { prismaBase } = await import("@/lib/prisma-base");
    const a = await connect(ids.adminA, ids.orgA);
    expect((await rpc(a.access, "tools/list")).status).toBe(200);
    await prismaBase.user.update({ where: { id: ids.adminA }, data: { sessionVersion: { increment: 1 } } });
    expect((await rpc(a.access, "tools/list")).status).toBe(401);
    const conn = await prismaBase.mcpConnection.findUnique({ where: { id: a.connectionId } });
    expect(conn?.revokedAt).not.toBeNull();
    const ref = await tokenRequest({ grant_type: "refresh_token", client_id: a.clientId, refresh_token: a.refresh });
    expect(ref.body.error).toBe("invalid_grant");
    // Revogação feita pelo sistema aparece no histórico do dono da conexão.
    const log = await prismaBase.mcpAuditLog.findFirst({ where: { connectionId: a.connectionId, tool: "oauth.revoke" } });
    expect(log?.userId).toBe(ids.adminA);
    // Reconectar depois funciona (nova versão gravada).
    const b = await connect(ids.adminA, ids.orgA);
    expect((await rpc(b.access, "tools/list")).status).toBe(200);
  });

  it("usuário anonimizado (LGPD) perde o acesso e não consegue reconectar", async () => {
    const { prismaBase } = await import("@/lib/prisma-base");
    const { updateMcpOrgConfig } = await import("@/services/mcp/settings");
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { allowAllUsers: true });
    const m = await connect(ids.memberA, ids.orgA);
    expect((await rpc(m.access, "tools/list")).status).toBe(200);
    await prismaBase.user.update({ where: { id: ids.memberA }, data: { isErased: true } });
    expect((await rpc(m.access, "tools/list")).status).toBe(401);
    const ref = await tokenRequest({ grant_type: "refresh_token", client_id: m.clientId, refresh_token: m.refresh });
    expect(ref.body.error).toBe("invalid_grant");
    await expect(connect(ids.memberA, ids.orgA)).rejects.toMatchObject({ error: "access_denied" });
    await prismaBase.user.update({ where: { id: ids.memberA }, data: { isErased: false } });
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { allowAllUsers: false });
  });

  it("operador só vê o que é dele, mesmo com a org liberando 'ver todos' e o pool sem responsável", async () => {
    const { prismaBase } = await import("@/lib/prisma-base");
    const { runWithContext } = await import("@/lib/request-context");
    const { setVisibilityForRole, setUnassignedForRole } = await import("@/lib/visibility");
    const { updateMcpOrgConfig } = await import("@/services/mcp/settings");
    const asOrgA = <T,>(fn: () => Promise<T>) =>
      runWithContext({ organizationId: ids.orgA, userId: ids.adminA, isSuperAdmin: false }, fn);
    // Configuração mais aberta possível para o papel do operador na UI.
    await asOrgA(() => setVisibilityForRole("MEMBER", "all"));
    await asOrgA(() => setUnassignedForRole("MEMBER", true));
    await updateMcpOrgConfig(ids.orgA, ids.adminA, { allowAllUsers: true });

    const stage = await prismaBase.stage.findFirst({ where: { pipelineId: ids.pipelineA }, select: { id: true } });
    const memberDeal = await prismaBase.deal.findUnique({ where: { id: ids.dealMember }, select: { contactId: true } });
    const poolContact = await prismaBase.contact.create({
      data: { organizationId: ids.orgA, number: 50, name: "Pool Sem Dono", phone: "5511900000050" },
      select: { id: true },
    });
    const poolDeal = await prismaBase.deal.create({
      data: { organizationId: ids.orgA, number: 50, title: "Negócio Sem Dono", value: 10, stageId: stage!.id, contactId: poolContact.id },
      select: { id: true },
    });
    const queueConv = await prismaBase.conversation.create({
      data: { organizationId: ids.orgA, channel: "whatsapp", contactId: poolContact.id, status: "OPEN", number: 50, lastMessageAt: new Date() },
      select: { id: true },
    });
    await prismaBase.message.create({
      data: { organizationId: ids.orgA, conversationId: queueConv.id, content: "fila sem dono", direction: "in" },
    });
    // Conversa do contato do negócio do operador, mas atendida pelo admin.
    const ownDealConv = await prismaBase.conversation.create({
      data: { organizationId: ids.orgA, channel: "whatsapp", contactId: memberDeal!.contactId!, assignedToId: ids.adminA, status: "OPEN", number: 51, lastMessageAt: new Date() },
      select: { id: true },
    });
    await prismaBase.message.create({
      data: { organizationId: ids.orgA, conversationId: ownDealConv.id, content: "mensagem do lead do operador", direction: "in" },
    });

    try {
      const { access } = await connect(ids.memberA, ids.orgA);

      const leads = await callTool(access, "list_leads", {});
      expect(leads.structuredContent!.scope).toBe("own");
      expect((leads.structuredContent!.items as { title: string }[]).map((d) => d.title)).toEqual(["Negócio do Membro"]);
      // Pedir os negócios de outro responsável não abre nada.
      const other = await callTool(access, "list_leads", { ownerId: ids.adminA });
      expect((other.structuredContent!.items as unknown[]).length).toBe(0);

      expect((await callTool(access, "get_lead", { id: ids.dealMember })).isError).toBeFalsy();
      expect((await callTool(access, "get_lead", { id: ids.dealAdmin })).isError).toBe(true);
      expect((await callTool(access, "get_lead", { id: poolDeal.id })).isError).toBe(true);

      const convs = await callTool(access, "list_conversations", {});
      const convIds = (convs.structuredContent!.items as { id: string }[]).map((c) => c.id);
      expect(convIds).toContain(ownDealConv.id);
      expect(convIds).not.toContain(queueConv.id);
      expect(convIds).not.toContain(ids.convA);

      const ownMsgs = await callTool(access, "get_conversation_messages", { conversationId: ownDealConv.id });
      expect(ownMsgs.isError).toBeFalsy();
      expect((await callTool(access, "get_conversation_messages", { conversationId: queueConv.id })).isError).toBe(true);
      expect((await callTool(access, "get_conversation_messages", { conversationId: ids.convA })).isError).toBe(true);

      const sales = await callTool(access, "get_sales_metrics", {});
      expect(sales.structuredContent!.onlyOwnDeals).toBe(true);
      const funnel = await callTool(access, "get_pipeline_metrics", { pipelineId: ids.pipelineA });
      expect(funnel.structuredContent!.onlyOwnDeals).toBe(true);
      const open = (funnel.structuredContent!.stages as { openCount: number }[]).reduce((a, s) => a + s.openCount, 0);
      expect(open).toBe(1);

      expect((await callTool(access, "get_team_performance", {})).isError).toBe(true);
      expect((await callTool(access, "get_campaign_results", {})).isError).toBe(true);

      // Admin continua vendo o pool e os negócios de todos.
      const adminConn = await connect(ids.adminA, ids.orgA);
      const adminLeads = await callTool(adminConn.access, "list_leads", {});
      expect(adminLeads.structuredContent!.scope).toBe("visible");
      expect((adminLeads.structuredContent!.items as { title: string }[]).map((d) => d.title)).toContain("Negócio Sem Dono");
    } finally {
      await asOrgA(() => setVisibilityForRole("MEMBER", "own"));
      await asOrgA(() => setUnassignedForRole("MEMBER", false));
      await updateMcpOrgConfig(ids.orgA, ids.adminA, { allowAllUsers: false });
      await prismaBase.message.deleteMany({ where: { conversationId: { in: [queueConv.id, ownDealConv.id] } } });
      await prismaBase.conversation.deleteMany({ where: { id: { in: [queueConv.id, ownDealConv.id] } } });
      await prismaBase.deal.delete({ where: { id: poolDeal.id } });
    }
  }, 60_000);
});
