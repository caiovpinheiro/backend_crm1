import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Worker da agenda (`processAgendaV2`): o que sai, por onde, e o que para.
 * As regras em si estão em agenda.test.ts; aqui é o caminho com o banco e o
 * envio simulados. Nada vai para o WhatsApp.
 */

type Db = {
  tableOk: boolean;
  config: Record<string, unknown>;
  conv: Record<string, unknown> | null;
  state: Record<string, unknown> | null;
  inbound: Array<{ content: string; createdAt: Date }>;
  human: number;
  automation?: number;
  deal: Record<string, unknown> | null;
  sent24h: number;
  templates: Array<Record<string, unknown>>;
  due: Array<Record<string, unknown>>;
};

const mocks = vi.hoisted(() => ({
  db: {} as Db,
  claims: new Map<string, number>(),
  exec: [] as Array<{ sql: string; params: unknown[] }>,
  sendText: vi.fn(async (_a: Record<string, unknown>) => ({ sent: true } as { sent: boolean; reason?: string })),
  sendTemplate: vi.fn(async (_a: Record<string, unknown>) => ({ ok: true, externalId: "wamid", messageId: "msg-tpl" } as Record<string, unknown>)),
  logTurn: vi.fn(async (_a: Record<string, unknown>) => undefined),
  createActivity: vi.fn(async (_a: Record<string, unknown>) => ({ id: "act-1" })),
  convUpdateMany: vi.fn(async (_a: Record<string, unknown>) => ({ count: 1 })),
  upsertState: vi.fn(async (_a: Record<string, unknown>) => ({})),
  handoff: vi.fn(async (_a: Record<string, unknown>) => undefined),
}));

