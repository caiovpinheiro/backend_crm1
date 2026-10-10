import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Executores de ação do motor v2 que não tinham teste: cada ação do
 * modelo ou do atalho, o que ela faz no CRM e como falha. Sem regra de
 * produto: tudo vem da configuração do agente e dos parâmetros da ação.
 */

const mocks = vi.hoisted(() => ({
  sendAgentMessage: vi.fn(async (_args: Record<string, unknown>): Promise<{ status?: string; reason?: string } | undefined> => ({ status: "sent" })),
  applyTag: vi.fn(async (_args: Record<string, unknown>) => true),
  createDeal: vi.fn(async (_args: Record<string, unknown>): Promise<{ id: string }> => ({ id: "deal-new" })),
  updateDeal: vi.fn(async (_id: string, _data: Record<string, unknown>) => ({})),
  createActivity: vi.fn(async (_args: Record<string, unknown>): Promise<{ id: string }> => ({ id: "act-1" })),
  gapFindFirst: vi.fn(async (_args: unknown): Promise<{ id: string; frequency: number } | null> => null),
  gapUpdate: vi.fn(async (_args: unknown) => undefined),
  gapCreate: vi.fn(async (_args: unknown) => undefined),
  surveyCreate: vi.fn(async (_args: unknown) => ({})),
  conversationUpdate: vi.fn(async (_args: unknown) => ({})),
  conversationFindUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
  contactUpdate: vi.fn(async (_args: unknown) => ({})),
  contactFindUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
  messageCreate: vi.fn(async (_args: unknown) => ({ id: "msg-1", content: "x", createdAt: new Date("2026-03-10T15:00:00Z") })),
  tplConfigFindFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
  metaClient: vi.fn((_cfg: unknown): Record<string, unknown> => ({ configured: false })),
  enrichTemplate: vi.fn(async (): Promise<{ components: unknown; flowToken: string | null }> => ({ components: undefined, flowToken: null })),
  queryRaw: vi.fn(async (_sql: string, ..._params: unknown[]): Promise<unknown[]> => []),
  sendFollowUpMedia: vi.fn(async (_args: Record<string, unknown>) => 1),
  publishNewMessage: vi.fn(),
  touchLastMessage: vi.fn(async () => undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { update: mocks.conversationUpdate, findUnique: mocks.conversationFindUnique },
    contact: { update: mocks.contactUpdate, findUnique: mocks.contactFindUnique },
    message: { create: mocks.messageCreate },
    whatsAppTemplateConfig: { findFirst: mocks.tplConfigFindFirst },
    aIV2KnowledgeGap: { findFirst: mocks.gapFindFirst, update: mocks.gapUpdate, create: mocks.gapCreate },
    aIAgentSurveyResponse: { create: mocks.surveyCreate },
  },
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: { $queryRawUnsafe: mocks.queryRaw, $executeRawUnsafe: vi.fn(async () => 0) } }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (data: Record<string, unknown>) => ({ organizationId: "org-1", ...data }) }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrNull: () => "org-1", getOrgIdOrThrow: () => "org-1" }));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("@/lib/conversation-last-message", () => ({ touchConversationLastMessageAt: mocks.touchLastMessage }));
vi.mock("@/lib/realtime-events", () => ({ publishNewMessage: mocks.publishNewMessage }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/ai/send-agent-message", () => ({ sendAgentMessage: mocks.sendAgentMessage }));
vi.mock("@/services/ai/send-agent-media", () => ({
  sendAgentFollowUpMedia: mocks.sendFollowUpMedia,
  mediaNotSentTrace: (what: string) => `${what} não enviados`,
}));
vi.mock("@/services/tags", () => ({ applyExistingTagToContact: mocks.applyTag }));
vi.mock("@/services/deals", () => ({ createDeal: mocks.createDeal, updateDeal: mocks.updateDeal }));
vi.mock("@/services/activities", () => ({ createActivity: mocks.createActivity }));
vi.mock("@/lib/meta-whatsapp/client", () => ({ metaClientFromConfig: mocks.metaClient }));
vi.mock("@/lib/meta-whatsapp/enrich-template-flow", () => ({ enrichTemplateComponentsForFlowSend: mocks.enrichTemplate }));
vi.mock("../handoff", () => ({ simpleHandoff: vi.fn(async () => undefined) }));
vi.mock("../sent-materials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sent-materials")>()),
  lastV2ResetAt: vi.fn(async () => null),
}));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2Action, V2AgentConfig, V2LLMOutput } from "@/lib/ai-v2/types";
import { applyV2ClosureFieldUpdates, executeV2Actions } from "../actions";
import { attachmentsBlockedByResend } from "../material-attachments";

