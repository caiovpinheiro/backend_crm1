/**
 * Integração das ferramentas MCP de atendimento contra Postgres LOCAL
 * (DATABASE_URL remota → skip, como os demais *.integration.test.ts).
 *
 * Dados controlados em duas orgs. Cobre: filtros e cursor do
 * list_conversations (inclusive empate de data), tabulação e quem encerrou,
 * tipo de remetente e transcrição nas mensagens, linha do tempo, fila,
 * desempenho da equipe, campos personalizados, escopos desligados por
 * padrão (403/vazio) e isolamento entre organizações.
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
const ALL_SCOPES = [
  "leads:read", "conversations:read", "messages:read", "metrics:read", "team:read",
  "campaigns:read", "events:read", "queue:read", "custom_fields:read", "audio:read",
];

const ids: Record<string, string> = {};
const day = (s: string) => new Date(`${s}T15:00:00.000Z`);

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  return r.body.result as ToolResult;
}

/** Conecta (DCR → consentimento → PKCE) pedindo todos os escopos. */
async function connect(userId: string, orgId: string): Promise<string> {
  const oauth = await import("@/services/mcp/oauth");
  const c = await oauth.registerClient({ client_name: "Teste MCP Conv", redirect_uris: ["https://ok.example/cb"] }, null);
  const { verifier, challenge } = pkcePair();
  const v = await oauth.validateAuthorizeRequest({
    response_type: "code", client_id: c.client_id, redirect_uri: "https://ok.example/cb",
    code_challenge: challenge, code_challenge_method: "S256",
  });
  if (!v.ok) throw new Error(v.error.description);
  const ap = await oauth.approveAuthorization({ id: userId, organizationId: orgId }, v.value, v.value.requestedScopes);
  const code = new URL(ap.redirectTo).searchParams.get("code")!;
  const t = await oauth.exchangeAuthorizationCode({
    client: (await oauth.findClient(c.client_id))!,
    code, codeVerifier: verifier, redirectUri: "https://ok.example/cb", resource: null,
  });
  return t.access_token;
}

async function setScopes(orgId: string, actor: string, scopes: string[], extra: Record<string, unknown> = {}) {
  const { updateMcpOrgConfig } = await import("@/services/mcp/settings");
  await updateMcpOrgConfig(orgId, actor, { enabled: true, allowedScopes: scopes as never, ...extra });
}

