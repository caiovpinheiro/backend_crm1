/**
 * Validadores determinísticos da configuração dos agentes v2 (fase 1):
 * leem as configurações da organização (agentes, departamentos, pessoas,
 * tabulações, fluxos de automação) e devolvem achados objetivos — sem IA.
 * Rodam ao salvar o rascunho e barram a publicação quando há achado que
 * "bloqueia" (salvo `?force=1`). O mesmo grafo alimenta o mapa de roteamento.
 *
 * Funções puras sobre dados já carregados (testáveis); o carregamento fica em
 * `loadConfigValidationData`. Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { getOrgSettingBool } from "@/lib/org-settings";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2AgentConfig, V2Destination, V2Theme } from "@/lib/ai-v2/types";
import { automationTalksToClient } from "@/lib/automation-workflow";
import { sameWordStem } from "./themes";
import { getLogger } from "@/lib/logger";

const log = getLogger("ai-v2.config-validators");

// ─── Tipos ───────────────────────────────────────────────────────────────

export type ValidationSeverity = "bloqueia" | "avisa";

export type ValidationFinding = {
  code: string;
  severity: ValidationSeverity;
  agentId: string;
  /** Campo da configuração (ex.: "themes[2].when[0]", "handoff.defaultDestination"). */
  path: string;
  message: string;
  evidence?: string;
};

export type ValidationAgent = {
  id: string;
  name: string;
  active: boolean;
  engine: string;
  createdAt: Date;
  config: V2AgentConfig;
};

export type ValidationAutomation = {
  id: string;
  name: string;
  triggerType: string;
  active: boolean;
  steps: Array<{ type: string; config?: Record<string, unknown> }>;
};

export type ConfigValidationData = {
  agents: ValidationAgent[];
  departments: Array<{ id: string; name: string; memberCount: number }>;
  users: Array<{ id: string; name: string }>;
  distributionRules: Array<{ id: string; name: string }>;
  tabulations: Array<{ id: string; name: string }>;
  automations: ValidationAutomation[];
  /** Chave da org `automations.runOnAiClose` (encerramento pelo agente dispara fluxos "Conversa encerrada"). */
  runOnAiClose: boolean;
  now?: Date;
};

export type RoutingNodeKind = "ai_agent" | "department" | "user" | "distribution_rule" | "queue";
export type RoutingNode = {
  id: string;
  kind: RoutingNodeKind;
  name: string;
  active?: boolean;
  /** Agente que pode receber conversa nova (1º atendimento). */
  firstAttendance?: boolean;
  channelCount?: number;
  /** Destino citado na configuração que não existe mais. */
  missing?: boolean;
};
export type RoutingEdgeKind = "default" | "theme" | "rule" | "scope" | "onboarding" | "answer_by";
export type RoutingEdge = {
  from: string;
  to: string;
  kind: RoutingEdgeKind;
  /** Nome do assunto/atalho (ou "Destino padrão"). */
  label: string;
  path: string;
  /** Transferência sem resposta do agente (assunto direto, atalho, destino padrão). */
  direct: boolean;
  themeId?: string;
};
export type RoutingMap = { nodes: RoutingNode[]; edges: RoutingEdge[] };

/** Mesma chave que `engine.ts` lê (`RUN_FLOWS_ON_AI_CLOSE_KEY`); repetida aqui para não carregar o motor na validação. */
export const RUN_ON_AI_CLOSE_KEY = "automations.runOnAiClose";

// ─── Utilidades ──────────────────────────────────────────────────────────