const config = (over: Record<string, unknown> = {}): V2AgentConfig =>
  normalizeV2Config({
    name: "Agente",
    tone: "Objetivo",
    contextFields: {
      contact: [{ key: "email", label: "E-mail", permissions: ["read", "write"] }, { key: "name", label: "Nome", permissions: ["read"] }],
      deal: [{ key: "value", label: "Valor", permissions: ["read", "write"] }],
    },
    ...over,
  });

function ctx(over: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    conversationId: "conv-1",
    contactId: "contact-1",
    dealId: "deal-1",
    agentUserId: "user-1",
    agentId: "agent-1",
    config: config(),
    context: { contact: { name: "Ana" }, selectedDeal: { title: "Contrato" } } as never,
    llmOutput: { collected: { produto: "plano B" } } as unknown as V2LLMOutput,
    channel: "meta",
    autonomyMode: "AUTONOMOUS" as const,
    ...over,
  };
}

const run = (action: V2Action, c = ctx()) => executeV2Actions([action], c as never).then((r) => r.results[0]);

describe("executores de ação", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendAgentMessage.mockResolvedValue({ status: "sent" });
    mocks.applyTag.mockResolvedValue(true);
    mocks.createDeal.mockResolvedValue({ id: "deal-new" });
    mocks.createActivity.mockResolvedValue({ id: "act-1" });
    mocks.gapFindFirst.mockResolvedValue(null);
    mocks.conversationFindUnique.mockResolvedValue(null);
    mocks.contactFindUnique.mockResolvedValue(null);
    mocks.tplConfigFindFirst.mockResolvedValue(null);
    mocks.metaClient.mockReturnValue({ configured: false });
    mocks.queryRaw.mockResolvedValue([]);
    mocks.sendFollowUpMedia.mockResolvedValue(1);
  });

  it("add_tag: aplica etiqueta existente; sem contato, sem nome ou etiqueta inexistente falha sem exceção", async () => {
    expect(await run({ type: "add_tag", tag: "VIP" })).toMatchObject({ ok: true, applied: true });
    expect(mocks.applyTag).toHaveBeenCalledWith({ contactId: "contact-1", tagName: "VIP", source: "ai-v2" });
    mocks.applyTag.mockResolvedValue(false);
    expect(await run({ type: "add_tag", tag: "Inexistente" })).toMatchObject({ ok: false, applied: false });
    expect(await run({ type: "add_tag", tag: "VIP" }, ctx({ contactId: undefined }))).toMatchObject({ ok: false, error: "No contact" });
    expect(await run({ type: "add_tag" })).toMatchObject({ ok: false, error: "Missing tag" });
    mocks.applyTag.mockRejectedValue(new Error("db"));
    expect(await run({ type: "add_tag", tag: "VIP" })).toMatchObject({ ok: false, error: "db" });
  });

  it("create_deal: cria aberto para o contato com o título e a etapa pedidos; sem contato falha", async () => {
    expect(await run({ type: "create_deal", title: "Renovação", stageId: "st-2" })).toMatchObject({ ok: true, dealId: "deal-new" });
    expect(mocks.createDeal).toHaveBeenCalledWith({ title: "Renovação", contactId: "contact-1", stageId: "st-2", status: "OPEN" });
    expect(await run({ type: "create_deal" })).toMatchObject({ ok: true });
    expect(mocks.createDeal).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Novo negócio", stageId: undefined }));
    expect(await run({ type: "create_deal" }, ctx({ contactId: undefined }))).toMatchObject({ ok: false, error: "No contact" });
  });

  it("move_stage: move o negócio da conversa; sem negócio ou sem etapa falha", async () => {
    expect(await run({ type: "move_stage", stageId: "st-9" })).toMatchObject({ ok: true });
    expect(mocks.updateDeal).toHaveBeenCalledWith("deal-1", { stageId: "st-9" });
    expect(await run({ type: "move_stage" })).toMatchObject({ ok: false, error: "Missing stageId" });
    expect(await run({ type: "move_stage", stageId: "st-9" }, ctx({ dealId: undefined }))).toMatchObject({ ok: false, error: "No deal" });
  });

  it("create_activity: registra no contato e no negócio, tipo NOTE por padrão", async () => {
    expect(await run({ type: "create_activity", content: "Ligar amanhã", activityType: "CALL" })).toMatchObject({ ok: true, activityId: "act-1" });
    expect(mocks.createActivity).toHaveBeenCalledWith({ content: "Ligar amanhã", contactId: "contact-1", dealId: "deal-1", type: "CALL" });
    await run({ type: "create_activity", content: "Anotação" });
    expect(mocks.createActivity).toHaveBeenLastCalledWith(expect.objectContaining({ type: "NOTE" }));
    expect(await run({ type: "create_activity", content: "x" }, ctx({ contactId: undefined }))).toMatchObject({ ok: false, error: "No contact" });
  });

  it("close_conversation: só registra a tabulação quando vem; o encerramento é do motor", async () => {
    const r = await executeV2Actions([{ type: "close_conversation", reason: "resolved", tabulationId: "tab-1" }], ctx() as never);
    expect(r.anyClose).toBe(true);
    expect(r.results[0]).toMatchObject({ ok: true, reason: "resolved" });
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({ where: { id: "conv-1" }, data: { tabulationId: "tab-1" } });
    mocks.conversationUpdate.mockClear();
    expect(await run({ type: "close_conversation" })).toMatchObject({ ok: true, reason: "resolved" });
    expect(mocks.conversationUpdate).not.toHaveBeenCalled();
  });

  it("tabulate_conversation: grava a tabulação; sem id falha; erro do banco vira falha da ação", async () => {
    expect(await run({ type: "tabulate_conversation", tabulationId: "tab-2" })).toMatchObject({ ok: true, tabulationId: "tab-2" });
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({ where: { id: "conv-1" }, data: { tabulationId: "tab-2" } });
    expect(await run({ type: "tabulate_conversation" })).toMatchObject({ ok: false, error: "Missing tabulationId" });
    mocks.conversationUpdate.mockRejectedValueOnce(new Error("db"));
    expect(await run({ type: "tabulate_conversation", tabulationId: "tab-2" })).toMatchObject({ ok: false, error: "db" });
  });

  it("set_theme, set_variable, no_reply e ask_with_options devolvem o dado para o motor sem tocar no CRM", async () => {
    const r = await executeV2Actions([
      { type: "set_theme", themeId: "t-1" },
      { type: "set_variable", key: "plano", value: "B" },
      { type: "no_reply" },
      { type: "ask_with_options", options: ["Sim", "Não"] },
    ], ctx() as never);
    expect(r.themeId).toBe("t-1");
    expect(r.askOptions).toEqual(["Sim", "Não"]);
    expect(r.results.map((x) => x.ok)).toEqual([true, true, true, true]);
    expect(r.results[1]).toMatchObject({ key: "plano", value: "B" });
    expect(r.anyHandoff).toBe(false);
    expect(r.anyClose).toBe(false);
    expect(await run({ type: "ask_with_options" })).toMatchObject({ ok: true, options: [] });
  });

  it("record_knowledge_gap: pergunta nova cria; repetida soma a frequência; sem pergunta falha", async () => {
    expect(await run({ type: "record_knowledge_gap", question: "Qual o prazo de entrega?", themeId: "t-1" })).toMatchObject({ ok: true });
    expect(mocks.gapCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ organizationId: "org-1", agentId: "agent-1", question: "Qual o prazo de entrega?" }) }));
    mocks.gapFindFirst.mockResolvedValue({ id: "gap-1", frequency: 2 });
    await run({ type: "record_knowledge_gap", question: "Qual o prazo de entrega?" });
    expect(mocks.gapUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "gap-1" }, data: expect.objectContaining({ frequency: 3 }) }));
    expect(await run({ type: "record_knowledge_gap" })).toMatchObject({ ok: false, error: "Missing question" });
  });

  it("start_survey: sem nota manda a pergunta configurada e marca pendente; com nota registra a resposta; desligada falha", async () => {
    const pending: boolean[] = [];
    const c = ctx({ config: config({ survey: { enabled: true, type: "nps", question: "De 0 a 10, @contact.name?" } }), setSurveyPending: (p: boolean) => pending.push(p) });
    expect(await run({ type: "start_survey" }, c)).toMatchObject({ ok: true });
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1", text: "De 0 a 10, Ana?", autonomyMode: "AUTONOMOUS" }));
    expect(pending).toEqual([true]);

    expect(await run({ type: "start_survey", score: 9, reason: "rápido" }, c)).toMatchObject({ ok: true });
    expect(mocks.surveyCreate).toHaveBeenCalledWith({ data: { organizationId: "org-1", contactId: "contact-1", dealId: "deal-1", agentId: "agent-1", score: 9, reason: "rápido" } });
    expect(pending).toEqual([true, false]);

    expect(await run({ type: "start_survey" })).toMatchObject({ ok: false, error: "Survey disabled" });
    expect(await run({ type: "start_survey" }, ctx({ contactId: undefined }))).toMatchObject({ ok: false, error: "No contact" });
  });

  it("send_message: renderiza variáveis do contato, do negócio e coletadas; aceita 'text' ou 'message'; sem texto falha", async () => {
    expect(await run({ type: "send_message", text: "Oi @contact.name, o @deal.title do @produto." })).toMatchObject({ ok: true });
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Oi Ana, o Contrato do plano B.", channel: "meta", bypassAssigneeCheck: false }));
    expect(await run({ type: "send_message", message: "Pelo atalho." }, ctx({ channel: "baileys", autonomyMode: "DRAFT" }))).toMatchObject({ ok: true });
    expect(mocks.sendAgentMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Pelo atalho.", channel: "baileys", autonomyMode: "DRAFT" }));
    expect(await run({ type: "send_message" })).toMatchObject({ ok: false, error: "Missing message text" });
  });

  it("tipo desconhecido e executor que lança: falha registrada, sem derrubar as demais ações", async () => {
    mocks.applyTag.mockImplementation(async () => { throw new Error("boom"); });
    const r = await executeV2Actions([
      { type: "inexistente" } as unknown as V2Action,
      { type: "add_tag", tag: "VIP" },
      { type: "set_variable", key: "k", value: 1 },
    ], ctx() as never);
    expect(r.results[0]).toMatchObject({ ok: false, error: "Action type inexistente not implemented" });
    expect(r.results[1]).toMatchObject({ ok: false, error: "boom" });
    expect(r.results[2].ok).toBe(true);
  });
});