function queryRaw(sql: string): unknown[] {
  const d = mocks.db;
  if (sql.includes("to_regclass")) return [{ ok: d.tableOk }];
  if (sql.includes("jsonb_typeof")) return [];
  if (sql.includes(`WHERE "status" = 'PENDING' AND "dueAt" <= $1`)) return d.due;
  if (sql.includes(`SELECT "active", "simpleConfig", "userId"`)) return [{ active: true, simpleConfig: d.config, userId: "ai-1" }];
  if (sql.includes(`SELECT "simpleConfig" FROM "ai_agent_configs"`)) return [{ simpleConfig: d.config }];
  if (sql.includes(`LEFT JOIN "channels" ch`)) return d.conv ? [d.conv] : [];
  if (sql.includes(`FROM "ai_simple_conversation_states"`)) return d.state ? [d.state] : [];
  if (sql.includes(`m."direction" = 'in'`)) return d.inbound;
  if (sql.includes(`"authorType" = 'human'`)) return [{ n: d.human }];
  if (sql.includes(`"aiAgentUserId" IS NULL`)) return [{ n: d.automation ?? 0 }];
  if (sql.includes(`FROM "deals" WHERE "id"`)) return d.deal ? [d.deal] : [];
  if (sql.includes(`COUNT(*)::int AS n FROM "ai_v2_scheduled_sends"`)) return [{ n: d.sent24h }];
  if (sql.includes(`FROM "whatsapp_template_configs"`)) return d.templates;
  if (sql.includes(`SELECT "id" FROM "messages"`)) return [{ id: "msg-new" }];
  return [];
}

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    $queryRawUnsafe: vi.fn(async (sql: string) => queryRaw(sql)),
    $executeRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      mocks.exec.push({ sql, params });
      if (sql.includes(`SET "status" = 'SENDING'`)) {
        const id = String(params[0]);
        const n = mocks.claims.get(id) ?? 0;
        mocks.claims.set(id, n + 1);
        return n === 0 ? 1 : 0; // só a primeira passada recebe a linha
      }
      return 1;
    }),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { conversation: { updateMany: mocks.convUpdateMany } } }));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("@/lib/webhook-context", () => ({ withSystemContext: async (_org: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/services/ai/agent-key", () => ({ tryGetAgentApiKey: async () => null }));
vi.mock("@/services/ai/phone-allowlist", () => ({
  normalizePhoneDigits: (p: string) => p.replace(/\D/g, ""),
  phoneMatchesAllowlist: (phone: string, set: Set<string>) => set.has(phone.replace(/\D/g, "")),
}));
vi.mock("@/services/activities", () => ({ createActivity: mocks.createActivity }));
vi.mock("../actions", () => ({
  sendV2TextMessage: mocks.sendText,
  sendV2WhatsappTemplate: mocks.sendTemplate,
  v2HumanBehavior: () => ({ simulateTyping: false }),
}));
vi.mock("../log", () => ({ logV2Turn: mocks.logTurn }));
vi.mock("../state", () => ({ upsertV2ConversationState: mocks.upsertState }));
vi.mock("../handoff", () => ({ simpleHandoff: mocks.handoff, leadsHandoffOption: () => undefined }));

import { failStaleSending, processAgendaV2, resetAgendaTableCheckForTest } from "../agenda-worker";

const NOW = new Date("2026-11-25T18:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const CONFIG = {
  name: "Agente",
  tone: "Objetivo",
  autonomyMode: "auto",
  scheduling: { enabled: true, fallbackMessage: "Oi @firstName! Combinamos de retomar agora. Podemos continuar?" },
  autoSend: { templates: [{ name: "retomada_atendimento", variables: ["@firstName"] }] },
};

const dueRow = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  organizationId: "org-1",
  conversationId: "conv-1",
  contactId: "ct-1",
  agentId: "agent-1",
  agentUserId: "ai-1",
  kind: "scheduled",
  sequenceId: null,
  stepIndex: null,
  anchorMessageId: null,
  dealId: "deal-1",
  dealStageIdAtCreate: "st-1",
  dueAt: NOW,
  reason: "cliente pediu para falar amanhã",
  resumeContext: "dúvida sobre a inscrição",
  createdAt: ago(20 * HOUR),
  ...over,
});

function setDb(over: Partial<Db> = {}) {
  mocks.db = {
    tableOk: true,
    config: CONFIG,
    conv: { status: "OPEN", assigned_to_id: "ai-1", last_inbound_at: ago(21 * HOUR), channel: "whatsapp", provider: "META_CLOUD_API", contact_name: "Ana Souza", contact_phone: "5511999990000" },
    state: { owner: "agente", stage: "active", closeReason: null },
    inbound: [],
    human: 0,
    deal: { status: "OPEN", stageId: "st-1" },
    sent24h: 0,
    templates: [],
    due: [dueRow()],
    ...over,
  };
}

const finishCalls = () => mocks.exec.filter((e) => e.sql.includes(`WHERE "id" = $1 AND "status" = 'SENDING'`) && e.sql.includes(`"outcome" = $3`));
const lastFinish = () => {
  const f = finishCalls().at(-1);
  return f ? { status: f.params[1], outcome: f.params[2], sentVia: f.params[3], templateName: f.params[4], sentMessageId: f.params[5] } : null;
};

describe("worker da agenda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exec.length = 0;
    mocks.claims.clear();
    resetAgendaTableCheckForTest();
    setDb();
  });

  it("dentro das 24 h: texto (reserva com o primeiro nome), gravado como enviado com o id da mensagem", async () => {
    expect(await processAgendaV2(NOW)).toMatchObject({ sent: 1 });
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.sendText.mock.calls[0][0]).toMatchObject({ conversationId: "conv-1", text: "Oi Ana! Combinamos de retomar agora. Podemos continuar?", channel: "meta" });
    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ status: "SENT", sentVia: "text", sentMessageId: "msg-new" });
    expect(mocks.logTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "scheduled_send", reply: expect.stringContaining("Ana") }));
  });

  it("fora das 24 h: sai o modelo da Meta com as variáveis preenchidas, sem texto livre", async () => {
    setDb({ conv: { ...mocks.db.conv!, last_inbound_at: ago(30 * HOUR) } });
    await processAgendaV2(NOW);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ templateName: "retomada_atendimento", bodyVariables: ["Ana"] }));
    expect(lastFinish()).toMatchObject({ status: "SENT", sentVia: "template", templateName: "retomada_atendimento", sentMessageId: "msg-tpl" });
  });

  it("fora das 24 h sem nenhum modelo possível: não envia e cria tarefa para a equipe", async () => {
    setDb({ config: { ...CONFIG, autoSend: {} }, conv: { ...mocks.db.conv!, last_inbound_at: ago(30 * HOUR) }, templates: [] });
    await processAgendaV2(NOW);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.createActivity).toHaveBeenCalledWith(expect.objectContaining({ type: "TASK", contactId: "ct-1", dealId: "deal-1" }));
    expect(lastFinish()).toMatchObject({ status: "SKIPPED", outcome: "no_template" });
  });

  it("sem modelo configurado, escolhe entre os liberados para agente sem variável", async () => {
    setDb({
      config: { ...CONFIG, autoSend: {} },
      conv: { ...mocks.db.conv!, last_inbound_at: ago(30 * HOUR) },
      templates: [
        { name: "com_variavel", language: "pt_BR", label: "x", bodyPreview: "Oi {{1}}", hasVariables: true },
        { name: "retomada_simples", language: "pt_BR", label: "Retomar atendimento", bodyPreview: "Podemos continuar?", hasVariables: false },
      ],
    });
    await processAgendaV2(NOW);
    expect(mocks.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ templateName: "retomada_simples", bodyVariables: [] }));
  });

  it("canal WhatsApp QR (Baileys): texto mesmo fora das 24 h", async () => {
    setDb({ conv: { ...mocks.db.conv!, provider: "BAILEYS_MD", last_inbound_at: ago(30 * HOUR) } });
    await processAgendaV2(NOW);
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({ channel: "baileys" }));
    expect(mocks.sendTemplate).not.toHaveBeenCalled();
  });

  it("cliente voltou a escrever: cancela; \"ok, obrigado\" depois de agendar não cancela", async () => {
    setDb({ inbound: [{ content: "consegui fazer sozinho, valeu", createdAt: ago(HOUR) }] });
    await processAgendaV2(NOW);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ status: "CANCELLED", outcome: "client_replied" });

    vi.clearAllMocks();
    mocks.claims.clear();
    setDb({ inbound: [{ content: "ok, obrigado!", createdAt: ago(19 * HOUR) }] });
    await processAgendaV2(NOW);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
  });

  it("pessoa assumiu, negócio ganho, pedido para parar, agente desligado: cancela sem enviar", async () => {
    const cases: Array<[Partial<Db>, string]> = [
      [{ human: 1 }, "human"],
      [{ conv: { ...mocks.db.conv!, assigned_to_id: "ai-2", assigned_to_type: "AI" } }, "other_agent"],
      [{ deal: { status: "WON", stageId: "st-9" } }, "deal_closed"],
      [{ inbound: [{ content: "pare de mandar mensagem", createdAt: ago(5 * 24 * HOUR) }] }, "opt_out"],
      [{ config: { ...CONFIG, scheduling: { enabled: false } } }, "agent_off"],
      [{ conv: null }, "conversation_missing"],
    ];
    for (const [over, outcome] of cases) {
      vi.clearAllMocks();
      mocks.claims.clear();
      mocks.exec.length = 0;
      setDb(over);
      await processAgendaV2(NOW);
      expect(mocks.sendText, outcome).not.toHaveBeenCalled();
      expect(mocks.sendTemplate, outcome).not.toHaveBeenCalled();
      expect(lastFinish(), outcome).toMatchObject({ status: "CANCELLED", outcome });
    }
  });

  it("agente em teste: número fora da lista não recebe", async () => {
    setDb({ config: { ...CONFIG, allowedPhoneNumbers: ["5511888887777"] } });
    await processAgendaV2(NOW);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ status: "CANCELLED", outcome: "not_allowed" });
  });

  it("conversa com responsável humano que ainda não falou depois do agente: o passo sai (sem a trava de responsável)", async () => {
    setDb({ conv: { ...mocks.db.conv!, assigned_to_id: "pessoa-1", assigned_to_type: "HUMAN" }, state: { owner: "pessoa", stage: "active", closeReason: null } });
    await processAgendaV2(NOW);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.sendText.mock.calls[0][0]).toMatchObject({ bypassAssignee: true });
    expect(lastFinish()).toMatchObject({ status: "SENT" });
    // A consulta de "pessoa falou" conta só o que veio depois da última mensagem do agente.
    const { prismaBase } = await import("@/lib/prisma-base");
    const sqls = (prismaBase.$queryRawUnsafe as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(sqls.find((q) => q.includes(`"authorType" = 'human'`))).toContain(`a."aiAgentUserId" = $3`);
  });

  it("planejamento da régua: o agente vem da última mensagem enviada; responsável humano não exclui, outro agente de IA sim", async () => {
    setDb({ due: [] });
    await processAgendaV2(NOW);
    const { prismaBase } = await import("@/lib/prisma-base");
    const planSql = (prismaBase.$queryRawUnsafe as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).find((q) => q.includes("followUpSequences"));
    expect(planSql).toBeDefined();
    expect(planSql).toContain(`JOIN "users" u ON u."id" = last_out."aiAgentUserId"`);
    expect(planSql).toContain(`assignee."type" IS DISTINCT FROM 'AI'`);
    expect(planSql).not.toContain(`s."owner" <> 'pessoa'`);
  });

  it("automações e campanhas contam no teto do dia: o passo fica para o dia seguinte, não é cancelado", async () => {
    setDb({ sent24h: 1, automation: 1 });
    await processAgendaV2(NOW);
    expect(mocks.sendText).not.toHaveBeenCalled();
    const resched = mocks.exec.find((e) => e.sql.includes(`SET "status" = 'PENDING', "dueAt" = $2`));
    expect(resched).toBeDefined();
    expect((resched!.params[1] as Date).getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 24 * HOUR);
  });

  it("teto de envios automáticos em 24 h", async () => {
    setDb({ sent24h: 2 });
    await processAgendaV2(NOW);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ status: "CANCELLED", outcome: "daily_cap" });
  });

  it("ticket encerrado pelo próprio agente: envia e reabre com o agente; encerrado por transferência, não", async () => {
    setDb({ conv: { ...mocks.db.conv!, status: "RESOLVED" }, state: { owner: "ninguem", stage: "closed", closeReason: "inactivity" } });
    await processAgendaV2(NOW);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.convUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "conv-1", status: "RESOLVED" }, data: { status: "OPEN", closedAt: null } }));
    expect(mocks.upsertState).toHaveBeenCalledWith(expect.objectContaining({ stage: "active", owner: "agente" }));

    vi.clearAllMocks();
    mocks.claims.clear();
    setDb({ conv: { ...mocks.db.conv!, status: "RESOLVED" }, state: { owner: "ninguem", stage: "closed", closeReason: "transferred" } });
    await processAgendaV2(NOW);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.convUpdateMany).not.toHaveBeenCalled();
  });

  it("envio recusado pelo canal: falha registrada, sem reabrir e sem tentar de novo", async () => {
    setDb({ conv: { ...mocks.db.conv!, status: "RESOLVED" }, state: { owner: "ninguem", stage: "closed", closeReason: "inactivity" } });
    mocks.sendText.mockResolvedValueOnce({ sent: false, reason: "near_duplicate" });
    await processAgendaV2(NOW);
    expect(lastFinish()).toMatchObject({ status: "FAILED", outcome: "send_failed" });
    expect(mocks.convUpdateMany).not.toHaveBeenCalled();
  });

  it("duas passadas ao mesmo tempo: a mensagem sai uma vez só", async () => {
    await Promise.all([processAgendaV2(NOW), processAgendaV2(NOW)]);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    // A mesma linha vencida de novo (já reservada): nada.
    await processAgendaV2(NOW);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
  });

  it("envio que caiu no meio (SENDING parado) vira FAILED — nunca volta a PENDING", async () => {
    await failStaleSending(NOW);
    const stale = mocks.exec.find((e) => e.sql.includes(`"status" = 'SENDING' AND "updatedAt" < $1`));
    expect(stale?.sql).toContain(`SET "status" = 'FAILED'`);
    expect(stale?.sql).not.toContain(`'PENDING'`);
    expect(stale?.params[0]).toEqual(new Date(NOW.getTime() - 10 * 60_000));
  });

  it("sem a tabela no banco (código antes da migration): não faz nada", async () => {
    setDb({ tableOk: false });
    expect(await processAgendaV2(NOW)).toEqual({ planned: 0, sent: 0, cancelled: 0 });
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.exec).toHaveLength(0);
  });

  it("follow-up: passo com texto fixo; etapa mudou → para", async () => {
    const seqConfig = {
      name: "Agente",
      tone: "Objetivo",
      autonomyMode: "auto",
      followUpSequences: [{ id: "seq-1", name: "Inscrição", dealStages: ["st-1"], steps: [{ after: 60, message: "Conseguiu ver a inscrição, @firstName?" }] }],
    };
    setDb({ config: seqConfig, due: [dueRow({ kind: "followup", sequenceId: "seq-1", stepIndex: 0, anchorMessageId: "m-1" })] });
    await processAgendaV2(NOW);
    expect(mocks.sendText.mock.calls[0][0]).toMatchObject({ text: "Conseguiu ver a inscrição, Ana?" });
    expect(mocks.logTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "followup" }));

    vi.clearAllMocks();
    mocks.claims.clear();
    setDb({ config: seqConfig, deal: { status: "OPEN", stageId: "st-2" }, due: [dueRow({ kind: "followup", sequenceId: "seq-1", stepIndex: 0, anchorMessageId: "m-1" })] });
    await processAgendaV2(NOW);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ status: "CANCELLED", outcome: "stage_changed" });
  });
});