const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
/** Minúsculas, sem acento, só letras/números separados por um espaço. */
const norm = (s: string) => stripAccents(s.trim().toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim();
const q = (s: string) => `“${s}”`;
const nodeKey = (type: string, id: string) => `${type}:${id}`;

const DESTINATION_KIND: Record<string, string> = {
  ai_agent: "agente de IA",
  department: "departamento",
  user: "pessoa",
  distribution_rule: "regra de distribuição",
  automation: "fluxo de automação",
};

type DestinationRef = {
  d: V2Destination;
  path: string;
  label: string;
  kind: RoutingEdgeKind;
  direct: boolean;
  themeId?: string;
};

/** Todos os destinos de transferência da configuração, com o campo de origem. */
export function listDestinations(c: V2AgentConfig): DestinationRef[] {
  const out: DestinationRef[] = [];
  if (c.handoff?.defaultDestination) {
    out.push({ d: c.handoff.defaultDestination, path: "handoff.defaultDestination", label: "Destino padrão", kind: "default", direct: true });
  }
  c.themes.forEach((t, i) => {
    if (t.handoffDestination) {
      out.push({ d: t.handoffDestination, path: `themes[${i}].handoffDestination`, label: t.name, kind: "theme", direct: Boolean(t.directHandoff), themeId: t.id });
    }
    if (t.answerBy && t.answerBy !== "self") {
      out.push({ d: { type: "ai_agent", id: t.answerBy }, path: `themes[${i}].answerBy`, label: t.name, kind: "answer_by", direct: true, themeId: t.id });
    }
  });
  c.rules.forEach((r, i) => {
    if (r.enabled === false) return;
    r.actions.forEach((a, j) => {
      if (a.type === "handoff" && a.destination) {
        out.push({ d: a.destination, path: `rules[${i}].actions[${j}].destination`, label: r.name, kind: "rule", direct: true });
      }
    });
  });
  (c.scope?.forbidden ?? []).forEach((f, i) => {
    if (f.destination) out.push({ d: f.destination, path: `scope.forbidden[${i}].destination`, label: f.subject, kind: "scope", direct: true });
  });
  (c.onboarding?.steps ?? []).forEach((s, i) => {
    if (s.handoffOnStuck) out.push({ d: s.handoffOnStuck, path: `onboarding.steps[${i}].handoffOnStuck`, label: s.name, kind: "onboarding", direct: true });
  });
  return out;
}

/**
 * Agentes que podem receber conversa nova, na regra de `pickAgentForConversation`:
 * ligado e com número vinculado (vence quem está no canal), ou o mais antigo
 * dos ligados sem número (atende qualquer canal).
 */
export function firstAttendanceAgentIds(agents: ValidationAgent[]): Set<string> {
  const active = agents.filter((a) => a.active && a.engine === "simple").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out = new Set<string>();
  const seenChannels = new Set<string>();
  for (const a of active) {
    const channels = (a.config.channelIds ?? []).filter(Boolean);
    const fresh = channels.filter((ch) => !seenChannels.has(ch));
    if (fresh.length > 0) out.add(a.id);
    channels.forEach((ch) => seenChannels.add(ch));
  }
  const anyChannel = active.find((a) => (a.config.channelIds ?? []).filter(Boolean).length === 0);
  if (anyChannel) out.add(anyChannel.id);
  return out;
}

// ─── Mapa de roteamento ──────────────────────────────────────────────────

/** Nós = agentes e destinos; arestas = assunto/atalho → destino. */
export function buildRoutingMap(data: ConfigValidationData): RoutingMap {
  const nodes = new Map<string, RoutingNode>();
  const edges: RoutingEdge[] = [];
  const first = firstAttendanceAgentIds(data.agents);
  const departments = new Map(data.departments.map((d) => [d.id, d]));
  const users = new Map(data.users.map((u) => [u.id, u]));
  const rules = new Map(data.distributionRules.map((r) => [r.id, r]));
  const agents = new Map(data.agents.map((a) => [a.id, a]));

  for (const a of data.agents) {
    nodes.set(nodeKey("ai_agent", a.id), { id: a.id, kind: "ai_agent", name: a.name, active: a.active, firstAttendance: first.has(a.id), channelCount: (a.config.channelIds ?? []).length });
  }
  const ensureTarget = (d: V2Destination): string => {
    if (d.type === "automation") return "queue:automation";
    if (!d.id) {
      nodes.set("queue:", { id: "", kind: "queue", name: "Fila da equipe (sem departamento)" });
      return "queue:";
    }
    const key = nodeKey(d.type, d.id);
    if (nodes.has(key)) return key;
    if (d.type === "department") nodes.set(key, { id: d.id, kind: "department", name: departments.get(d.id)?.name ?? d.id, missing: !departments.has(d.id) });
    else if (d.type === "user") nodes.set(key, { id: d.id, kind: "user", name: users.get(d.id)?.name ?? d.id, missing: !users.has(d.id) });
    else if (d.type === "distribution_rule") nodes.set(key, { id: d.id, kind: "distribution_rule", name: rules.get(d.id)?.name ?? d.id, missing: !rules.has(d.id) });
    else nodes.set(key, { id: d.id, kind: "ai_agent", name: agents.get(d.id)?.name ?? d.id, active: agents.get(d.id)?.active, missing: !agents.has(d.id) });
    return key;
  };
  for (const a of data.agents) {
    for (const ref of listDestinations(a.config)) {
      if (ref.d.type === "automation") continue;
      edges.push({ from: nodeKey("ai_agent", a.id), to: ensureTarget(ref.d), kind: ref.kind, label: ref.label, path: ref.path, direct: ref.direct, themeId: ref.themeId });
    }
  }
  nodes.delete("queue:automation");
  return { nodes: [...nodes.values()], edges };
}

// ─── 1. Grafo de roteamento ──────────────────────────────────────────────

function validateRouting(agent: ValidationAgent, data: ConfigValidationData, add: (f: Omit<ValidationFinding, "agentId">) => void): void {
  const agents = new Map(data.agents.map((a) => [a.id, a]));
  const departments = new Map(data.departments.map((d) => [d.id, d]));
  const users = new Set(data.users.map((u) => u.id));
  const rules = new Set(data.distributionRules.map((r) => r.id));

  for (const ref of listDestinations(agent.config)) {
    const d = ref.d;
    if (d.type === "automation") continue;
    const where = ref.kind === "default" ? "O destino padrão" : `${q(ref.label)}`;
    if (!d.id) {
      if (d.type === "department") {
        if (ref.kind === "default") add({ code: "destino_sem_id", severity: "bloqueia", path: ref.path, message: "Destino padrão de transferência sem departamento nem pessoa: a conversa transferida cai na fila sem responsável." });
        continue;
      }
      add({ code: "destino_sem_id", severity: "bloqueia", path: ref.path, message: `${where} transfere para ${DESTINATION_KIND[d.type]} sem escolher qual: a transferência falha e a conversa cai na fila da equipe.` });
      continue;
    }
    const exists = d.type === "department" ? departments.has(d.id) : d.type === "user" ? users.has(d.id) : d.type === "distribution_rule" ? rules.has(d.id) : agents.has(d.id);
    if (!exists) {
      add({ code: "destino_inexistente", severity: "bloqueia", path: ref.path, message: `${where} transfere para ${DESTINATION_KIND[d.type]} que não existe mais.`, evidence: `${d.type}:${d.id}` });
      continue;
    }
    if (d.type === "ai_agent") {
      const target = agents.get(d.id)!;
      if (d.id === agent.id) {
        add({ code: "autotransferencia", severity: "bloqueia", path: ref.path, message: `${where} transfere para este mesmo agente: o motor desvia para o destino padrão e o cliente não chega a quem devia.`, evidence: target.name });
        continue;
      }
      if (!target.active) add({ code: "destino_desligado", severity: "bloqueia", path: ref.path, message: `${where} transfere para ${q(target.name)}, que está desligado: ninguém responde.` });
      else if (target.engine !== "simple") add({ code: "destino_motor_antigo", severity: "avisa", path: ref.path, message: `${where} transfere para ${q(target.name)}, do motor antigo.` });
    }
    if (d.type === "department") {
      const dep = departments.get(d.id)!;
      if (dep.memberCount === 0) add({ code: "departamento_sem_usuario", severity: "avisa", path: ref.path, message: `${where} transfere para o departamento ${q(dep.name)}, que não tem ninguém: a conversa fica na fila sem responsável.` });
    }
  }

  // Ciclo entre agentes: A → B → … → A pelos destinos de assunto/atalho/padrão.
  const outgoing = new Map<string, Array<{ to: string; ref: DestinationRef }>>();
  for (const a of data.agents) {
    outgoing.set(a.id, listDestinations(a.config).filter((r) => r.d.type === "ai_agent" && r.d.id && r.d.id !== a.id && agents.has(r.d.id)).map((r) => ({ to: r.d.id!, ref: r })));
  }
  const reported = new Set<string>();
  const walk = (current: string, path: Array<{ from: string; to: string; ref: DestinationRef }>, seen: Set<string>) => {
    for (const edge of outgoing.get(current) ?? []) {
      if (edge.to === agent.id) {
        const cycle = [...path, { from: current, to: edge.to, ref: edge.ref }];
        const key = cycle.map((e) => e.from).sort().join(">");
        if (reported.has(key)) continue;
        reported.add(key);
        const deterministic = cycle.every((e) => e.ref.direct);
        const chain = [...cycle.map((e) => agents.get(e.from)?.name ?? e.from), agent.name].join(" → ");
        const first = cycle[0];
        add({
          code: "ciclo_entre_agentes",
          severity: deterministic ? "bloqueia" : "avisa",
          path: first.ref.path,
          message: cycle.length === 2
            ? `${q(first.ref.label)} transfere para ${q(agents.get(first.to)?.name ?? first.to)}, que devolve a conversa para este agente (${q(cycle[1].ref.label)}): ping-pong até o motor desviar para o destino padrão.`
            : `Ciclo de transferência entre agentes (${chain}): a conversa volta para este agente em vez de ser resolvida.`,
          evidence: chain,
        });
        continue;
      }
      if (seen.has(edge.to) || path.length >= 4) continue;
      walk(edge.to, [...path, { from: current, to: edge.to, ref: edge.ref }], new Set([...seen, edge.to]));
    }
  };
  walk(agent.id, [], new Set([agent.id]));

  // Órfão: ligado, ninguém transfere para ele e não recebe conversa nova.
  if (agent.active && agent.engine === "simple" && !firstAttendanceAgentIds(data.agents).has(agent.id)) {
    const incoming = data.agents.some((a) => a.id !== agent.id && a.active && listDestinations(a.config).some((r) => r.d.type === "ai_agent" && r.d.id === agent.id));
    const fromFlow = data.automations.some((f) => f.active && f.steps.some((s) => (s.type === "transfer_to_ai_agent" || s.type === "ask_ai_agent") && s.config?.agentId === agent.id));
    if (!incoming && !fromFlow) {
      add({ code: "agente_orfao", severity: "avisa", path: "channelIds", message: "Nenhuma conversa chega a este agente: não está vinculado a um número que ele atenda primeiro, nenhum outro agente transfere para ele e nenhum fluxo de automação o chama." });
    }
  }
}

// ─── 2. Gatilhos de assunto ──────────────────────────────────────────────

const GREETINGS = new Set(["oi", "ola", "bom dia", "boa tarde", "boa noite", "tudo bem", "oi tudo bem", "ola tudo bem", "obrigado", "obrigada", "ok", "sim", "nao", "ajuda", "por favor", "alo", "opa", "e ai", "oie", "oii", "hey", "hello"]);
/** Palavra que, sozinha, costuma aparecer negada ("não quero X", "sem X"): verbo no infinitivo. */
const INFINITIVE = /^[a-z]{3,}(ar|er|ir)$/;

export function themeKeyWords(trigger: string): string[] {
  return norm(trigger).split(" ").filter((w) => w.length > 2);
}

function validateThemes(c: V2AgentConfig, add: (f: Omit<ValidationFinding, "agentId">) => void): void {
  const globalDocs = (c.allowedKnowledgeDocIds ?? []).length;
  const triggers: Array<{ themeIndex: number; theme: V2Theme; index: number; raw: string; key: string }> = [];
  c.themes.forEach((t, ti) => {
    (t.when ?? []).forEach((w, wi) => {
      const key = norm(w);
      if (!key) return;
      triggers.push({ themeIndex: ti, theme: t, index: wi, raw: w, key });
      const words = themeKeyWords(w);
      if (GREETINGS.has(key) || (words.length > 0 && words.every((x) => GREETINGS.has(x)))) {
        add({ code: "gatilho_cumprimento", severity: "avisa", path: `themes[${ti}].when[${wi}]`, message: `Gatilho ${q(w)} de ${q(t.name)} é um cumprimento comum: quase toda conversa começa nesse assunto.`, evidence: w });
      } else if (words.length === 1 && INFINITIVE.test(words[0])) {
        add({ code: "gatilho_palavra_solta", severity: "avisa", path: `themes[${ti}].when[${wi}]`, message: `Gatilho de uma palavra só (${q(w)}) também aparece em frases negadas (“não quero ${words[0]}”): use uma frase (“quero ${words[0]}”, “como faço para ${words[0]}”).`, evidence: w });
      }
    });

    const docs = (t.allowedKnowledgeDocIds ?? []).length + (t.knowledgeDocIds ?? []).length + globalDocs;
    const models = (t.allowedMessageModelIds ?? []).length + (t.messageModelIds ?? []).length;
    const hasDestination = Boolean(t.handoffDestination?.id) || (t.answerBy && t.answerBy !== "self");
    if (!(t.instructions ?? "").trim() && docs === 0 && models === 0 && (t.allowedTools ?? []).length === 0 && !hasDestination && !t.directHandoff) {
      add({ code: "assunto_vazio", severity: "avisa", path: `themes[${ti}].instructions`, message: `Assunto ${q(t.name)} sem instruções, sem material e sem destino: reconhecido, o agente não tem o que fazer com ele.` });
    }
  });

  const reported = new Set<string>();
  for (let i = 0; i < triggers.length; i++) {
    for (let j = i + 1; j < triggers.length; j++) {
      const a = triggers[i];
      const b = triggers[j];
      if (a.theme.id === b.theme.id) continue;
      const same = a.key === b.key;
      const oneWord = !a.key.includes(" ") && !b.key.includes(" ");
      if (!same && !(oneWord && sameWordStem(a.key, b.key))) continue;
      const k = [a.themeIndex, b.themeIndex, a.key, b.key].join("|");
      if (reported.has(k)) continue;
      reported.add(k);
      add({
        code: "gatilho_repetido",
        severity: "avisa",
        path: `themes[${b.themeIndex}].when[${b.index}]`,
        message: same
          ? `Gatilho ${q(b.raw)} está em dois assuntos (${q(a.theme.name)} e ${q(b.theme.name)}): o empate é decidido pela lista, não pelo que o cliente quis.`
          : `Gatilhos ${q(a.raw)} (${a.theme.name}) e ${q(b.raw)} (${b.theme.name}) contam como a mesma palavra: o empate é decidido pela lista.`,
        evidence: `themes[${a.themeIndex}].when[${a.index}]`,
      });
    }
  }
}

// ─── 3. Calendário ───────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, mar: 3, abril: 4, abr: 4, maio: 5, mai: 5, junho: 6, jun: 6,
  julho: 7, jul: 7, agosto: 8, ago: 8, setembro: 9, set: 9, outubro: 10, out: 10, novembro: 11, nov: 11, dezembro: 12, dez: 12,
};
const MONTH_NAME_RE = /\b(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b\.?/gi;
const DAY_MONTH_RE = /\b(\d{1,2})\s*\/\s*(\d{1,2})(\s*\/\s*\d{2,4})?\b/g;

/** Meses citados no título (nome ou dd/mm). Abreviações de 3 letras só depois de um dia ("15 set", "15 de set"). */
export function monthsInTitle(title: string): number[] {
  const out = new Set<number>();
  const text = stripAccents(title.toLowerCase());
  for (const m of text.matchAll(MONTH_NAME_RE)) {
    const token = m[1].replace("ç", "c");
    const month = MONTH_NAMES[token];
    if (!month) continue;
    if (token.length === 3 && !/\d\s*(de\s+)?$/.test(text.slice(0, m.index))) continue;
    out.add(month);
  }
  for (const m of text.matchAll(DAY_MONTH_RE)) {
    const month = Number(m[2]);
    const day = Number(m[1]);
    // "2/12" pode ser parcela ou fração: só conta como data com ano, dia de
    // dois dígitos ou "dia/em/até/de" antes.
    const dated = Boolean(m[3]) || m[1].length === 2 || /\b(dia|em|ate|de|a)\s*$/.test(text.slice(0, m.index));
    if (dated && month >= 1 && month <= 12 && day >= 1 && day <= 31) out.add(month);
  }
  return [...out];
}

function monthsOfRange(start: string, end?: string): Set<number> {
  const out = new Set<number>();
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const ranged = Boolean(end && end > start);
  const ey = ranged ? Number(end!.slice(0, 4)) : y;
  const em = ranged ? Number(end!.slice(5, 7)) : m;
  for (let i = 0; i < 24; i += 1) {
    out.add(m);
    if (y === ey && m === em) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const MONTH_LABEL = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function validateCalendar(c: V2AgentConfig, now: Date, add: (f: Omit<ValidationFinding, "agentId">) => void): void {
  const events = c.calendar?.events ?? [];
  if (events.length === 0) return;
  const today = now.toISOString().slice(0, 10);
  const seen = new Map<string, number>();
  let future = 0;
  events.forEach((e, i) => {
    const key = `${norm(e.title)}|${e.start}|${e.end ?? ""}`;
    const dup = seen.get(key);
    if (dup !== undefined) {
      add({ code: "calendario_evento_duplicado", severity: "avisa", path: `calendar.events[${i}]`, message: `Evento ${q(e.title)} (${e.start}) está duas vezes no calendário.`, evidence: `calendar.events[${dup}]` });
    } else seen.set(key, i);
    const cited = monthsInTitle(e.title);
    if (cited.length > 0) {
      const range = monthsOfRange(e.start, e.end);
      if (!cited.some((m) => range.has(m))) {
        add({
          code: "calendario_mes_divergente",
          severity: "avisa",
          path: `calendar.events[${i}]`,
          message: `Evento ${q(e.title)} cita ${cited.map((m) => MONTH_LABEL[m]).join("/")}, mas a data é ${e.start}${e.end ? ` a ${e.end}` : ""} (${[...range].map((m) => MONTH_LABEL[m]).join("/")}): o agente pode dizer a data errada.`,
          evidence: e.start,
        });
      }
    }
    if ((e.end ?? e.start) >= today) future += 1;
  });
  if (future === 0) {
    add({ code: "calendario_so_passado", severity: "avisa", path: "calendar.events", message: `Calendário só com datas passadas (${events.length} evento${events.length === 1 ? "" : "s"}): o agente não tem nenhuma data futura para informar.` });
  }
}

// ─── 4. Campos mesclados ─────────────────────────────────────────────────

/** Chaves sempre disponíveis nas mensagens (contato e negócio carregados). */
const BUILTIN_KEYS = ["id", "name", "phone", "email", "tags", "title", "value", "status", "number", "stageId", "stageName", "pipelineName", "stage", "contact", "deal"];
const CONTACT_BUILTINS = ["id", "name", "phone", "email", "tags"];
const DEAL_BUILTINS = ["id", "title", "value", "status", "number", "stageId", "stageName", "pipelineName", "stage", "lostReason", "expectedClose"];

/** `@Chave` / `@Chave{…}` numa mensagem; `@` colado em letra/número é e-mail. */
export function variableRefs(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[^\p{L}\p{N}._%+-])@([\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*)/gu;
  for (const m of text.matchAll(re)) out.push(m[2]);
  return out;
}

export function knownVariableKeys(c: V2AgentConfig): Set<string> {
  const keys = new Set<string>(BUILTIN_KEYS);
  for (const v of c.variables ?? []) keys.add(v.key);
  for (const f of c.contextFields?.contact ?? []) {
    keys.add(f.key);
    keys.add(`contact.${f.key}`);
    if (f.label) keys.add(f.label);
  }
  for (const f of c.contextFields?.deal ?? []) {
    keys.add(f.key);
    keys.add(`deal.${f.key}`);
    if (f.label) keys.add(f.label);
  }
  for (const k of CONTACT_BUILTINS) keys.add(`contact.${k}`);
  for (const k of DEAL_BUILTINS) keys.add(`deal.${k}`);
  for (const d of c.derivedFields ?? []) keys.add(d.label);
  // Variáveis gravadas por atalhos (`set_variable`) e vindas de fluxo de automação.
  for (const r of c.rules ?? []) for (const a of r.actions) if (a.variable?.key) keys.add(a.variable.key);
  for (const v of Object.values(c.entry?.automationVariablesMapping ?? {})) if (v) keys.add(v);
  return keys;
}

/** Campos de texto que o motor renderiza com `@variáveis` antes de enviar ao cliente. */
export function messageFields(c: V2AgentConfig): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const push = (path: string, text: string | undefined | null) => {
    if (typeof text === "string" && text.includes("@")) out.push({ path, text });
  };
  push("entry.openingMessage", c.entry?.openingMessage);
  push("entry.confirmationMessage", c.entry?.confirmationMessage);
  push("entry.identificationMessage", c.entry?.identificationMessage);
  push("handoff.message", c.handoff?.message);
  push("handoff.queuedMessage", c.handoff?.queuedMessage);
  c.themes.forEach((t, i) => {
    push(`themes[${i}].handoffDestination.message`, t.handoffDestination?.message);
    push(`themes[${i}].instructions`, t.instructions);
  });
  c.rules.forEach((r, i) => r.actions.forEach((a, j) => {
    push(`rules[${i}].actions[${j}].message`, a.message);
    push(`rules[${i}].actions[${j}].destination.message`, a.destination?.message);
  }));
  push("closure.goodbyeMessage", c.closure?.goodbyeMessage);
  push("closure.shortReplyMessage", c.closure?.shortReplyMessage);
  push("closure.postCloseMessages.courtesy", c.closure?.postCloseMessages?.courtesy);
  push("closure.postCloseMessages.new_demand", c.closure?.postCloseMessages?.new_demand);
  push("closure.postCloseMessages.ambiguous", c.closure?.postCloseMessages?.ambiguous);
  push("closure.postCloseQuestion.message", c.closure?.postCloseQuestion?.message);
  push("fallback.unknown.message", c.fallback?.unknown?.message);
  push("fallback.humanRequest.message", c.fallback?.humanRequest?.message);
  push("fallback.noSource.message", c.fallback?.noSource?.message);
  push("fallback.error.message", c.fallback?.error?.message);
  push("scope.message", c.scope?.message);
  push("inactivity.nudgeMessage", c.inactivity?.nudgeMessage);
  push("inactivity.closeMessage", c.inactivity?.closeMessage);
  push("businessHours.offHoursMessage", c.businessHours?.offHoursMessage);
  (["audio", "image", "document"] as const).forEach((k) => {
    push(`media.${k}.askTextMessage`, c.media?.[k]?.askTextMessage);
    push(`media.${k}.handoffMessage`, c.media?.[k]?.handoffMessage);
    push(`media.${k}.notUnderstoodMessage`, c.media?.[k]?.notUnderstoodMessage);
  });
  for (const [k, v] of Object.entries(c.systemMessages ?? {})) push(`systemMessages.${k}`, v as string | undefined);
  (c.onboarding?.steps ?? []).forEach((s, i) => push(`onboarding.steps[${i}].openingMessage`, s.openingMessage));
  return out;
}

function validateFields(c: V2AgentConfig, add: (f: Omit<ValidationFinding, "agentId">) => void): void {
  const known = knownVariableKeys(c);
  const knownByNorm = new Map<string, string>();
  for (const k of known) if (!knownByNorm.has(norm(k))) knownByNorm.set(norm(k), k);
  // Partes da chave multi-palavra ("Nome da empresa"): a 1ª palavra também vale.
  const firstWords = new Set([...known].map((k) => k.split(" ")[0]));

  const reported = new Set<string>();
  for (const { path, text } of messageFields(c)) {
    for (const ref of variableRefs(text)) {
      if (known.has(ref) || firstWords.has(ref)) continue;
      const key = `${path}|${ref}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const variant = knownByNorm.get(norm(ref));
      if (variant && variant !== ref) {
        add({ code: "campo_variante_acento", severity: "bloqueia", path, message: `A mensagem usa @${ref}, mas o campo se chama ${q(variant)} (acento diferente): a frase sai para o cliente sem esse valor.`, evidence: ref });
      } else {
        add({ code: "campo_inexistente", severity: "bloqueia", path, message: `A mensagem usa @${ref}, que não é informação da empresa nem campo liberado do contato/negócio: a frase sai para o cliente sem esse valor.`, evidence: ref });
      }
    }
  }

  // Variantes com/sem acento entre as próprias chaves (duas informações "iguais").
  const defs: Array<{ key: string; path: string }> = [
    ...(c.variables ?? []).map((v, i) => ({ key: v.key, path: `variables[${i}].key` })),
    ...(c.contextFields?.contact ?? []).map((f, i) => ({ key: f.label ?? f.key, path: `contextFields.contact[${i}]` })),
    ...(c.contextFields?.deal ?? []).map((f, i) => ({ key: f.label ?? f.key, path: `contextFields.deal[${i}]` })),
    ...(c.derivedFields ?? []).map((d, i) => ({ key: d.label, path: `derivedFields[${i}].label` })),
  ];
  const byNorm = new Map<string, { key: string; path: string }>();
  for (const d of defs) {
    const n = norm(d.key);
    if (!n) continue;
    const prev = byNorm.get(n);
    if (prev && prev.key !== d.key) {
      add({ code: "campo_variante_acento", severity: "avisa", path: d.path, message: `${q(d.key)} e ${q(prev.key)} são o mesmo nome com e sem acento: a mensagem que usar um deles não enxerga o outro.`, evidence: prev.path });
    } else if (!prev) byNorm.set(n, d);
  }
}

// ─── 5. Tabulação ────────────────────────────────────────────────────────

function validateTabulation(c: V2AgentConfig, data: ConfigValidationData, add: (f: Omit<ValidationFinding, "agentId">) => void): void {
  const tabs = new Map(data.tabulations.map((t) => [t.id, t]));
  const themeName = new Map(c.themes.map((t) => [t.id, t.name]));
  c.themes.forEach((t, i) => {
    if (t.tabulationId && !tabs.has(t.tabulationId)) {
      add({ code: "tabulacao_inexistente", severity: "bloqueia", path: `themes[${i}].tabulationId`, message: `Assunto ${q(t.name)} tabula numa folha que não existe mais ou está inativa: o encerramento sai sem tabulação.`, evidence: t.tabulationId });
    }
  });
  const tab = c.tabulation;
  if (!tab?.enabled) return;
  if (tab.fallbackId && !tabs.has(tab.fallbackId)) {
    add({ code: "tabulacao_inexistente", severity: "bloqueia", path: "tabulation.fallbackId", message: "A tabulação padrão aponta para uma folha que não existe mais ou está inativa.", evidence: tab.fallbackId });
  }
  for (const [themeId, tabId] of Object.entries(tab.byTheme ?? {})) {
    if (tabId && !tabs.has(tabId)) {
      add({ code: "tabulacao_inexistente", severity: "bloqueia", path: `tabulation.byTheme.${themeId}`, message: `Tabulação do assunto ${q(themeName.get(themeId) ?? themeId)} aponta para uma folha que não existe mais ou está inativa.`, evidence: tabId });
    }
  }
  (tab.allowedIds ?? []).forEach((id, i) => {
    if (!tabs.has(id)) add({ code: "tabulacao_inexistente", severity: "avisa", path: `tabulation.allowedIds[${i}]`, message: "Folha permitida para o agente escolher não existe mais ou está inativa.", evidence: id });
  });
}

// ─── 6. Fluxos de automação no encerramento ──────────────────────────────

function validateAutomations(data: ConfigValidationData, add: (f: Omit<ValidationFinding, "agentId">) => void): void {
  const flows = data.automations.filter((f) => f.active && f.triggerType === "conversation_tabulated" && automationTalksToClient(f.steps));
  if (flows.length === 0) return;
  const names = flows.map((f) => q(f.name)).join(", ");
  if (data.runOnAiClose) {
    add({
      code: "fluxo_fala_com_cliente_no_encerramento",
      severity: "avisa",
      path: "closure",
      message: `Fluxo${flows.length > 1 ? "s" : ""} de automação “Conversa encerrada” que fala${flows.length > 1 ? "m" : ""} com o cliente (${names}) roda${flows.length > 1 ? "m" : ""} quando o agente encerra (chave da organização ligada): mensagem do fluxo em cima do pós-encerramento do agente.`,
      evidence: flows.map((f) => f.id).join(","),
    });
  } else {
    add({
      code: "fluxo_encerramento_nao_roda_pelo_agente",
      severity: "avisa",
      path: "closure",
      message: `Fluxo${flows.length > 1 ? "s" : ""} de automação “Conversa encerrada” que fala${flows.length > 1 ? "m" : ""} com o cliente (${names}) não roda${flows.length > 1 ? "m" : ""} quando o agente encerra: a chave “rodar fluxos no encerramento pelo agente” está desligada na organização. Se o fluxo é pensado para o agente, ligue a chave; se não, nada a fazer.`,
      evidence: flows.map((f) => f.id).join(","),
    });
  }
}

// ─── Entrada ─────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<ValidationSeverity, number> = { bloqueia: 0, avisa: 1 };

/** Achados de um agente, com os dados da organização já carregados (puro). */
export function validateAgentConfig(agentId: string, data: ConfigValidationData): ValidationFinding[] {
  const agent = data.agents.find((a) => a.id === agentId);
  if (!agent) return [];
  const findings: ValidationFinding[] = [];
  const add = (f: Omit<ValidationFinding, "agentId">) => findings.push({ ...f, agentId });
  validateRouting(agent, data, add);
  validateThemes(agent.config, add);
  validateCalendar(agent.config, data.now ?? new Date(), add);
  validateFields(agent.config, add);
  validateTabulation(agent.config, data, add);
  validateAutomations(data, add);
  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function blockingFindings(findings: ValidationFinding[]): ValidationFinding[] {
  return findings.filter((f) => f.severity === "bloqueia");
}

// ─── Carregamento ────────────────────────────────────────────────────────

type Db = {
  aIAgentConfig: { findMany: (args: unknown) => Promise<Array<{ id: string; active: boolean; engine: string; createdAt: Date; simpleConfig: unknown; draftConfig: unknown; user: { name: string } | null }>> };
  department: { findMany: (args: unknown) => Promise<Array<{ id: string; name: string; _count: { members: number } }>> };
  user: { findMany: (args: unknown) => Promise<Array<{ id: string; name: string }>> };
  distributionRule: { findMany: (args: unknown) => Promise<Array<{ id: string; name: string }>> };
  automation: { findMany: (args: unknown) => Promise<Array<{ id: string; name: string; triggerType: string; active: boolean; steps: Array<{ type: string; config: unknown }> }>> };
};

/**
 * Dados da organização para os validadores. O agente em `draftAgentId` entra
 * com o rascunho (o que será publicado); os outros, com a versão publicada —
 * é ela que atende.
 */
export async function loadConfigValidationData(organizationId: string, draftAgentId?: string): Promise<ConfigValidationData> {
  const db = prisma as unknown as Db;
  const safe = <T,>(p: Promise<T>, fallback: T, what: string) => p.catch((err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : err, what }, "[config-validators] carga parcial");
    return fallback;
  });
  const [rows, departments, users, distributionRules, automations, tabulations, runOnAiClose] = await Promise.all([
    db.aIAgentConfig.findMany({ where: { organizationId, engine: "simple" }, select: { id: true, active: true, engine: true, createdAt: true, simpleConfig: true, draftConfig: true, user: { select: { name: true } } } }),
    safe(db.department.findMany({ where: { organizationId }, select: { id: true, name: true, _count: { select: { members: true } } } }), [], "departments"),
    safe(db.user.findMany({ where: { organizationId, type: "HUMAN" }, select: { id: true, name: true } }), [], "users"),
    safe(db.distributionRule.findMany({ where: { organizationId }, select: { id: true, name: true } }), [], "distributionRules"),
    safe(db.automation.findMany({ where: { organizationId, active: true }, select: { id: true, name: true, triggerType: true, active: true, steps: { select: { type: true, config: true } } } }), [], "automations"),
    safe(import("@/services/tabulations").then(({ listActiveTabulationLeaves }) => listActiveTabulationLeaves({ organizationId })), [] as Array<{ id: string; path: string; departmentName: string }>, "tabulations"),
    safe(getOrgSettingBool(RUN_ON_AI_CLOSE_KEY, false), false, "runOnAiClose"),
  ]);
  const agents: ValidationAgent[] = [];
  for (const r of rows) {
    const raw = r.id === draftAgentId ? (r.draftConfig ?? r.simpleConfig) : r.simpleConfig;
    if (!raw) continue;
    try {
      agents.push({ id: r.id, name: r.user?.name ?? r.id, active: r.active, engine: r.engine, createdAt: new Date(r.createdAt), config: normalizeV2Config(raw) });
    } catch (err) {
      log.warn({ agentId: r.id, err: err instanceof Error ? err.message : err }, "[config-validators] config inválida ignorada");
    }
  }
  return {
    agents,
    departments: departments.map((d) => ({ id: d.id, name: d.name, memberCount: d._count?.members ?? 0 })),
    users,
    distributionRules,
    tabulations: tabulations.map((t) => ({ id: t.id, name: `${t.departmentName} › ${t.path}` })),
    automations: automations.map((a) => ({ ...a, steps: a.steps.map((s) => ({ type: s.type, config: (s.config && typeof s.config === "object" ? s.config : {}) as Record<string, unknown> })) })),
    runOnAiClose,
  };
}

/** Achados do agente (rascunho) contra a organização. */
export async function validateV2AgentConfig(organizationId: string, agentId: string): Promise<ValidationFinding[]> {
  const data = await loadConfigValidationData(organizationId, agentId);
  return validateAgentConfig(agentId, data);
}

/** Mapa de roteamento da organização (versões publicadas). */
export async function getV2RoutingMap(organizationId: string): Promise<RoutingMap> {
  const data = await loadConfigValidationData(organizationId);
  return buildRoutingMap(data);
}