describe("atualizações de campo no encerramento", () => {
  beforeEach(() => vi.clearAllMocks());

  it("respeita a permissão de escrita do campo, grava no contato e no negócio e relata cada resultado", async () => {
    const cfg = config({
      closure: { fieldUpdates: [
        { entity: "contact", key: "email", value: "a@b.c" },
        { entity: "contact", key: "name", value: "x" },
        { entity: "deal", key: "value", value: "100" },
        { entity: "deal", key: "inexistente", value: "1" },
      ] },
    });
    const r = await applyV2ClosureFieldUpdates(cfg, "contact-1", "deal-1");
    expect(r).toEqual([
      { entity: "contact", field: "email", ok: true },
      { entity: "contact", field: "name", ok: false, error: "read-only" },
      { entity: "deal", field: "value", ok: true },
      { entity: "deal", field: "inexistente", ok: false, error: "read-only" },
    ]);
    expect(mocks.contactUpdate).toHaveBeenCalledWith({ where: { id: "contact-1" }, data: { email: "a@b.c" } });
    expect(mocks.updateDeal).toHaveBeenCalledWith("deal-1", { value: "100" });
  });

  it("sem alvo (negócio ausente) relata; erro do banco vira relato, não exceção; sem configuração não faz nada", async () => {
    const cfg = config({ closure: { fieldUpdates: [{ entity: "deal", key: "value", value: "1" }, { entity: "contact", key: "email", value: "x" }] } });
    mocks.contactUpdate.mockRejectedValueOnce(new Error("db"));
    expect(await applyV2ClosureFieldUpdates(cfg, "contact-1", undefined)).toEqual([
      { entity: "deal", field: "value", ok: false, error: "target not available" },
      { entity: "contact", field: "email", ok: false, error: "db" },
    ]);
    expect(await applyV2ClosureFieldUpdates(config(), "contact-1", "deal-1")).toEqual([]);
  });
});

