import { describe, expect, it } from "vitest";

import type { V2AgentConfig, V2FollowUpSequence } from "@/lib/ai-v2/types";
import {
  AGENDA_LATE_GRACE_MS,
  decideAgendaSend,
  followUpKey,
  formatWhen,
  isCourtesyOnly,
  isOptOut,
  matchSequence,
  nextAllowedSlot,
  normalizeSchedule,
  planFollowUp,
  rankTemplates,
  scheduledKey,
  scheduleReplyNote,
  templateCandidates,
  withinWhatsAppWindow,
  type AgendaSnapshot,
} from "../agenda";
import { followUpAnchor } from "../agenda-worker";

const TZ = "America/Sao_Paulo";
// Quarta-feira, 25/11/2026, 15:00 em São Paulo (UTC−3).
const NOW = new Date("2026-11-25T18:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

describe("horário permitido", () => {
  const weekdays8to20 = [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "20:00" }));

  it("sem janela: qualquer hora, inclusive madrugada (o agente atende 24 h)", () => {
    const madrugada = new Date("2026-11-26T06:00:00.000Z"); // 03:00 local
    expect(nextAllowedSlot(madrugada, undefined, TZ)).toEqual(madrugada);
    expect(nextAllowedSlot(madrugada, [], TZ)).toEqual(madrugada);
  });

  it("dentro da janela fica; antes dela vai para o início; depois, para o dia seguinte", () => {
    expect(nextAllowedSlot(NOW, weekdays8to20, TZ)).toEqual(NOW);
    expect(nextAllowedSlot(new Date("2026-11-26T06:00:00.000Z"), weekdays8to20, TZ)).toEqual(new Date("2026-11-26T11:00:00.000Z"));
    expect(nextAllowedSlot(new Date("2026-11-25T23:30:00.000Z"), weekdays8to20, TZ)).toEqual(new Date("2026-11-26T11:00:00.000Z"));
  });

  it("fim de semana sem horário pula para segunda", () => {
    const sabado = new Date("2026-11-28T15:00:00.000Z");
    expect(nextAllowedSlot(sabado, weekdays8to20, TZ)).toEqual(new Date("2026-11-30T11:00:00.000Z"));
  });

  it("janela de 24 h do WhatsApp com folga de 5 min", () => {
    expect(withinWhatsAppWindow(ago(23 * HOUR), NOW)).toBe(true);
    expect(withinWhatsAppWindow(ago(24 * HOUR - 2 * MIN), NOW)).toBe(false);
    expect(withinWhatsAppWindow(null, NOW)).toBe(false);
  });

  it("frase de quando volta", () => {
    expect(formatWhen(ahead(2 * HOUR), NOW, TZ)).toBe("hoje às 17h");
    expect(formatWhen(new Date("2026-11-26T12:30:00.000Z"), NOW, TZ)).toBe("amanhã às 9h30");
    expect(formatWhen(new Date("2026-11-30T12:00:00.000Z"), NOW, TZ)).toBe("na segunda-feira, 30/11, às 9h");
  });
});

