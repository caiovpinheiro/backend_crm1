/**
 * Relatório de ações do agente: tudo o que ele fez em cada turno —
 * respondeu, transferiu (e por quê), etiquetou, moveu etapa, criou tarefa,
 * enviou mensagem pronta, encerrou — e o que tentou e foi barrado. Filtrável
 * e exportável (CSV). Lê só o log do turno; nada de modelo.
 * Nenhum domínio de cliente.
 */

import { prismaBase } from "@/lib/prisma-base";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { getV2Agent } from "./agents";
import { ensureV2AgentSchema } from "./ensure-schema";
import { HANDOFF_CAUSE_LABEL } from "./feedback-extract";

export const ACTION_EVENT_TYPES = [
  "reply",
  "handoff",
  "close",
  "ask_with_options",
  "add_tag",
  "move_stage",
  "create_activity",
  "add_note",
  "send_message_model",
  "send_message",
  "send_product",
  "send_whatsapp_template",
  "create_deal",
  "update_field",
  "tabulate_conversation",
  "start_survey",
  "record_knowledge_gap",
  "no_reply",
  "failure",
] as const;
export type ActionEventType = (typeof ACTION_EVENT_TYPES)[number];

export const ACTION_EVENT_LABEL: Record<ActionEventType, string> = {
  reply: "Respondeu",
  handoff: "Transferiu",
  close: "Encerrou",
  ask_with_options: "Perguntou com botões",
  add_tag: "Colocou etiqueta",
  move_stage: "Moveu de etapa",
  create_activity: "Criou tarefa",
  add_note: "Anotação interna",
  send_message_model: "Enviou mensagem pronta",
  send_message: "Enviou mensagem",
  send_product: "Enviou produto",
  send_whatsapp_template: "Enviou modelo do WhatsApp",
  create_deal: "Criou negócio",
  update_field: "Atualizou campo",
  tabulate_conversation: "Tabulou",
  start_survey: "Enviou pesquisa",
  record_knowledge_gap: "Registrou dúvida sem resposta",
  no_reply: "Não respondeu",
  failure: "Falha técnica",
};

export type ActionEventStatus = "ok" | "failed" | "discarded";
export const ACTION_STATUS_LABEL: Record<ActionEventStatus, string> = { ok: "Feita", failed: "Falhou", discarded: "Barrada" };

export type ActionEvent = {
  id: string;
  at: string;
  conversationId: string;
  conversationNumber: number | null;
  contactName: string | null;
  contactPhone: string | null;
  clientMessage: string;
  type: ActionEventType;
  status: ActionEventStatus;
  detail: string;
  themeId: string | null;
  themeName: string | null;
  source: "production" | "test";
  handoffCause: string | null;
  ruleName: string | null;
};

export type ActionReportFilters = {
  from: Date;
  to: Date;
  types?: ActionEventType[];
  statuses?: ActionEventStatus[];
  sources?: Array<"production" | "test">;
  themeIds?: string[];
  causes?: string[];
  q?: string;
};

export const ACTIONS_REPORT_LIMITS = { maxTurns: 20000, pageSize: 50, maxExport: 50000 };

/** Erros do motor que são "turno ignorado", não falha do agente. */
const SKIP_ERRORS = [
  "AI attendance disabled",
  "Agent config not found or invalid",
  "Agent inactive",
  "Conversation not found",
  "Conversation without contact",
  "No v2 agent assigned",
  "Phone number not in allowed test list",
];
/** Ações internas do motor: não aparecem para quem opera. */
const INTERNAL = new Set(["set_theme", "set_variable", "handoff"]);

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
};