describe.skipIf(!LOCAL)("MCP atendimento (Postgres local)", () => {
  beforeAll(async () => {
    const { prismaBase: db } = await import("@/lib/prisma-base");
    for (const k of ["A", "B"]) {
      ids[`org${k}`] = (await db.organization.create({ data: { name: `MCPC ${k} ${sfx}`, slug: `mcpc-${k.toLowerCase()}-${sfx}` }, select: { id: true } })).id;
    }
    const mkUser = async (key: string, org: string, role: "ADMIN" | "MEMBER", type: "HUMAN" | "AI" = "HUMAN") => {
      ids[key] = (await db.user.create({ data: { name: `U ${key}`, email: `mcpc-${key}-${sfx}@t.local`, role, type, organizationId: ids[org] }, select: { id: true } })).id;
    };
    await mkUser("adminA", "orgA", "ADMIN");
    await mkUser("memberA", "orgA", "MEMBER");
    await mkUser("aiA", "orgA", "MEMBER", "AI");
    await mkUser("adminB", "orgB", "ADMIN");
    const mkDept = async (key: string, org: string, name: string, number: number) => {
      ids[key] = (await db.department.create({ data: { organizationId: ids[org], name, number }, select: { id: true } })).id;
    };
    await mkDept("comercial", "orgA", "Comercial", 1);
    await mkDept("suporte", "orgA", "Suporte", 2);
    await mkDept("deptB", "orgB", "Suporte", 1);
    ids.tabParent = (await db.tabulation.create({ data: { organizationId: ids.orgA, departmentId: ids.comercial, name: "Venda", number: 1 }, select: { id: true } })).id;
    ids.tabChild = (await db.tabulation.create({ data: { organizationId: ids.orgA, departmentId: ids.comercial, name: "Fechou", number: 2, parentId: ids.tabParent }, select: { id: true } })).id;

    // Negócio do admin com contato (campos personalizados).
    const p = await db.pipeline.create({ data: { organizationId: ids.orgA, name: "F", slug: `f-${sfx}`, isDefault: true }, select: { id: true } });
    const st = await db.stage.create({ data: { organizationId: ids.orgA, pipelineId: p.id, name: "Novo", slug: `n-${sfx}`, number: 1, position: 0 }, select: { id: true } });
    const contact = await db.contact.create({ data: { organizationId: ids.orgA, number: 1, name: "Cliente Um", phone: "5511911112222" }, select: { id: true } });
    ids.contactA = contact.id;
    ids.dealA = (await db.deal.create({ data: { organizationId: ids.orgA, number: 1, title: "Negócio CF", stageId: st.id, contactId: contact.id, ownerId: ids.adminA }, select: { id: true } })).id;
    const cfDeal = await db.customField.create({ data: { organizationId: ids.orgA, number: 1, name: "cpf", label: "CPF", type: "TEXT", entity: "deal" }, select: { id: true } });
    const cfPhone = await db.customField.create({ data: { organizationId: ids.orgA, number: 2, name: "fone2", label: "Telefone 2", type: "PHONE", entity: "contact" }, select: { id: true } });
    const cfHidden = await db.customField.create({ data: { organizationId: ids.orgA, number: 3, name: "secreto", label: "Secreto", type: "TEXT", entity: "deal" }, select: { id: true } });
    ids.cfDeal = cfDeal.id; ids.cfPhone = cfPhone.id; ids.cfHidden = cfHidden.id;
    await db.dealCustomFieldValue.createMany({ data: [
      { organizationId: ids.orgA, dealId: ids.dealA, customFieldId: cfDeal.id, value: "123.456.789-00" },
      { organizationId: ids.orgA, dealId: ids.dealA, customFieldId: cfHidden.id, value: "não pode sair" },
    ] });
    await db.contactCustomFieldValue.create({ data: { organizationId: ids.orgA, contactId: contact.id, customFieldId: cfPhone.id, value: "5511933334444" } });

    const mkConv = async (key: string, data: Record<string, unknown>) => {
      ids[key] = (await db.conversation.create({ data: { organizationId: ids.orgA, channel: "whatsapp", contactId: contact.id, ...data } as never, select: { id: true } })).id;
    };
    let n = 1;
    // c1: encerrada em massa, tabulada, passou pela IA e trocou de departamento.
    await mkConv("c1", { number: n++, status: "RESOLVED", departmentId: ids.comercial, assignedToId: ids.adminA, createdAt: day("2026-10-05"), closedAt: day("2026-10-06"), tabulationId: ids.tabChild });
    // c2: esperando agora, sem responsável, no Suporte, na fila de distribuição.
    await mkConv("c2", { number: n++, status: "OPEN", departmentId: ids.suporte, createdAt: day("2026-11-10"), lastMessageDirection: "in", lastInboundAt: new Date(Date.now() - 30 * 60_000) });
    // c3: encerrada pela IA.
    await mkConv("c3", { number: n++, status: "RESOLVED", departmentId: ids.suporte, assignedToId: ids.aiA, createdAt: day("2026-11-12"), closedAt: day("2026-11-12") });
    // c4..c9: Suporte, para o cursor (c6 e c7 com o mesmo createdAt).
    for (const [k, d] of [["c4", "2026-11-01"], ["c5", "2026-11-02"], ["c6", "2026-11-03"], ["c7", "2026-11-03"], ["c8", "2026-11-04"], ["c9", "2026-11-05"]] as const) {
      await mkConv(k, { number: n++, status: "OPEN", departmentId: ids.suporte, assignedToId: ids.adminA, createdAt: day(d) });
    }
    // Conversa da org B (mesmo nome de departamento).
    const contactB = await db.contact.create({ data: { organizationId: ids.orgB, number: 1, name: "Cliente B" }, select: { id: true } });
    ids.convB = (await db.conversation.create({ data: { organizationId: ids.orgB, channel: "whatsapp", contactId: contactB.id, number: 1, status: "OPEN", departmentId: ids.deptB, lastMessageDirection: "in", lastInboundAt: new Date(), createdAt: day("2026-11-10") }, select: { id: true } })).id;

    // Mensagens do c1: um de cada remetente + áudios.
    const msg = (data: Record<string, unknown>) => db.message.create({ data: { organizationId: ids.orgA, conversationId: ids.c1, ...data } as never, select: { id: true } });
    await msg({ content: "Oi", direction: "in", createdAt: new Date("2026-10-05T15:01:00Z") });
    await msg({ content: "Olá, sou o atendente", direction: "out", authorType: "human", senderName: "U adminA", createdAt: new Date("2026-10-05T15:02:00Z") });
    await msg({ content: "Resposta da IA", direction: "out", authorType: "bot", aiAgentUserId: ids.aiA, senderName: "Agente", createdAt: new Date("2026-10-05T15:03:00Z") });
    await msg({ content: "Mensagem automática", direction: "out", authorType: "bot", senderName: "Fluxo", createdAt: new Date("2026-10-05T15:04:00Z") });
    await msg({ content: "aviso do sistema", direction: "out", authorType: "system", createdAt: new Date("2026-10-05T15:05:00Z") });
    ids.audio1 = (await msg({ content: "audio.ogg", direction: "in", messageType: "audio", createdAt: new Date("2026-10-05T15:06:00Z") })).id;
    await msg({ content: "audio2.ogg", direction: "in", messageType: "ptt", createdAt: new Date("2026-10-05T15:07:00Z") });
    // Mesma DDL da migration 20260929120000_ai_v2_runtime_tables (o db push não cria).
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ai_simple_media_texts" (
      "messageId" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "kind" TEXT NOT NULL,
      "text" TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await db.$executeRawUnsafe(
      `INSERT INTO "ai_simple_media_texts" ("messageId","organizationId","kind","text","createdAt") VALUES ($1,$2,'audio',$3,now()) ON CONFLICT DO NOTHING`,
      ids.audio1, ids.orgA, "quero saber o preço do curso",
    );

    // Linha do tempo do c1.
    const ev = (type: string, at: string, extra: Record<string, unknown> = {}) =>
      db.activityEvent.create({ data: { organizationId: ids.orgA, type, entityType: "CONVERSATION", entityId: ids.c1, conversationId: ids.c1, occurredAt: new Date(at), actorType: "SYSTEM", ...extra } as never });
    await ev("CONVERSATION_CREATED", "2026-10-05T15:00:00Z");
    await ev("ASSIGNEE_CHANGED", "2026-10-05T15:02:30Z", { actorType: "SYSTEM", oldValue: null, newValue: "U aiA", meta: { toUserId: ids.aiA } });
    await ev("ASSIGNEE_CHANGED", "2026-10-05T15:10:00Z", { actorType: "AI", oldValue: "U aiA", newValue: "U adminA", meta: { fromUserId: ids.aiA, toUserId: ids.adminA } });
    await ev("CONVERSATION_DEPARTMENT_CHANGED", "2026-10-05T15:11:00Z", { actorType: "HUMAN", actorUserId: ids.adminA, meta: { fromDepartmentName: "Suporte", toDepartmentName: "Comercial" } });
    await ev("CONVERSATION_CLOSED", "2026-10-06T15:00:00Z", { actorType: "HUMAN", actorUserId: ids.adminA, tabulationId: ids.tabChild, meta: { source: "bulk-sync" } });
    await ev("CONVERSATION_TABULATED", "2026-10-06T15:00:01Z", { actorType: "HUMAN", actorUserId: ids.adminA, tabulationId: ids.tabChild, meta: { tabulationName: "Fechou" } });
    await db.activityEvent.create({ data: { organizationId: ids.orgA, type: "CONVERSATION_CLOSED", entityType: "CONVERSATION", entityId: ids.c3, conversationId: ids.c3, occurredAt: day("2026-11-12"), actorType: "AI", actorLabel: "Agente", meta: { source: "bulk-sync" } } as never });
    await db.distributionPending.create({ data: { organizationId: ids.orgA, conversationId: ids.c1, triggerSource: "inbound", status: "RESOLVED", createdAt: new Date("2026-10-05T15:01:30Z"), resolvedAt: new Date("2026-10-05T15:02:20Z"), resolvedUserId: ids.adminA } });
    await db.distributionPending.create({ data: { organizationId: ids.orgA, conversationId: ids.c2, triggerSource: "inbound", status: "PENDING" } });

    // Presença: admin e operador online.
    await db.agentStatus.createMany({ data: [
      { organizationId: ids.orgA, userId: ids.adminA, status: "ONLINE" },
      { organizationId: ids.orgA, userId: ids.memberA, status: "ONLINE" },
      { organizationId: ids.orgB, userId: ids.adminB, status: "ONLINE" },
    ] });
    await db.departmentMember.createMany({ data: [
      { organizationId: ids.orgA, departmentId: ids.comercial, userId: ids.adminA },
      { organizationId: ids.orgA, departmentId: ids.suporte, userId: ids.memberA },
    ] as never });

    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES);
    await setScopes(ids.orgB, ids.adminB, ALL_SCOPES);
    ids.tokenA = await connect(ids.adminA, ids.orgA);
    ids.tokenB = await connect(ids.adminB, ids.orgB);
  }, 90_000);

  afterAll(async () => {
    if (!ids.orgA) return;
    const { prismaBase: db } = await import("@/lib/prisma-base");
    const orgs = [ids.orgA, ids.orgB];
    await db.$executeRawUnsafe(`DELETE FROM "ai_simple_media_texts" WHERE "organizationId" = ANY($1::text[])`, orgs).catch(() => {});
    for (const m of ["mcpAuditLog", "mcpToken", "mcpConnection", "activityEvent", "distributionPending", "agentStatus", "departmentMember",
      "message", "conversation", "dealCustomFieldValue", "contactCustomFieldValue", "customField", "deal", "contact", "stage", "pipeline",
      "tabulation", "department", "auditLog", "organizationSetting"] as const) {
      await (db[m] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
    }
    await db.mcpOAuthClient.deleteMany({ where: { clientName: "Teste MCP Conv" } });
    await db.tabulation.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.user.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
  }, 60_000);

  it("escopos novos vêm desligados por padrão na org", async () => {
    const { parseMcpConfig } = await import("@/services/mcp/settings");
    const cfg = parseMcpConfig(null);
    for (const s of ["events:read", "queue:read", "custom_fields:read", "audio:read"]) {
      expect(cfg.allowedScopes).not.toContain(s);
    }
    expect(cfg.customFieldIds).toEqual([]);
    expect(parseMcpConfig(JSON.stringify({ enabled: true })).allowedScopes).not.toContain("events:read");
  });

  it("list_conversations: período, departamento, atendente, status e canal", async () => {
    const t = ids.tokenA;
    const ofIds = (r: ToolResult) => (r.structuredContent!.items as { id: string }[]).map((c) => c.id).sort();
    expect(ofIds(await call(t, "list_conversations", { createdFrom: "2026-11-10", createdTo: "2026-11-12" }))).toEqual([ids.c2, ids.c3].sort());
    expect(ofIds(await call(t, "list_conversations", { closedFrom: "2026-10-01", closedTo: "2026-10-31" }))).toEqual([ids.c1]);
    expect(ofIds(await call(t, "list_conversations", { departmentId: ids.comercial }))).toEqual([ids.c1]);
    expect(ofIds(await call(t, "list_conversations", { assignedToId: "none" }))).toEqual([ids.c2]);
    expect(ofIds(await call(t, "list_conversations", { assignedToId: ids.aiA }))).toEqual([ids.c3]);
    expect((await call(t, "list_conversations", { status: "RESOLVED" })).structuredContent!.items).toHaveLength(2);
    expect((await call(t, "list_conversations", { channel: "instagram" })).structuredContent!.items).toHaveLength(0);
    expect((await call(t, "list_conversations", { updatedFrom: "2030-01-01" })).structuredContent!.items).toHaveLength(0);
    const bad = await call(t, "list_conversations", { createdFrom: "ontem" });
    expect(bad.isError).toBe(true);
  });

  it("list_conversations: tabulação (caminho) e quem encerrou na conversa", async () => {
    const r = await call(ids.tokenA, "list_conversations", { status: "RESOLVED" });
    const items = r.structuredContent!.items as { id: string; tabulation: { path: string } | null; closedBy: { type: string } | null; department: { name: string } }[];
    const c1 = items.find((c) => c.id === ids.c1)!;
    expect(c1.tabulation?.path).toBe("Venda › Fechou");
    expect(c1.closedBy?.type).toBe("massa");
    expect(c1.department.name).toBe("Comercial");
    expect(items.find((c) => c.id === ids.c3)!.closedBy?.type).toBe("ia");
  });

  it("list_conversations: cursor percorre tudo sem repetir nem perder (inclusive empate de data)", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await call(ids.tokenA, "list_conversations", { departmentId: ids.suporte, perPage: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...(r.structuredContent!.items as { id: string }[]).map((c) => c.id));
      cursor = (r.structuredContent!.nextCursor as string | null) ?? undefined;
      if (!r.structuredContent!.hasMore) break;
    }
    const expected = [ids.c2, ids.c3, ids.c4, ids.c5, ids.c6, ids.c7, ids.c8, ids.c9];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(expected.sort());
    // Ordem crescente também pagina certo.
    const asc: string[] = [];
    cursor = undefined;
    for (let i = 0; i < 10; i++) {
      const r = await call(ids.tokenA, "list_conversations", { departmentId: ids.suporte, perPage: 2, order: "asc", ...(cursor ? { cursor } : {}) });
      asc.push(...(r.structuredContent!.items as { id: string }[]).map((c) => c.id));
      cursor = (r.structuredContent!.nextCursor as string | null) ?? undefined;
      if (!r.structuredContent!.hasMore) break;
    }
    expect(asc).toHaveLength(8);
    expect(asc[0]).toBe(ids.c4);
    // Cursor de outra ordenação é recusado.
    const r1 = await call(ids.tokenA, "list_conversations", { departmentId: ids.suporte, perPage: 3 });
    const wrong = await call(ids.tokenA, "list_conversations", { sort: "updatedAt", cursor: r1.structuredContent!.nextCursor as string });
    expect(wrong.isError).toBe(true);
  });

  it("get_conversation_messages: tipo de remetente, data/hora e transcrição só com audio:read", async () => {
    const r = await call(ids.tokenA, "get_conversation_messages", { conversationId: ids.c1 });
    const msgs = r.structuredContent!.messages as { senderType: string; at: string; text: string; type: string }[];
    expect(msgs.map((m) => m.senderType)).toEqual(["contato", "atendente", "agente_ia", "automacao", "sistema", "contato", "contato"]);
    expect(msgs.every((m) => typeof m.at === "string" && !Number.isNaN(Date.parse(m.at)))).toBe(true);
    expect(msgs[5].text).toBe("quero saber o preço do curso");
    expect(msgs[6].text).toBe("[áudio]");
    expect((r.structuredContent!.conversation as { tabulation: { path: string } }).tabulation.path).toBe("Venda › Fechou");

    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES.filter((s) => s !== "audio:read"));
    const off = await call(ids.tokenA, "get_conversation_messages", { conversationId: ids.c1 });
    expect((off.structuredContent!.messages as { text: string }[])[5].text).toBe("[áudio]");
    expect(JSON.stringify(off)).not.toContain("preço do curso");
    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES);
  });

  it("get_conversation_events: atribuição, IA/humano, departamento, fila, encerramento e tabulação", async () => {
    const r = await call(ids.tokenA, "get_conversation_events", { conversationId: ids.c1 });
    expect(r.isError).toBeFalsy();
    const evs = r.structuredContent!.events as { category: string; closedBy?: { type: string }; tabulation?: { path: string }; from?: string; to?: string }[];
    const cats = evs.map((e) => e.category);
    for (const c of ["abertura", "entrada_fila", "saida_fila", "retomada_ia", "devolucao_humano", "transferencia_departamento", "encerramento", "tabulacao"]) {
      expect(cats).toContain(c);
    }
    const close = evs.find((e) => e.category === "encerramento")!;
    expect(close.closedBy?.type).toBe("massa");
    expect(close.tabulation?.path).toBe("Venda › Fechou");
    expect(evs.find((e) => e.category === "transferencia_departamento")).toMatchObject({ from: "Suporte", to: "Comercial" });
    // Cronológico + cursor + filtro por categoria.
    const p1 = await call(ids.tokenA, "get_conversation_events", { conversationId: ids.c1, limit: 3 });
    const p2 = await call(ids.tokenA, "get_conversation_events", { conversationId: ids.c1, limit: 50, cursor: p1.structuredContent!.nextCursor as string });
    expect([...(p1.structuredContent!.events as unknown[]), ...(p2.structuredContent!.events as unknown[])]).toHaveLength(evs.length);
    const only = await call(ids.tokenA, "get_conversation_events", { conversationId: ids.c1, categories: ["encerramento"] });
    expect((only.structuredContent!.events as unknown[]).length).toBe(1);
  });

  it("get_queue_status: por departamento, sem dado pessoal", async () => {
    const r = await call(ids.tokenA, "get_queue_status");
    expect(r.isError).toBeFalsy();
    const deps = r.structuredContent!.departments as { department: string; waiting: number; waitingUnassigned: number; oldestWaitMinutes: number | null; onlineAttendants: number }[];
    const sup = deps.find((d) => d.department === "Suporte")!;
    expect(sup).toMatchObject({ waiting: 1, waitingUnassigned: 1, onlineAttendants: 1 });
    expect(sup.oldestWaitMinutes).toBeGreaterThanOrEqual(29);
    expect(deps.find((d) => d.department === "Comercial")).toMatchObject({ waiting: 0, onlineAttendants: 1 });
    expect((r.structuredContent!.totals as { onlineAttendants: number }).onlineAttendants).toBe(2);
    expect(JSON.stringify(r)).not.toMatch(/U adminA|U memberA|Cliente|5511/);
  });

  it("get_team_performance: aceita período e departamento e devolve atendentes e vendedores", async () => {
    const r = await call(ids.tokenA, "get_team_performance", { period: "custom", startDate: "2026-10-01", endDate: "2026-11-20", departmentIds: [ids.suporte] });
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(r.structuredContent!.attendants)).toBe(true);
    expect(Array.isArray(r.structuredContent!.sellers)).toBe(true);
    expect(r.structuredContent!.departmentIds).toEqual([ids.suporte]);
    expect(r.structuredContent!.attendantsError).toBeUndefined();
    const all = await call(ids.tokenA, "get_team_performance", { period: "custom", startDate: "2026-10-01", endDate: "2026-11-20" });
    const att = all.structuredContent!.attendants as { id: string; attended: number; transferredOut: number }[];
    expect(att.map((x) => x.id), JSON.stringify(all.structuredContent)).toContain(ids.adminA);
  });

  it("campos personalizados: só com escopo + lista da org; telefone mascarado", async () => {
    // Escopo ligado, lista vazia → nenhum campo sai.
    let lead = await call(ids.tokenA, "get_lead", { id: ids.dealA });
    expect(lead.structuredContent!.customFields).toBeUndefined();
    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES, { customFieldIds: [ids.cfDeal, ids.cfPhone] });
    lead = await call(ids.tokenA, "get_lead", { id: ids.dealA });
    const cf = lead.structuredContent!.customFields as { field: string; value: string }[];
    expect(cf.map((f) => f.field).sort()).toEqual(["CPF", "Telefone 2"]);
    expect(cf.find((f) => f.field === "Telefone 2")!.value).not.toContain("33334444".slice(0, 6));
    expect(JSON.stringify(lead)).not.toContain("não pode sair");
    const list = await call(ids.tokenA, "list_leads", {});
    expect(((list.structuredContent!.items as { customFields?: unknown[] }[])[0].customFields ?? []).length).toBe(2);
    // Escopo desligado → some de novo, mesmo com a lista preenchida.
    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES.filter((s) => s !== "custom_fields:read"), { customFieldIds: [ids.cfDeal] });
    lead = await call(ids.tokenA, "get_lead", { id: ids.dealA });
    expect(lead.structuredContent!.customFields).toBeUndefined();
    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES, { customFieldIds: [] });
  });

  it("escopos desligados na org: eventos e fila recusados", async () => {
    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES.filter((s) => s !== "events:read" && s !== "queue:read"));
    const ev = await call(ids.tokenA, "get_conversation_events", { conversationId: ids.c1 });
    expect(ev.isError).toBe(true);
    expect(ev.content[0].text).toContain("events:read");
    const q = await call(ids.tokenA, "get_queue_status");
    expect(q.isError).toBe(true);
    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES);
  });

  it("operador: fila e equipe bloqueadas; conversas só as dele", async () => {
    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES, { allowAllUsers: true });
    const t = await connect(ids.memberA, ids.orgA);
    expect((await call(t, "get_queue_status")).isError).toBe(true);
    expect((await call(t, "get_team_performance")).isError).toBe(true);
    expect((await call(t, "list_conversations", {})).structuredContent!.items).toHaveLength(0);
    expect((await call(t, "get_conversation_events", { conversationId: ids.c1 })).isError).toBe(true);
    await setScopes(ids.orgA, ids.adminA, ALL_SCOPES, { allowAllUsers: false });
  });

  it("isolamento: org A não lê nada da org B (e vice-versa)", async () => {
    const a = ids.tokenA;
    expect((await call(a, "get_conversation_events", { conversationId: ids.convB })).isError).toBe(true);
    expect((await call(a, "get_conversation_messages", { conversationId: ids.convB })).isError).toBe(true);
    expect((await call(a, "list_conversations", { departmentId: ids.deptB })).structuredContent!.items).toHaveLength(0);
    const allA = await call(a, "list_conversations", { perPage: 50 });
    expect((allA.structuredContent!.items as { id: string }[]).map((c) => c.id)).not.toContain(ids.convB);
    const qB = await call(ids.tokenB, "get_queue_status");
    const depsB = qB.structuredContent!.departments as { department: string; waiting: number }[];
    expect(depsB).toHaveLength(1);
    expect(depsB[0]).toMatchObject({ department: "Suporte", waiting: 1 });
    expect((qB.structuredContent!.totals as { onlineAttendants: number }).onlineAttendants).toBe(1);
    expect((await call(ids.tokenB, "get_conversation_events", { conversationId: ids.c1 })).isError).toBe(true);
    expect((await call(ids.tokenB, "list_conversations", { departmentId: ids.suporte })).structuredContent!.items).toHaveLength(0);
  });
});