describe("pedido de retomada (schedule_message)", () => {
  const cfg = (over: Partial<V2AgentConfig> = {}) => ({
    scheduling: { enabled: true, maxDaysAhead: 7, laterDefaultHours: 3 },
    ...over,
  }) as Pick<V2AgentConfig, "scheduling" | "autoSend" | "businessHours">;

  it("desligado não agenda", () => {
    expect(normalizeSchedule({ at: "2026-11-26T09:00", now: NOW, config: { scheduling: { enabled: false } } })).toEqual({ ok: false, why: "disabled" });
  });

  it("data e hora locais viram o instante no fuso do agente", () => {
    const r = normalizeSchedule({ at: "2026-11-26T09:00", now: NOW, config: cfg() });
    expect(r).toMatchObject({ ok: true, adjusted: false });
    if (r.ok) expect(r.dueAt).toEqual(new Date("2026-11-26T12:00:00.000Z"));
  });

  it("sem hora (\"mais tarde\") = daqui a laterDefaultHours", () => {
    const r = normalizeSchedule({ now: NOW, config: cfg() });
    expect(r.ok && r.dueAt).toEqual(ahead(3 * HOUR));
  });

  it("hora que acabou de passar vira a antecedência mínima; passada há mais de 1 h é erro", () => {
    const r = normalizeSchedule({ at: "2026-11-25T14:45", now: NOW, config: cfg() });
    expect(r.ok && r.dueAt).toEqual(ahead(10 * MIN));
    expect(normalizeSchedule({ at: "2026-11-25T10:00", now: NOW, config: cfg() })).toEqual({ ok: false, why: "past" });
  });

  it("além do teto de dias e data inválida", () => {
    expect(normalizeSchedule({ at: "2026-12-20T09:00", now: NOW, config: cfg() })).toEqual({ ok: false, why: "too_far" });
    expect(normalizeSchedule({ at: "amanhã cedo", now: NOW, config: cfg() })).toEqual({ ok: false, why: "invalid_at" });
  });

  it("fora do horário permitido: vai para a próxima abertura e marca o ajuste", () => {
    const r = normalizeSchedule({
      at: "2026-11-26T06:00",
      now: NOW,
      config: cfg({ autoSend: { sendWindow: [{ day: 4, start: "08:00", end: "20:00" }] } }),
    });
    expect(r).toMatchObject({ ok: true, adjusted: true });
    if (r.ok) expect(r.dueAt).toEqual(new Date("2026-11-26T11:00:00.000Z"));
  });

  it("a resposta só promete o que ficou gravado", () => {
    const ok = { action: { type: "schedule_message" }, ok: true, adjusted: false, whenText: "amanhã às 9h" };
    expect(scheduleReplyNote("Combinado, te chamo amanhã às 9h!", [ok])).toBe("Combinado, te chamo amanhã às 9h!");
    const moved = { ...ok, adjusted: true, whenText: "amanhã às 8h" };
    expect(scheduleReplyNote("Te chamo amanhã às 7h!", [moved])).toBe("Te chamo amanhã às 7h!\n\nCombinado: te chamo amanhã às 8h.");
    const refused = { action: { type: "schedule_message" }, ok: false, error: "schedule_too_far" };
    expect(scheduleReplyNote("Te chamo mês que vem.", [refused])).toMatch(/Não consegui deixar o retorno agendado/);
    expect(scheduleReplyNote("Oi", [])).toBe("Oi");
  });
});

describe("cortesia e pedido para parar", () => {
  it("\"ok\", \"obrigado!\", 👍 e \"combinado, até amanhã\" são cortesia; pergunta não é", () => {
    for (const t of ["ok", "Obrigado!", "👍", "combinado, até amanhã", "blz vlw"]) expect(isCourtesyOnly(t)).toBe(true);
    for (const t of ["qual o valor da mensalidade?", "na verdade prefiro hoje"]) expect(isCourtesyOnly(t)).toBe(false);
  });

  it("pedido para parar, com e sem acento; termos próprios substituem os padrão", () => {
    expect(isOptOut("Por favor PARE DE MANDAR mensagem", undefined)).toBe(true);
    expect(isOptOut("nao quero mais", undefined)).toBe(true);
    expect(isOptOut("quero mais informações", undefined)).toBe(false);
    expect(isOptOut("chega", ["chega"])).toBe(true);
  });
});

const baseSnap = (over: Partial<AgendaSnapshot> = {}): AgendaSnapshot => ({
  kind: "scheduled",
  now: NOW,
  createdAt: ago(20 * HOUR),
  conversation: { status: "OPEN", assignedToId: "ai-1", channelKind: "meta", lastInboundAt: ago(21 * HOUR) },
  agentUserId: "ai-1",
  agentActive: true,
  configured: true,
  state: { owner: "agente", stage: "active", closeReason: null },
  inboundSinceCreated: [],
  humanOutboundAfterAgent: false,
  deal: { status: "OPEN", stageId: "st-1" },
  dealStageIdAtCreate: "st-1",
  stopOnStageChange: false,
  phoneAllowed: true,
  optedOut: false,
  sentLast24h: 0,
  maxPerDay: 2,
  window: undefined,
  timeZone: TZ,
  ...over,
});