type Row = {
  id: string;
  conversationId: string;
  createdAt: Date;
  inboundText: string;
  reply: string | null;
  handoff: boolean;
  error: string | null;
  prompt: string;
  executedActions: unknown;
  discardedActions: unknown;
  facts: Record<string, unknown> | null;
  themeId: string | null;
  closed: string | null;
  appliedRuleId: string | null;
  conversationNumber: number | null;
  contactName: string | null;
  contactPhone: string | null;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

async function loadRows(organizationId: string, agentId: string, from: Date, to: Date): Promise<{ rows: Row[]; truncated: boolean }> {
  await ensureV2AgentSchema().catch(() => undefined);
  // Só as partes pequenas do contexto: o rastro e os trechos lidos ficam fora.
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT l."id", l."conversationId", l."createdAt", l."inboundText", l."reply", l."handoff", l."error", l."prompt",
            l."executedActions", l."discardedActions",
            l."contextSnapshot"->'facts' AS "facts",
            l."contextSnapshot"->>'themeId' AS "themeId",
            l."contextSnapshot"->>'closed' AS "closed",
            l."contextSnapshot"->>'appliedRuleId' AS "appliedRuleId",
            c."number" AS "conversationNumber", ct."name" AS "contactName", ct."phone" AS "contactPhone"
       FROM "ai_simple_turn_logs" l
       LEFT JOIN "conversations" c ON c."id" = l."conversationId"
       LEFT JOIN "contacts" ct ON ct."id" = c."contactId"
      WHERE l."organizationId"=$1 AND l."agentId"=$2 AND l."createdAt" >= $3 AND l."createdAt" < $4
      ORDER BY l."createdAt" DESC
      LIMIT ${ACTIONS_REPORT_LIMITS.maxTurns + 1}`,
    organizationId, agentId, from, to,
  );
  return { rows: rows.slice(0, ACTIONS_REPORT_LIMITS.maxTurns), truncated: rows.length > ACTIONS_REPORT_LIMITS.maxTurns };
}

async function nameMaps(organizationId: string, rows: Row[]) {
  const stageIds = new Set<string>();
  const modelIds = new Set<string>();
  for (const r of rows) {
    for (const a of [...asArray(r.executedActions).map((x) => asRecord(asRecord(x).action)), ...asArray(r.discardedActions).map(asRecord)]) {
      if (typeof a.stageId === "string") stageIds.add(a.stageId);
      if (typeof a.modelId === "string") modelIds.add(a.modelId);
    }
  }
  const stages = new Map<string, string>();
  const models = new Map<string, string>();
  if (stageIds.size > 0) {
    const s = await db.$queryRawUnsafe<Array<{ id: string; name: string; pipeline: string | null }>>(
      `SELECT s."id", s."name", p."name" AS "pipeline" FROM "stages" s LEFT JOIN "pipelines" p ON p."id" = s."pipelineId" WHERE s."organizationId"=$1 AND s."id" = ANY($2::text[])`,
      organizationId, [...stageIds],
    ).catch(() => []);
    for (const x of s) stages.set(x.id, x.pipeline ? `${x.pipeline} › ${x.name}` : x.name);
  }
  if (modelIds.size > 0) {
    const m = await db.$queryRawUnsafe<Array<{ id: string; name: string }>>(
      `SELECT "id", "name" FROM "message_templates" WHERE "organizationId"=$1 AND "id" = ANY($2::text[])`,
      organizationId, [...modelIds],
    ).catch(() => []);
    for (const x of m) models.set(x.id, x.name);
  }
  return { stages, models };
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function actionDetail(a: Record<string, unknown>, names: { stages: Map<string, string>; models: Map<string, string> }): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (a.type) {
    case "add_tag":
      return s(a.tag);
    case "move_stage":
      return names.stages.get(s(a.stageId)) ?? s(a.stageId);
    case "create_activity":
    case "add_note":
      return clip(s(a.content), 200);
    case "send_message_model":
      return names.models.get(s(a.modelId)) ?? s(a.modelId);
    case "send_message":
      return clip(s(a.message) || s(a.text), 200);
    case "ask_with_options":
      return asArray(a.options).map((o) => (typeof o === "string" ? o : s(asRecord(o).label))).filter(Boolean).join(" · ");
    case "create_deal":
      return s(a.title);
    case "update_field":
      return [s(a.entity), s(a.field)].filter(Boolean).join(".") + (a.value !== undefined ? ` = ${clip(String(a.value), 60)}` : "");
    case "tabulate_conversation":
      return s(a.tabulationId);
    default:
      return "";
  }
}

/** Cada turno do log vira uma ou mais ações. */
export function eventsFromRows(
  rows: Row[],
  config: V2AgentConfig,
  names: { stages: Map<string, string>; models: Map<string, string> },
): ActionEvent[] {
  const themeName = (id: string | null) => (id ? config.themes.find((t) => t.id === id)?.name ?? null : null);
  const ruleName = (id: string | null) => (id ? config.rules.find((r) => r.id === id)?.name ?? null : null);
  const allow = (config.allowedPhoneNumbers ?? []).map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 8);
  const out: ActionEvent[] = [];
  for (const r of rows) {
    if (r.prompt === "reset") continue;
    if (r.error && SKIP_ERRORS.some((e) => r.error!.startsWith(e))) continue;
    const facts = r.facts ?? {};
    const digits = (r.contactPhone ?? "").replace(/\D/g, "");
    const source: ActionEvent["source"] =
      facts.source === "test" || (facts.source === undefined && digits && allow.some((a) => digits.endsWith(a.slice(-8)))) ? "test" : "production";
    const base = {
      at: new Date(r.createdAt).toISOString(),
      conversationId: r.conversationId,
      conversationNumber: r.conversationNumber ?? null,
      contactName: r.contactName,
      contactPhone: r.contactPhone,
      clientMessage: clip(r.inboundText ?? "", 500),
      themeId: r.themeId,
      themeName: themeName(r.themeId),
      source,
      handoffCause: null as string | null,
      ruleName: ruleName(r.appliedRuleId),
    };
    let n = 0;
    const push = (type: ActionEventType, status: ActionEventStatus, detail: string, extra: Partial<ActionEvent> = {}) =>
      out.push({ ...base, id: `${r.id}:${n++}`, type, status, detail, ...extra });

    if (r.reply) push("reply", "ok", clip(r.reply, 300));
    for (const x of asArray(r.executedActions)) {
      const res = asRecord(x);
      const a = asRecord(res.action);
      const type = String(a.type ?? "");
      if (!type || INTERNAL.has(type)) continue;
      const known = (ACTION_EVENT_TYPES as readonly string[]).includes(type) ? (type as ActionEventType) : null;
      if (!known) continue;
      const detail = actionDetail(a, names);
      push(known, res.ok === false ? "failed" : "ok", res.ok === false && typeof res.error === "string" ? `${detail}${detail ? " — " : ""}${clip(res.error, 160)}` : detail);
    }
    for (const x of asArray(r.discardedActions)) {
      const a = asRecord(x);
      const type = String(a.type ?? "");
      if (!type || INTERNAL.has(type) || !(ACTION_EVENT_TYPES as readonly string[]).includes(type)) continue;
      push(type as ActionEventType, "discarded", actionDetail(a, names));
    }
    if (r.handoff) {
      const cause = typeof facts.handoffCause === "string" ? facts.handoffCause : r.prompt === "rule" ? "rule" : null;
      push("handoff", "ok", cause ? HANDOFF_CAUSE_LABEL[cause] ?? cause : "", { handoffCause: cause });
    }
    if (r.closed === "true") push("close", "ok", "");
    if (r.error && !r.reply && !r.handoff) push("failure", "failed", clip(r.error, 200));
  }
  return out;
}

function matches(e: ActionEvent, f: ActionReportFilters, skip?: "type" | "status"): boolean {
  if (skip !== "type" && f.types?.length && !f.types.includes(e.type)) return false;
  if (skip !== "status" && f.statuses?.length && !f.statuses.includes(e.status)) return false;
  if (f.sources?.length && !f.sources.includes(e.source)) return false;
  if (f.themeIds?.length && !f.themeIds.includes(e.themeId ?? "__none__")) return false;
  if (f.causes?.length && !(e.type === "handoff" && e.handoffCause && f.causes.includes(e.handoffCause))) return false;
  if (f.q) {
    const q = fold(f.q.trim());
    const hay = fold([e.contactName, e.contactPhone, e.clientMessage, e.detail, e.conversationNumber ? `#${e.conversationNumber}` : ""].join(" "));
    if (!hay.includes(q)) return false;
  }
  return true;
}