describe("anexos dos materiais", () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id, docId: "doc-1", url: `https://storage.example/org-1/${id}.pdf`, mimeType: "application/pdf", name: `${id}.pdf`,
    description: "quando pedirem", autoSend: false, resendWindow: "7d", position: 0, createdAt: "2026-03-01T00:00:00Z", ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([]);
    mocks.sendFollowUpMedia.mockResolvedValue(1);
  });

  it("send_material_attachment: sem ids ou anexo inexistente falha; em modo sugestão não envia e devolve o texto", async () => {
    expect(await run({ type: "send_material_attachment" })).toMatchObject({ ok: false, error: "Missing attachmentIds" });
    expect(await run({ type: "send_material_attachment", attachmentIds: ["a-x"] } as V2Action)).toMatchObject({ ok: false, error: "Attachment not found" });
    mocks.queryRaw.mockResolvedValue([row("a-1")]);
    expect(await run({ type: "send_material_attachment", attachmentIds: ["a-1"] } as V2Action, ctx({ autonomyMode: "DRAFT" }))).toMatchObject({ ok: true, mediaSent: 0, text: "quando pedirem" });
    expect(mocks.sendFollowUpMedia).not.toHaveBeenCalled();
  });

  it("send_material_attachment: envia pelo mesmo caminho das mensagens prontas, uma leva por janela de repetição", async () => {
    mocks.queryRaw.mockResolvedValue([row("a-1"), row("a-2", { resendWindow: "always", mimeType: "video/mp4", name: "a-2.mp4", description: "" })]);
    const r = await run({ type: "send_material_attachment", attachmentIds: ["a-1", "a-2"] } as V2Action);
    expect(r).toMatchObject({ ok: true, mediaSent: 2, text: "quando pedirem\na-2.mp4" });
    expect(mocks.sendFollowUpMedia).toHaveBeenCalledTimes(2);
    const calls = mocks.sendFollowUpMedia.mock.calls.map((c) => c[0] as { attachments: Array<{ name: string }>; since: Date });
    expect(calls[0].attachments.map((a) => a.name)).toEqual(["a-1.pdf"]);
    expect(calls[1].attachments.map((a) => a.name)).toEqual(["a-2.mp4"]);
    // "Sempre" conta só a partir de agora; "7d" olha a semana.
    expect(calls[1].since.getTime()).toBeGreaterThan(calls[0].since.getTime());
  });

  it("trava de reenvio: anexo que já saiu na janela (e não falhou) fica bloqueado; fora da janela ou falho, não", async () => {
    const now = new Date("2026-03-10T15:00:00Z");
    mocks.queryRaw.mockResolvedValue([row("a-1"), row("a-2", { resendWindow: "30m" }), row("a-3")]);
    const { prisma } = await import("@/lib/prisma");
    (prisma as unknown as { message: { findMany: unknown } }).message.findMany = vi.fn(async () => [
      { mediaUrl: "https://storage.example/org-1/a-1.pdf", createdAt: new Date("2026-03-09T15:00:00Z") },
      { mediaUrl: "https://storage.example/org-1/a-2.pdf", createdAt: new Date("2026-03-10T13:00:00Z") },
    ]);
    const blocked = await attachmentsBlockedByResend("agent-1", "conv-1", ["a-1", "a-2", "a-3"], now);
    expect([...blocked]).toEqual(["a-1"]);
    expect(await attachmentsBlockedByResend("agent-1", "conv-1", [], now)).toEqual(new Set());
  });
});