describe("decisão na hora do envio", () => {
  it("dentro das 24 h: texto; fora: modelo; WhatsApp QR: sempre texto", () => {
    expect(decideAgendaSend(baseSnap())).toEqual({ action: "send", via: "text", reopen: false });
    const old = { status: "OPEN", assignedToId: "ai-1", channelKind: "meta" as const, lastInboundAt: ago(30 * HOUR) };
    expect(decideAgendaSend(baseSnap({ conversation: old }))).toEqual({ action: "send", via: "template", reopen: false });
    expect(decideAgendaSend(baseSnap({ conversation: { ...old, channelKind: "baileys" } }))).toEqual({ action: "send", via: "text", reopen: false });
  });

  it("cada condição de parada", () => {
    const cases: Array<[Partial<AgendaSnapshot>, string]> = [
      [{ conversation: null }, "conversation_missing"],
      [{ agentActive: false }, "agent_off"],
      [{ configured: false }, "agent_off"],
      [{ optedOut: true }, "opt_out"],
      [{ inboundSinceCreated: ["na verdade já me inscrevi"] }, "client_replied"],
      [{ humanOutboundAfterAgent: true }, "human"],
      [{ assignedToOtherAi: true }, "other_agent"],
      [{ deal: { status: "WON", stageId: "st-1" } }, "deal_closed"],
      [{ deal: { status: "OPEN", stageId: "st-2" }, stopOnStageChange: true }, "stage_changed"],
      [{ conversation: { status: "RESOLVED", assignedToId: "ai-1", channelKind: "meta", lastInboundAt: ago(HOUR) }, state: { owner: "ninguem", stage: "closed", closeReason: "transferred" } }, "conversation_closed"],
      [{ conversation: { status: "OPEN", assignedToId: "ai-1", channelKind: "other", lastInboundAt: ago(HOUR) } }, "channel"],
      [{ phoneAllowed: false }, "not_allowed"],
      [{ sentLast24h: 2 }, "daily_cap"],
    ];
    for (const [over, outcome] of cases) {
      expect(decideAgendaSend(baseSnap(over)), outcome).toEqual({ action: "cancel", outcome });
    }
  });

  it("responsável humano ou conversa transferida, sem pessoa ter falado depois do agente: o passo sai", () => {
    expect(decideAgendaSend(baseSnap({
      conversation: { status: "OPEN", assignedToId: "pessoa-1", channelKind: "meta", lastInboundAt: ago(HOUR) },
      state: { owner: "pessoa", stage: "active", closeReason: null },
    })).action).toBe("send");
  });

  it("automações somadas batem o teto: adia para o dia seguinte; só os envios da agenda no teto: cancela", () => {
    const d = decideAgendaSend(baseSnap({ sentLast24h: 1, automationSentLast24h: 1 }));
    expect(d.action).toBe("reschedule");
    expect(d.action === "reschedule" && d.at.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 24 * HOUR);
    expect(decideAgendaSend(baseSnap({ sentLast24h: 0, automationSentLast24h: 1 })).action).toBe("send");
  });

  it("retomada: \"ok, obrigado\" depois de agendar não cancela; no follow-up, qualquer resposta para", () => {
    expect(decideAgendaSend(baseSnap({ inboundSinceCreated: ["ok, obrigado!"] })).action).toBe("send");
    expect(decideAgendaSend(baseSnap({ kind: "followup", inboundSinceCreated: ["ok"] }))).toEqual({ action: "cancel", outcome: "client_replied" });
  });

  it("etapa mudou não para a retomada se não configurado", () => {
    expect(decideAgendaSend(baseSnap({ deal: { status: "OPEN", stageId: "st-2" } })).action).toBe("send");
  });

  it("ticket encerrado pelo próprio agente: envia e reabre", () => {
    const d = decideAgendaSend(baseSnap({
      conversation: { status: "RESOLVED", assignedToId: "ai-1", channelKind: "meta", lastInboundAt: ago(30 * HOUR) },
      state: { owner: "ninguem", stage: "closed", closeReason: "inactivity" },
    }));
    expect(d).toEqual({ action: "send", via: "template", reopen: true });
  });

  it("fora do horário permitido: remarca, não envia", () => {
    const d = decideAgendaSend(baseSnap({ now: new Date("2026-11-26T06:00:00.000Z"), window: [{ day: 4, start: "08:00", end: "20:00" }] }));
    expect(d).toEqual({ action: "reschedule", at: new Date("2026-11-26T11:00:00.000Z") });
  });
});

