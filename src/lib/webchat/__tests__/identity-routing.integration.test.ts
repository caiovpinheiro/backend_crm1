/**
 * Vínculo por campo de negócio e atendimento, com Postgres de verdade
 * (docs/decisoes/webchat-widget.md §9.12): SQL cru, uniques da disputa, índice
 * parcial do topo do inbox e isolamento entre organizações.
 *
 * Só corre contra Postgres local (DATABASE_URL em localhost). Sem isso, pula.
 * Efeitos externos (gatilho, push, turno de IA) ficam mockados.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { hostnameFromConnectionUrl } from "@/lib/warn-public-do-managed-hosts";

const h = vi.hoisted(() => ({
  widget: false,
  aiEnabled: true,
  onInboundMessageForAi: vi.fn(async (_a: unknown) => {}),
}));

vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: vi.fn(async () => {}),
  emitConversationCreated: vi.fn(),
  buildMessageTriggerData: () => ({}),
  openingMessageTriggerExtra: () => ({}),
  notifyDealStageChanged: vi.fn(async () => {}),
}));
vi.mock("@/lib/web-push", () => ({ notifyInboundMessage: vi.fn(async () => {}) }));
vi.mock("@/services/ai/turn-manager", () => ({ onInboundMessageForAi: h.onInboundMessageForAi }));
vi.mock("@/services/organization-widgets", async (orig) => ({
  ...(await orig<typeof import("@/services/organization-widgets")>()),
  hasOrganizationWidget: async () => h.widget,
}));
vi.mock("@/services/ai/attendance-gate", async (orig) => ({
  ...(await orig<typeof import("@/services/ai/attendance-gate")>()),
  isAiAttendanceEnabled: async () => h.aiEnabled,
}));
vi.mock("@/services/ai/phone-allowlist", async (orig) => ({
  ...(await orig<typeof import("@/services/ai/phone-allowlist")>()),
  isContactAllowedForAi: async () => true,
}));

const url = process.env.DATABASE_URL;
const host = url?.trim() ? hostnameFromConnectionUrl(url) : null;
const LOCAL = host === "localhost" || host === "127.0.0.1" || host === "::1";

const suffix = randomBytes(4).toString("hex");
let seq = 0;
const uid = (p: string) => `${p}${suffix}${++seq}`;

describe.skipIf(!LOCAL)("vínculo por campo de negócio e atendimento (Postgres local)", () => {
  let orgId = "";
  let otherOrgId = "";
  let fieldId = "";
  let stageId = "";

  type Base = typeof import("@/lib/prisma-base")["prismaBase"];
  let base: Base;

  async function inOrg<T>(fn: () => Promise<T>, org = orgId): Promise<T> {
    const { runWithContext } = await import("@/lib/request-context");
    return runWithContext({ organizationId: org, userId: "system", isSuperAdmin: false }, fn);
  }

  async function makeChannel(v2: unknown, org = orgId) {
    const { readWebchatV2Config } = await import("@/lib/webchat/v2-config");
    const row = await base.channel.create({
      data: {
        organizationId: org,
        name: uid("Canal "),
        number: ++seq + 100,
        type: "WEBCHAT",
        provider: "WEBCHAT",
        status: "CONNECTED",
        publicKey: `wc_${uid("k")}`.padEnd(27, "x"),
        config: { v2 } as object,
      },
      select: { id: true, publicKey: true, config: true },
    });
    return {
      id: row.id,
      organizationId: org,
      name: "Canal",
      publicKey: row.publicKey!,
      defaultPipelineId: null,
      config: {},
      v2: readWebchatV2Config(row.config),
      orgDefaults: { primary: "#000", avatarUrl: null },
    } as unknown as import("@/lib/webchat/session").WebchatChannel;
  }

  async function makeSession(channelId: string, org = orgId) {
    const row = await base.webchatSession.create({
      data: {
        id: uid("wv_"),
        organizationId: org,
        channelId,
        tokenHash: uid("hash"),
        expiresAt: new Date(Date.now() + 3_600_000),
        lastSeenAt: new Date(),
      },
    });
    return row as unknown as import("@/lib/webchat/session").WebchatSessionRow;
  }

  async function makeContact(name: string, phone?: string, org = orgId) {
    return base.contact.create({
      data: { organizationId: org, name, number: ++seq * 7 + 1000, ...(phone ? { phone } : {}) },
      select: { id: true },
    });
  }

  async function makeDeal(
    contactId: string | null,
    value: string | null,
    opts: { status?: "OPEN" | "WON" | "LOST"; updatedAt?: Date; org?: string; stage?: string; field?: string } = {},
  ) {
    const org = opts.org ?? orgId;
    const deal = await base.deal.create({
      data: {
        organizationId: org,
        title: uid("Negócio "),
        number: ++seq * 11 + 2000,
        stageId: opts.stage ?? stageId,
        status: opts.status ?? "OPEN",
        ...(contactId ? { contactId } : {}),
      },
      select: { id: true },
    });
    if (opts.updatedAt) {
      await base.$executeRaw`UPDATE deals SET "updatedAt" = ${opts.updatedAt} WHERE id = ${deal.id}`;
    }
    if (value !== null) {
      await base.dealCustomFieldValue.create({
        data: { organizationId: org, dealId: deal.id, customFieldId: opts.field ?? fieldId, value },
      });
    }
    return deal;
  }

  async function identify(
    channel: import("@/lib/webchat/session").WebchatChannel,
    session: import("@/lib/webchat/session").WebchatSessionRow,
    externalId: string,
    identity: Record<string, string> = {},
  ) {
    const { identifySignedWebchatVisitor } = await import("@/lib/webchat/identify-signed");
    return inOrg(
      () =>
        identifySignedWebchatVisitor({
          organizationId: channel.organizationId,
          session,
          config: channel.v2,
          externalId,
          identity: identity as never,
          attributes: undefined,
        }),
      channel.organizationId,
    );
  }

  async function sendMessage(
    channel: import("@/lib/webchat/session").WebchatChannel,
    session: import("@/lib/webchat/session").WebchatSessionRow,
    content = "olá",
    ref?: string,
  ) {
    const { processWebchatInbound } = await import("@/lib/webchat/inbound");
    return inOrg(
      () =>
        processWebchatInbound({
          organizationId: channel.organizationId,
          channelId: channel.id,
          session,
          clientMessageId: uid("m"),
          content,
          ref,
          refDealCustomFieldId: channel.v2.refDealCustomFieldId,
          v2: channel.v2,
        }),
      channel.organizationId,
    );
  }

  const dealMatch = () => ({ type: "dealCustomField", customFieldId: fieldId, normalize: "none" });

  beforeAll(async () => {
    base = (await import("@/lib/prisma-base")).prismaBase;
    const org = await base.organization.create({
      data: { name: uid("Org A "), slug: uid("org-a-") },
      select: { id: true },
    });
    const other = await base.organization.create({
      data: { name: uid("Org B "), slug: uid("org-b-") },
      select: { id: true },
    });
    orgId = org.id;
    otherOrgId = other.id;
    const field = await base.customField.create({
      data: { organizationId: orgId, name: uid("campo"), number: 1, label: "Identificador", type: "TEXT", entity: "deal" },
      select: { id: true },
    });
    fieldId = field.id;
    const pipeline = await base.pipeline.create({
      data: { organizationId: orgId, name: "Funil", slug: uid("funil-"), isDefault: true },
      select: { id: true },
    });
    const stage = await base.stage.create({
      data: { organizationId: orgId, name: "Entrada", slug: "entrada", number: 1, position: 0, pipelineId: pipeline.id },
      select: { id: true },
    });
    stageId = stage.id;
  });

  afterAll(async () => {
    if (!base) return;
    for (const organizationId of [orgId, otherOrgId]) {
      await base.message.deleteMany({ where: { organizationId } });
      await base.conversation.deleteMany({ where: { organizationId } });
      await base.deal.deleteMany({ where: { organizationId } });
      await base.contact.deleteMany({ where: { organizationId } });
    }
    await base.user.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await base.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => undefined);
  });

  it("contato do WhatsApp com negócio e valor: identify liga ao mesmo contato e negócio, sem duplicar", async () => {
    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const contact = await makeContact("Pessoa", "+5511999990001");
    const value = uid("val");
    const deal = await makeDeal(contact.id, value);
    const session = await makeSession(channel.id);

    const res = await identify(channel, session, value);
    expect(res.contactId).toBe(contact.id);
    expect(res.dealId).toBe(deal.id);

    const sent = await sendMessage(channel, session);
    expect(sent.contactId).toBe(contact.id);
    await new Promise((r) => setTimeout(r, 100));

    const contacts = await base.contact.count({ where: { organizationId: orgId, phone: "+5511999990001" } });
    const deals = await base.deal.count({ where: { contactId: contact.id } });
    expect(contacts).toBe(1);
    expect(deals).toBe(1);
    const again = await identify(channel, await makeSession(channel.id), value);
    expect(again.contactId).toBe(contact.id);
    expect(again.dealId).toBe(deal.id);
  });

  it("normalização por dígitos acha o valor gravado com pontuação", async () => {
    const channel = await makeChannel({
      identity: { matchField: { type: "dealCustomField", customFieldId: fieldId, normalize: "digits" } },
    });
    const contact = await makeContact("Com pontuação");
    const digits = String(Date.now()).slice(-9);
    const deal = await makeDeal(contact.id, `${digits.slice(0, 3)}.${digits.slice(3, 6)}-${digits.slice(6)}`);
    const res = await identify(channel, await makeSession(channel.id), digits);
    expect(res.contactId).toBe(contact.id);
    expect(res.dealId).toBe(deal.id);
  });

  it("mesmo valor em dois negócios: o aberto mais recente; sem aberto, o mais recente", async () => {
    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const contact = await makeContact("Dois negócios");
    const value = uid("val");
    await makeDeal(contact.id, value, { updatedAt: new Date("2026-01-01") });
    const recentOpen = await makeDeal(contact.id, value, { updatedAt: new Date("2026-02-01") });
    await makeDeal(contact.id, value, { status: "WON", updatedAt: new Date("2026-03-01") });
    expect((await identify(channel, await makeSession(channel.id), value)).dealId).toBe(recentOpen.id);

    const channel2 = await makeChannel({ identity: { matchField: dealMatch() } });
    const contact2 = await makeContact("Sem aberto");
    const value2 = uid("val");
    await makeDeal(contact2.id, value2, { status: "LOST", updatedAt: new Date("2026-01-01") });
    const recent = await makeDeal(contact2.id, value2, { status: "WON", updatedAt: new Date("2026-02-01") });
    expect((await identify(channel2, await makeSession(channel2.id), value2)).dealId).toBe(recent.id);
  });

  it("contato com dois negócios: ref e S2S usam o negócio encontrado, não o aberto mais recente", async () => {
    const refField = await base.customField.create({
      data: { organizationId: orgId, name: uid("ref"), number: ++seq + 100, label: "Ref", type: "TEXT", entity: "deal" },
      select: { id: true },
    });
    const channel = await makeChannel({
      identity: { matchField: dealMatch() },
      refDealCustomFieldId: refField.id,
    });
    const contact = await makeContact("Vários negócios");
    const value = uid("val");
    const found = await makeDeal(contact.id, value, { updatedAt: new Date("2026-01-01") });
    const newer = await makeDeal(contact.id, null, { updatedAt: new Date("2026-06-01") });

    const session = await makeSession(channel.id);
    await identify(channel, session, value);
    const ref = uid("ref");
    await sendMessage(channel, session, "com ref", ref);
    const onFound = await base.dealCustomFieldValue.findFirst({
      where: { dealId: found.id, customFieldId: refField.id },
    });
    const onNewer = await base.dealCustomFieldValue.findFirst({
      where: { dealId: newer.id, customFieldId: refField.id },
    });
    expect(onFound?.value).toBe(ref);
    expect(onNewer).toBeNull();

    const { processWebchatS2SIngress } = await import("@/lib/webchat/s2s/ingress");
    const s2s = await inOrg(() =>
      processWebchatS2SIngress(channel, { externalId: value, text: "aviso do site", links: [] } as never),
    );
    expect(s2s.contactId).toBe(contact.id);
    expect(s2s.dealId).toBe(found.id);
    const note = await base.message.findFirst({ where: { id: s2s.noteId! } });
    expect(note?.content).toContain("aviso do site");
    expect(note?.content).toContain("Negócio #");
  });

  it("dois valores no mesmo telefone não compartilham contato nem mensagens no widget", async () => {
    const { listVisitorMessages } = await import("@/lib/webchat/visitor-messages");
    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const contact = await makeContact("Telefone compartilhado", "+5511999990002");
    const a = uid("val");
    const b = uid("val");
    await makeDeal(contact.id, a);
    const dealB = await makeDeal(contact.id, b);

    const sessionA = await makeSession(channel.id);
    const sessionB = await makeSession(channel.id);
    expect((await identify(channel, sessionA, a)).contactId).toBe(contact.id);
    const resB = await identify(channel, sessionB, b, { phone: "+5511999990002" });
    expect(resB.contactId).not.toBe(contact.id);
    expect(resB.dealId).toBe(dealB.id);

    await sendMessage(channel, sessionA, "mensagem de A");
    const sentB = await sendMessage(channel, sessionB, "mensagem de B");
    await new Promise((r) => setTimeout(r, 150));

    const seenByB = await inOrg(() =>
      listVisitorMessages({ contactId: resB.contactId, channelId: channel.id } as never),
    );
    const contents = JSON.stringify(seenByB);
    expect(contents).toContain("mensagem de B");
    expect(contents).not.toContain("mensagem de A");

    // Sem card novo, sem telefone no contato próprio e com nota de possível vínculo.
    const own = await base.contact.findUnique({ where: { id: resB.contactId }, select: { phone: true } });
    expect(own?.phone).toBeNull();
    expect(await base.deal.count({ where: { contactId: resB.contactId } })).toBe(0);
    const note = await base.message.findFirst({
      where: { conversationId: sentB.conversationId, isPrivate: true, content: { contains: "possível vínculo" } },
    });
    expect(note).not.toBeNull();

    // Volta do segundo: cai no contato próprio, não no do telefone.
    expect((await identify(channel, await makeSession(channel.id), b)).contactId).toBe(resB.contactId);
  });

  it("dois identifies simultâneos de valores diferentes no mesmo contato: só um fica", async () => {
    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const contact = await makeContact("Corrida");
    const a = uid("val");
    const b = uid("val");
    await makeDeal(contact.id, a);
    await makeDeal(contact.id, b);
    const [ra, rb] = await Promise.all([
      identify(channel, await makeSession(channel.id), a),
      identify(channel, await makeSession(channel.id), b),
    ]);
    expect([ra.contactId, rb.contactId].filter((id) => id === contact.id)).toHaveLength(1);
  });

  it("valor não encontrado: fica no contato do visitante e o negócio automático recebe o valor", async () => {
    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const session = await makeSession(channel.id);
    const value = uid("val");
    const res = await identify(channel, session, value);
    expect(res.dealId).toBeNull();
    await sendMessage(channel, session);
    await new Promise((r) => setTimeout(r, 300));
    const row = await base.dealCustomFieldValue.findFirst({
      where: { customFieldId: fieldId, value },
      select: { deal: { select: { id: true, contactId: true } } },
    });
    expect(row?.deal.contactId).toBe(res.contactId);
    const again = await identify(channel, await makeSession(channel.id), value);
    expect(again.contactId).toBe(res.contactId);
    expect(again.dealId).toBe(row?.deal.id);
  });

  it("negócio sem contato: não quebra e passa para o contato do visitante", async () => {
    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const value = uid("val");
    const deal = await makeDeal(null, value);
    const res = await identify(channel, await makeSession(channel.id), value);
    expect(res.dealId).toBe(deal.id);
    const row = await base.deal.findUnique({ where: { id: deal.id }, select: { contactId: true } });
    expect(row?.contactId).toBe(res.contactId);
  });

  it("isolamento: valor igual em outra organização não liga, nem pelo campo dela", async () => {
    const otherField = await base.customField.create({
      data: { organizationId: otherOrgId, name: uid("campo"), label: "Outro", type: "TEXT", entity: "deal" },
      select: { id: true },
    });
    const pipeline = await base.pipeline.create({
      data: { organizationId: otherOrgId, name: "Funil B", slug: uid("funil-") },
      select: { id: true },
    });
    const stage = await base.stage.create({
      data: { organizationId: otherOrgId, name: "E", slug: "e", number: 1, position: 0, pipelineId: pipeline.id },
      select: { id: true },
    });
    const otherContact = await makeContact("De outra org", undefined, otherOrgId);
    const value = uid("val");
    await makeDeal(otherContact.id, value, { org: otherOrgId, stage: stage.id, field: otherField.id });

    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const res = await identify(channel, await makeSession(channel.id), value);
    expect(res.contactId).not.toBe(otherContact.id);
    expect(res.dealId).toBeNull();

    // Campo de outra org configurado no canal cai no externalId e não enxerga o negócio.
    const crossed = await makeChannel({
      identity: { matchField: { type: "dealCustomField", customFieldId: otherField.id, normalize: "none" } },
    });
    const res2 = await identify(crossed, await makeSession(crossed.id), value);
    expect(res2.contactId).not.toBe(otherContact.id);

    const { findDealsByIdentityValue } = await import("@/lib/webchat/deal-identity");
    const leaked = await inOrg(() =>
      findDealsByIdentityValue({ type: "dealCustomField", customFieldId: otherField.id, normalize: "none" }, value),
    );
    expect(leaked).toEqual([]);
  });

  it("destino agente de IA: assume o ticket, vence o 1º atendimento e a Regra 0", async () => {
    const agent = await base.user.create({
      data: { name: "Agente", email: `${uid("ag")}@t.test`, organizationId: orgId, type: "AI" },
      select: { id: true },
    });
    await base.aIAgentConfig.create({
      data: {
        organizationId: orgId,
        userId: agent.id,
        systemPromptTemplate: "x",
        active: true,
        engine: "simple",
      } as never,
    });
    const channel = await makeChannel({
      identity: { matchField: dealMatch() },
      routing: { destination: { type: "ai_agent", id: agent.id } },
    });
    const contact = await makeContact("Com IA");
    const value = uid("val");
    await makeDeal(contact.id, value);
    const session = await makeSession(channel.id);
    await identify(channel, session, value);
    const sent = await sendMessage(channel, session);
    const conv = await base.conversation.findUnique({
      where: { id: sent.conversationId },
      select: { assignedToId: true, assignedVia: true, routedAt: true },
    });
    expect(conv?.assignedToId).toBe(agent.id);
    expect(conv?.routedAt).not.toBeNull();
    expect(h.onInboundMessageForAi).toHaveBeenCalled();
  });

  it("agente apagado: cai na alternativa sem quebrar", async () => {
    const dept = await base.department.create({
      data: { organizationId: orgId, name: uid("Depto "), number: ++seq + 500 },
      select: { id: true },
    });
    const channel = await makeChannel({
      identity: { matchField: dealMatch() },
      routing: {
        destination: { type: "ai_agent", id: "apagado" },
        fallback: { type: "department", id: dept.id },
      },
    });
    const session = await makeSession(channel.id);
    await identify(channel, session, uid("val"));
    const sent = await sendMessage(channel, session);
    const conv = await base.conversation.findUnique({
      where: { id: sent.conversationId },
      select: { departmentId: true, routeMode: true, assignedToId: true },
    });
    expect(conv?.departmentId).toBe(dept.id);
    expect(conv?.routeMode).toBe("human");
    expect(conv?.assignedToId).toBeNull();
    await base.conversation.update({ where: { id: sent.conversationId }, data: { departmentId: null } });
    await base.department.delete({ where: { id: dept.id } });
  });

  it("sem assinatura nada liga; visitante não verificado não tem atendimento nem prioridade", async () => {
    const channel = await makeChannel({
      identity: { matchField: dealMatch() },
      routing: { priority: "high" },
    });
    const contact = await makeContact("Dono do negócio");
    await makeDeal(contact.id, uid("val"));
    const session = await makeSession(channel.id);
    const sent = await sendMessage(channel, session);
    expect(sent.contactId).not.toBe(contact.id);
    const conv = await base.conversation.findUnique({
      where: { id: sent.conversationId },
      select: { priorityAt: true, routedAt: true },
    });
    expect(conv?.priorityAt).toBeNull();
    expect(conv?.routedAt).toBeNull();
  });

  it("prioridade alta: topo do inbox, cursor intacto, termina na resposta humana e ao encerrar", async () => {
    const { getConversations } = await import("@/services/conversations");
    const channel = await makeChannel({
      identity: { matchField: dealMatch() },
      routing: { priority: "high" },
    });
    const session = await makeSession(channel.id);
    await identify(channel, session, uid("val"));
    const sent = await sendMessage(channel, session);
    const priorityId = sent.conversationId;

    // Mais novas que a prioritária: na ordem normal ela não seria a primeira.
    for (let i = 0; i < 3; i++) {
      const c = await makeContact(`Normal ${i}`);
      await base.conversation.create({
        data: {
          organizationId: orgId,
          number: ++seq * 13 + 3000,
          channel: "webchat",
          channelId: channel.id,
          contactId: c.id,
          status: "OPEN",
          lastMessageAt: new Date(Date.now() + 60_000 * (i + 1)),
        },
      });
    }

    const first = await inOrg(() => getConversations({ perPage: 2 }));
    expect(first.items[0]?.id).toBe(priorityId);
    expect((first.items[0] as { priorityAt?: Date | null }).priorityAt).toBeTruthy();
    expect(first.items.filter((i) => i.id === priorityId)).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const next = await inOrg(() => getConversations({ perPage: 200, cursor: first.nextCursor! }));
    const seen = new Set(first.items.map((i) => i.id));
    expect(next.items.some((i) => seen.has(i.id) && i.id !== priorityId)).toBe(false);

    await base.conversation.update({ where: { id: priorityId }, data: { hasHumanReply: true } });
    const after = await inOrg(() => getConversations({ perPage: 200 }));
    const row = after.items.find((i) => i.id === priorityId) as { priorityAt?: Date | null } | undefined;
    expect(row?.priorityAt).toBeNull();
    expect(after.items[0]?.id).not.toBe(priorityId);

    await base.conversation.update({
      where: { id: priorityId },
      data: { hasHumanReply: false, status: "RESOLVED", closedAt: new Date() },
    });
    const closed = await inOrg(() => getConversations({ perPage: 200 }));
    expect(closed.items[0]?.id).not.toBe(priorityId);
  });

  it("a consulta das prioritárias usa o índice parcial", async () => {
    const text = await base.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const plan = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`
        EXPLAIN SELECT c.id FROM conversations c
        WHERE c."organizationId" = '${orgId}' AND c."priorityAt" IS NOT NULL
          AND c.status = 'OPEN' AND c."hasHumanReply" = false
        ORDER BY c."priorityAt" ASC, c.id ASC LIMIT 50
      `);
      return plan.map((p) => p["QUERY PLAN"]).join("\n");
    });
    expect(text).toContain("conversations_active_priority_idx");
  });

  it("canal sem a configuração: identificado não ganha prioridade nem roteamento", async () => {
    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const session = await makeSession(channel.id);
    await identify(channel, session, uid("val"));
    const sent = await sendMessage(channel, session);
    const conv = await base.conversation.findUnique({
      where: { id: sent.conversationId },
      select: { priorityAt: true, routedAt: true, routeMode: true, assignedVia: true },
    });
    expect(conv).toEqual({ priorityAt: null, routedAt: null, routeMode: null, assignedVia: null });
  });

  it("S2S: valor novo cria contato e devolve o negócio quando há", async () => {
    const { processWebchatS2SIngress } = await import("@/lib/webchat/s2s/ingress");
    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const value = uid("val");
    const created = await inOrg(() =>
      processWebchatS2SIngress(channel, { externalId: value, text: "novo", links: [] } as never),
    );
    expect(created.contactCreated).toBe(true);
    expect(created.dealId).toBeNull();
    const again = await inOrg(() =>
      processWebchatS2SIngress(channel, { externalId: value, text: "de novo", links: [] } as never),
    );
    expect(again.contactId).toBe(created.contactId);
    expect(again.contactCreated).toBe(false);
  });

  it("merge de contatos leva o valor verificado junto", async () => {
    const { mergeContacts } = await import("@/services/merge-contacts");
    const channel = await makeChannel({ identity: { matchField: dealMatch() } });
    const keep = await makeContact("Fica");
    const value = uid("val");
    const res = await identify(channel, await makeSession(channel.id), value);
    await inOrg(() => mergeContacts(keep.id, res.contactId));
    const link = await base.webchatIdentityLink.findFirst({ where: { channelId: channel.id, value } });
    expect(link?.contactId).toBe(keep.id);
  });
});