async function buildEvents(organizationId: string, agentId: string, f: ActionReportFilters) {
  const agent = await getV2Agent(agentId, organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  const { rows, truncated } = await loadRows(organizationId, agentId, f.from, f.to);
  const names = await nameMaps(organizationId, rows);
  return { config, events: eventsFromRows(rows, config, names), truncated, turns: rows.length };
}

export async function getActionsReport(args: { organizationId: string; agentId: string; filters: ActionReportFilters; page: number }) {
  const { config, events, truncated, turns } = await buildEvents(args.organizationId, args.agentId, args.filters);
  const filtered = events.filter((e) => matches(e, args.filters));
  // Contagens dos chips: cada uma ignora o próprio filtro, para mostrar o que dá para somar.
  const byType: Partial<Record<ActionEventType, number>> = {};
  for (const e of events) if (matches(e, args.filters, "type")) byType[e.type] = (byType[e.type] ?? 0) + 1;
  const byStatus: Partial<Record<ActionEventStatus, number>> = {};
  for (const e of events) if (matches(e, args.filters, "status")) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  const conversations = new Set(filtered.map((e) => e.conversationId)).size;
  const pageSize = ACTIONS_REPORT_LIMITS.pageSize;
  const page = Math.max(1, args.page);
  return {
    total: filtered.length,
    conversations,
    turns,
    truncated,
    page,
    pageSize,
    events: filtered.slice((page - 1) * pageSize, page * pageSize),
    byType,
    byStatus,
    themes: config.themes.map((t) => ({ id: t.id, name: t.name })),
  };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Fórmula em planilha começa com = + - @: prefixo evita executar.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV (separador ";" e BOM, abre direto no Excel em português). */
export async function exportActionsReportCsv(args: { organizationId: string; agentId: string; filters: ActionReportFilters }): Promise<string> {
  const { events } = await buildEvents(args.organizationId, args.agentId, args.filters);
  const filtered = events.filter((e) => matches(e, args.filters)).slice(0, ACTIONS_REPORT_LIMITS.maxExport);
  const header = ["Data", "Hora", "Conversa", "Cliente", "Telefone", "Mensagem do cliente", "Ação", "Situação", "Detalhe", "Assunto", "Atalho", "Origem"];
  const lines = filtered.map((e) => {
    const d = new Date(e.at);
    const date = d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const time = d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" });
    return [
      date,
      time,
      e.conversationNumber ? `#${e.conversationNumber}` : e.conversationId,
      e.contactName ?? "",
      e.contactPhone ?? "",
      e.clientMessage,
      ACTION_EVENT_LABEL[e.type],
      ACTION_STATUS_LABEL[e.status],
      e.detail,
      e.themeName ?? "",
      e.ruleName ?? "",
      e.source === "test" ? "Teste" : "Produção",
    ].map(csvCell).join(";");
  });
  return `﻿${[header.join(";"), ...lines].join("\r\n")}`;
}

/** Filtros a partir da query string (datas em yyyy-mm-dd, fuso de Brasília). */
export function parseActionReportFilters(params: URLSearchParams): ActionReportFilters {
  const day = (s: string | null, end: boolean): Date | null => {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00-03:00`);
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const list = (k: string) => (params.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const to = day(params.get("to"), true) ?? new Date(Date.now() + 60_000);
  const from = day(params.get("from"), false) ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  // Janela máxima de 180 dias.
  const minFrom = new Date(to.getTime() - 180 * 24 * 60 * 60 * 1000);
  return {
    from: from < minFrom ? minFrom : from,
    to,
    types: list("types").filter((t): t is ActionEventType => (ACTION_EVENT_TYPES as readonly string[]).includes(t)),
    statuses: list("status").filter((s): s is ActionEventStatus => ["ok", "failed", "discarded"].includes(s)),
    sources: list("source").filter((s): s is "production" | "test" => s === "production" || s === "test"),
    themeIds: list("themes"),
    causes: list("causes"),
    q: params.get("q")?.slice(0, 100) || undefined,
  };
}