const SEQ: V2FollowUpSequence = {
  id: "seq-insc",
  name: "Inscrição pendente",
  enabled: true,
  dealStages: ["st-insc"],
  steps: [
    { after: 24 * 60, mode: "fixed", message: "Conseguiu ver a inscrição?" },
    { after: 30, mode: "generated" },
  ],
  stopOnStageChange: true,
  onEnd: { action: "add_tag", tag: "sem retorno", after: 60 },
};

describe("régua de follow-up", () => {
  const plan = (rows: Parameters<typeof planFollowUp>[0]["rows"], anchorAt = ago(40 * MIN), now = NOW) =>
    planFollowUp({ sequence: SEQ, anchorMessageId: "m-1", anchorAt, rows, now, window: undefined, timeZone: TZ });

  it("régua da etapa: casa por id, nome ou \"Funil > Etapa\"; desligada não vale", () => {
    expect(matchSequence({ followUpSequences: [SEQ] }, { stageId: "st-insc" })?.id).toBe("seq-insc");
    expect(matchSequence({ followUpSequences: [{ ...SEQ, dealStages: ["Funil > Aguardando"] }] }, { stageId: "x", stageName: "Aguardando", pipelineName: "Funil" })?.id).toBe("seq-insc");
    expect(matchSequence({ followUpSequences: [{ ...SEQ, enabled: false }] }, { stageId: "st-insc" })).toBeNull();
    expect(matchSequence({ followUpSequences: [SEQ] }, { stageId: "outra" })).toBeNull();
  });

  it("primeiro passo pelo menor prazo, contado da âncora", () => {
    expect(plan([])).toEqual({ action: "plan", stepIndex: 0, dueAt: NOW, end: false });
    expect(plan([], ago(10 * MIN))).toEqual({ action: "plan", stepIndex: 0, dueAt: ahead(20 * MIN), end: false });
  });

  it("depois do passo enviado, o seguinte; com passo aberto, nada", () => {
    const sent = { stepIndex: 0, status: "SENT", anchorMessageId: "m-1", sequenceId: "seq-insc", sentVia: "text", sentAt: ago(5 * MIN) };
    expect(plan([sent], ago(25 * HOUR))).toMatchObject({ action: "plan", stepIndex: 1 });
    expect(plan([{ ...sent, status: "PENDING" }])).toEqual({ action: "none", why: "open" });
  });

  it("passo cancelado encerra a régua nesta âncora", () => {
    expect(plan([{ stepIndex: 0, status: "CANCELLED", outcome: "client_replied", anchorMessageId: "m-1", sequenceId: "seq-insc" }])).toEqual({ action: "none", why: "stopped" });
  });

  it("régua recém-ligada em conversa velha: passos vencidos são pulados, sem rajada", () => {
    const old = ago(3 * 24 * HOUR);
    expect(plan([], old)).toEqual({ action: "skip", stepIndex: 0, end: false });
    expect(AGENDA_LATE_GRACE_MS).toBe(6 * HOUR);
  });

  it("teto de envios desde a última mensagem do cliente vale para qualquer âncora (âncora mal reconhecida não vira loop)", () => {
    const rows = [
      { stepIndex: 0, status: "SENT", anchorMessageId: "m-0", sequenceId: "seq-insc", sentVia: "text", sentAt: ago(2 * HOUR) },
      { stepIndex: 1, status: "SENT", anchorMessageId: "m-0", sequenceId: "seq-insc", sentVia: "text", sentAt: ago(HOUR) },
    ];
    // Âncora nova (m-1) sem linhas: os passos não recomeçam.
    const p = plan(rows);
    expect(p.action === "plan" && !p.end).toBe(false);
  });

  it("no fim: depois do último passo enviado, com o prazo do fim; sem nada enviado, não roda", () => {
    const rows = [
      { stepIndex: 0, status: "SENT", anchorMessageId: "m-1", sequenceId: "seq-insc", sentVia: "text", sentAt: ago(3 * HOUR) },
      { stepIndex: 1, status: "SENT", anchorMessageId: "m-1", sequenceId: "seq-insc", sentVia: "template", sentAt: ago(30 * MIN) },
    ];
    expect(plan(rows, ago(4 * HOUR))).toEqual({ action: "plan", stepIndex: 2, dueAt: ahead(30 * MIN), end: true });
    const skipped = rows.map((r) => ({ ...r, status: "SKIPPED", outcome: "late" }));
    expect(plan(skipped, ago(4 * HOUR))).toEqual({ action: "none", why: "nothing_sent" });
    expect(plan([...rows, { stepIndex: 2, status: "SENT", anchorMessageId: "m-1", sequenceId: "seq-insc", sentVia: "action", sentAt: NOW }], ago(4 * HOUR))).toEqual({ action: "none", why: "finished" });
  });

  it("etapa mudou para outra régua: a nova começa na mesma âncora", () => {
    const rows = [{ stepIndex: 0, status: "CANCELLED", outcome: "stage_changed", anchorMessageId: "m-1", sequenceId: "outra" }];
    expect(plan(rows)).toMatchObject({ action: "plan", stepIndex: 0 });
  });

  it("âncora: a última mensagem do agente que não saiu da régua (pelo id gravado, não pelo texto)", () => {
    const rows = [{ sentMessageId: "msg-fu", anchorMessageId: "m-1", anchorAt: ago(HOUR) }];
    expect(followUpAnchor({ id: "msg-fu", at: NOW }, rows)).toEqual({ id: "m-1", at: ago(HOUR) });
    expect(followUpAnchor({ id: "m-2", at: NOW }, rows)).toEqual({ id: "m-2", at: NOW });
  });

  it("chaves de idempotência distintas por passo, âncora e conversa", () => {
    expect(followUpKey("c", "s", "m", 0)).not.toBe(followUpKey("c", "s", "m", 1));
    expect(followUpKey("c", "s", "m", 0)).not.toBe(followUpKey("c", "s", "m2", 0));
    expect(scheduledKey("c", "turn-1")).toBe("sched:c:turn-1");
  });
});