describe("template e flow do WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metaClient.mockReturnValue({ configured: false });
    mocks.conversationFindUnique.mockResolvedValue(null);
  });

  it("send_whatsapp_template: sem nome, conversa inexistente, canal sem API oficial ou contato sem telefone falha com o motivo", async () => {
    expect(await run({ type: "send_whatsapp_template" })).toMatchObject({ ok: false, error: "Missing templateName" });
    expect(await run({ type: "send_whatsapp_template", templateName: "boas_vindas" })).toMatchObject({ ok: false, error: "Conversation not found" });
    mocks.conversationFindUnique.mockResolvedValue({ organizationId: "org-1", channelRef: { config: {} } });
    expect(await run({ type: "send_whatsapp_template", templateName: "boas_vindas" })).toMatchObject({ ok: false, error: "Meta channel not configured" });
    mocks.metaClient.mockReturnValue({ configured: true, sendTemplate: vi.fn() });
    expect(await run({ type: "send_whatsapp_template", templateName: "boas_vindas" })).toMatchObject({ ok: false, error: "Contact without phone" });
  });

  it("send_whatsapp_template: envia pela API, grava a mensagem com o rótulo do template e publica em tempo real", async () => {
    const sendTemplate = vi.fn(async () => ({ messages: [{ id: "wamid.1" }] }));
    mocks.conversationFindUnique.mockResolvedValue({ organizationId: "org-1", channelRef: { config: { token: "x" } } });
    mocks.metaClient.mockReturnValue({ configured: true, sendTemplate });
    mocks.contactFindUnique.mockResolvedValue({ phone: "5511988887777" });
    mocks.tplConfigFindFirst.mockResolvedValue({ id: "tpl-1", metaTemplateId: "123", bodyPreview: "Olá {{1}}, tudo bem?", category: "UTILITY" });
    mocks.enrichTemplate.mockResolvedValue({ components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }], flowToken: null });

    const r = await run({ type: "send_whatsapp_template", templateName: "boas_vindas", bodyVariables: ["Ana"] } as V2Action);

    expect(r).toMatchObject({ ok: true, templateName: "boas_vindas", externalId: "wamid.1" });
    expect(sendTemplate).toHaveBeenCalledWith("5511988887777", "boas_vindas", "pt_BR", expect.any(Array));
    expect(mocks.messageCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ conversationId: "conv-1", direction: "out", messageType: "template", externalId: "wamid.1", aiAgentUserId: "user-1", templateConfigId: "tpl-1" }) });
    expect(String((mocks.messageCreate.mock.calls[0][0] as { data: { content: string } }).data.content)).toContain("Olá Ana, tudo bem?");
    expect(mocks.touchLastMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1" }));
    expect(mocks.publishNewMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1", direction: "out" }));
  });

  it("send_whatsapp_flow: sem id, em modo sugestão ou flow não liberado para o agente falha antes de tocar na API", async () => {
    expect(await run({ type: "send_whatsapp_flow" })).toMatchObject({ ok: false, error: "Missing flowId" });
    expect(await run({ type: "send_whatsapp_flow", flowId: "f-1" }, ctx({ autonomyMode: "DRAFT" }))).toMatchObject({ ok: false, error: expect.stringContaining("Modo sugestão") });
    expect(await run({ type: "send_whatsapp_flow", flowId: "f-1" })).toMatchObject({ ok: false, error: "Flow não liberado para este agente." });
    expect(mocks.conversationFindUnique).not.toHaveBeenCalled();
  });
});