describe("modelos da Meta para fora das 24 h", () => {
  const agentTemplates = [
    { name: "retomada_inscricao", language: "pt_BR", label: "Retomar inscrição", bodyPreview: "Oi! Vamos concluir sua inscrição?", hasVariables: false },
    { name: "boas_vindas_nome", language: "pt_BR", label: "Boas-vindas", bodyPreview: "Oi {{1}}!", hasVariables: true },
    { name: "lembrete_prova", language: "pt_BR", label: "Lembrete da prova", bodyPreview: "Sua prova está disponível.", hasVariables: false },
  ];

  it("do passo > do agente > escolha automática entre os liberados sem variável", () => {
    expect(templateCandidates({ step: { templates: [{ name: "lembrete_prova" }] }, autoSend: { templates: [{ name: "retomada_inscricao" }] }, agentTemplates }).map((t) => t.name)).toEqual(["lembrete_prova"]);
    expect(templateCandidates({ step: null, autoSend: { templates: [{ name: "retomada_inscricao" }] }, agentTemplates }).map((t) => t.name)).toEqual(["retomada_inscricao"]);
    expect(templateCandidates({ step: null, autoSend: {}, agentTemplates }).map((t) => t.name)).toEqual(["retomada_inscricao", "lembrete_prova"]);
    expect(templateCandidates({ step: null, autoSend: { autoPickTemplates: false }, agentTemplates })).toEqual([]);
  });

  it("modelo com variável só entra com os valores configurados (sem eles, vale a escolha automática)", () => {
    expect(templateCandidates({ step: null, autoSend: { templates: [{ name: "boas_vindas_nome" }] }, agentTemplates }).map((t) => t.name)).toEqual(["retomada_inscricao", "lembrete_prova"]);
    expect(templateCandidates({ step: null, autoSend: { templates: [{ name: "boas_vindas_nome" }], autoPickTemplates: false }, agentTemplates })).toEqual([]);
    expect(templateCandidates({ step: null, autoSend: { templates: [{ name: "boas_vindas_nome", variables: ["@firstName"] }] }, agentTemplates })[0]).toMatchObject({ name: "boas_vindas_nome", variables: ["@firstName"] });
  });

  it("ordena pelo propósito do envio", () => {
    const c = templateCandidates({ step: null, autoSend: {}, agentTemplates });
    expect(rankTemplates(c, "lembrar o cliente de fazer a prova")[0].name).toBe("lembrete_prova");
    expect(rankTemplates(c, "cliente parou na inscrição")[0].name).toBe("retomada_inscricao");
  });
});
