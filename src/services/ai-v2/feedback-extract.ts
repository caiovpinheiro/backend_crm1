/**
 * Feedback do agente — parte pura: dos logs de turno e dos pontos do
 * comparador para fatos por turno, candidatos a problema e regras
 * determinísticas. Sem banco e sem modelo (testável).
 * Nenhum domínio de cliente: só a configuração e as conversas como dado.
 */

import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { maskSensitive } from "./sensitive";
import { hasSearchableQuestion } from "./ground-reply";

export type FeedbackSourceType = "turn" | "test_turn" | "replay_point";

/** Categorias finais de um item do relatório. */
export const FEEDBACK_CATEGORIES = [
  "material_faltando",
  "material_nao_liberado",
  "busca_nao_achou",
  "material_ruim",
  "instrucao_assunto",
  "regra_global",
  "reconhecimento_assunto",
  "tom",
  "transferencia_desnecessaria",
  "transferencia_faltando",
  "acao_nao_liberada",
  "mensagem_pronta",
  "escopo",
  "midia",
  "integracao",
  "motor",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export type TurnFacts = {
  sourceType: FeedbackSourceType;
  sourceId: string;
  conversationId: string;
  at: string;
  client: string;
  /** Mensagens anteriores da conversa (mais antigas primeiro). */
  previous: Array<{ role: "user" | "assistant"; content: string }>;
  agent: string;
  human?: string;
  reason?: string;
  themeId?: string | null;
  themeMethod?: string | null;
  themeSimilarity?: number | null;
  handoff: boolean;
  handoffCause?: string | null;
  outOfScope?: boolean;
  prefetch?: { searched: boolean; searchable?: boolean; found: number; docIds: string[]; truncatedDocIds: string[] } | null;
  sources: Array<{ docId?: string; title: string; content: string }>;
  unsupported: string[];
  forcedHandoff: boolean;
  discarded: Array<{ type: string; modelId?: string }>;
  error?: string | null;
  replay?: {
    outcome: string | null;
    causa: string;
    inventou: boolean;
    invencao: string;
    humanoConsultouSistema: boolean;
    tom: string;
    explicacao: string;
  };
  feedback?: { comment: string; categoria?: string | null };
};

export type Candidate = TurnFacts & {
  id: string;
  /** 1–5: inventou 5 · incorreto 4 · transferência errada 3 · lacuna 3 · reconhecimento/ação 2 · tom/escopo 1. */
  severity: number;
  /** Peso da fonte: produção 1 · comparação 0,8 · teste 0,6. */
  weight: number;
  /** Já classificado sem modelo. */
  deterministic?: { category: FeedbackCategory; need: string; key: string };
};

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

/** Causas de transferência que não são problema do agente. */
const EXPECTED_HANDOFF = new Set(["rule", "direct_theme", "media", "identification", "onboarding", "human_request", "cost_cap", "sentiment", "limit"]);

const REPLAY_SEVERITY: Record<string, number> = {
  inventou: 5,
  incorreto: 4,
  deveria_transferir: 3,
  transferiu_sem_precisar: 3,
  diferente: 2,
};

export const SOURCE_WEIGHT: Record<FeedbackSourceType, number> = { turn: 1, replay_point: 0.8, test_turn: 0.6 };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

type TraceStep = { step?: string; detail?: string; data?: Record<string, unknown> };

/** Logs antigos não têm `facts`: lê o mesmo do rastro (prefixos fixos do motor). */
function factsFromTrace(trace: TraceStep[]): {
  prefetch: TurnFacts["prefetch"];
  unsupported: string[];
  forcedHandoff: boolean;
  themeMethod: string | null;
} {
  let prefetch: TurnFacts["prefetch"] = null;
  const unsupported: string[] = [];
  let forcedHandoff = false;
  let themeMethod: string | null = null;
  for (const s of trace) {
    const d = s.detail ?? "";
    if (s.step === "base") {
      const found = /^Encontrou (\d+) trecho/.exec(d);
      if (found) prefetch = { searched: true, found: Number(found[1]), docIds: [], truncatedDocIds: [] };
      else if (d.startsWith("Nenhum trecho relevante")) prefetch = { searched: true, found: 0, docIds: [], truncatedDocIds: [] };
      else if (d.startsWith("Mensagem sem pergunta")) prefetch = { searched: false, searchable: false, found: 0, docIds: [], truncatedDocIds: [] };
    }
    if (s.step === "verificação") {
      const m = /^Resposta cita (.+), que não está/.exec(d);
      if (m) unsupported.push(...m[1].split(/,\s*/).filter(Boolean));
      if (d.startsWith("A reescrita ainda cita")) forcedHandoff = true;
    }
    if (s.step === "assunto" && typeof s.data?.method === "string") themeMethod = s.data.method;
  }
  return { prefetch, unsupported, forcedHandoff, themeMethod };
}

/** Causa de transferência de logs antigos (sem `facts.handoffCause`). */
function inferHandoffCause(prompt: string, reason: string): string {
  if (prompt === "rule") return "rule";
  if (prompt === "media handoff") return "media";
  if (reason.startsWith("Citava ")) return "verification";
  if (reason.startsWith("Consulta sem resultados") || reason.startsWith("Limite de chamadas")) return "no_source";
  if (reason.startsWith("Assunto com transferência direta")) return "direct_theme";
  return "model";
}

export type TurnLogRow = {
  id: string;
  conversationId: string;
  createdAt: Date | string;
  inboundText: string;
  reply: string | null;
  handoff: boolean;
  error: string | null;
  prompt: string;
  contextSnapshot: unknown;
  llmOutput: unknown;
  discardedActions: unknown;
  feedback: unknown;
};

/**
 * Fatos de cada turno de log. `previous` vem dos turnos anteriores da mesma
 * conversa no período (o log não guarda o histórico).
 */
export function factsFromTurnLogs(rows: TurnLogRow[], isTest: (conversationId: string, snapshotSource?: string) => boolean): TurnFacts[] {
  const byConversation = new Map<string, TurnLogRow[]>();
  for (const r of rows) {
    const list = byConversation.get(r.conversationId) ?? [];
    list.push(r);
    byConversation.set(r.conversationId, list);
  }
  const out: TurnFacts[] = [];
  for (const list of byConversation.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const history: TurnFacts["previous"] = [];
    for (const r of list) {
      if (r.prompt === "reset") {
        history.length = 0;
        continue;
      }
      if (r.error && SKIP_ERRORS.some((e) => r.error!.startsWith(e))) continue;
      const snap = asRecord(r.contextSnapshot);
      const facts = asRecord(snap.facts);
      const llm = asRecord(r.llmOutput);
      const trace = Array.isArray(snap.trace) ? (snap.trace as TraceStep[]) : [];
      const fromTrace = factsFromTrace(trace);
      const prefetchFact = asRecord(facts.prefetch);
      const verification = asRecord(facts.verification);
      const theme = asRecord(facts.theme);
      const reason = typeof llm.reason === "string" ? llm.reason : "";
      const source = typeof facts.source === "string" ? facts.source : undefined;
      const toolCalls = Array.isArray(snap.toolCalls) ? (snap.toolCalls as Array<Record<string, unknown>>) : [];
      const sources = toolCalls
        .filter((c) => c.toolName === "knowledge_search")
        .flatMap((c) => {
          const chunks = asRecord(c.result).chunks;
          return Array.isArray(chunks) ? (chunks as Array<Record<string, unknown>>) : [];
        })
        .map((c) => ({ docId: typeof c.docId === "string" ? c.docId : undefined, title: String(c.docTitle ?? ""), content: String(c.content ?? "") }));
      const discarded = Array.isArray(r.discardedActions)
        ? (r.discardedActions as Array<Record<string, unknown>>).map((a) => ({
            type: String(a.type ?? "?"),
            ...(typeof a.modelId === "string" ? { modelId: a.modelId } : {}),
          }))
        : [];
      const fb = asRecord(r.feedback);
      const diag = asRecord(fb.diagnosis);
      out.push({
        sourceType: isTest(r.conversationId, source) ? "test_turn" : "turn",
        sourceId: r.id,
        conversationId: r.conversationId,
        at: new Date(r.createdAt).toISOString(),
        client: r.inboundText ?? "",
        previous: history.slice(-4),
        agent: r.reply ?? (typeof llm.reply === "string" ? llm.reply : ""),
        reason,
        themeId: (typeof theme.themeId === "string" ? theme.themeId : null) ?? (typeof snap.themeId === "string" ? snap.themeId : null),
        themeMethod: typeof theme.method === "string" ? theme.method : fromTrace.themeMethod,
        themeSimilarity: typeof theme.similarity === "number" ? theme.similarity : null,
        handoff: r.handoff,
        handoffCause: r.handoff ? (typeof facts.handoffCause === "string" ? facts.handoffCause : inferHandoffCause(r.prompt, reason)) : null,
        outOfScope: llm.outOfScope === true,
        prefetch: Object.keys(prefetchFact).length > 0
          ? {
              searched: prefetchFact.searched === true,
              searchable: prefetchFact.searchable !== false,
              found: Number(prefetchFact.found ?? 0),
              docIds: Array.isArray(prefetchFact.docIds) ? (prefetchFact.docIds as string[]) : [],
              truncatedDocIds: Array.isArray(prefetchFact.truncatedDocIds) ? (prefetchFact.truncatedDocIds as string[]) : [],
            }
          : fromTrace.prefetch,
        sources,
        unsupported: Array.isArray(verification.unsupported) ? (verification.unsupported as string[]) : fromTrace.unsupported,
        forcedHandoff: verification.forcedHandoff === true || fromTrace.forcedHandoff,
        discarded,
        error: r.error,
        ...(typeof fb.comment === "string"
          ? { feedback: { comment: fb.comment, categoria: typeof diag.categoria === "string" ? diag.categoria : null } }
          : {}),
      });
      if (r.inboundText) history.push({ role: "user", content: r.inboundText });
      if (r.reply) history.push({ role: "assistant", content: r.reply });
    }
  }
  return out;
}

export type ReplayItemFactsRow = {
  id: string;
  conversationId: string;
  at: Date | string | null;
  clientText: string;
  humanText: string;
  agentText: string | null;
  agentHandoff: boolean;
  sources: unknown;
  verdict: unknown;
  skipReason: string | null;
  error: string | null;
  history: unknown;
  facts: unknown;
  outcome: string | null;
};

export function factsFromReplayItems(rows: ReplayItemFactsRow[]): TurnFacts[] {
  const out: TurnFacts[] = [];
  for (const r of rows) {
    if (r.skipReason || !r.verdict) continue;
    const v = asRecord(r.verdict);
    const f = asRecord(r.facts);
    const prefetchFact = asRecord(f.prefetch);
    const verification = asRecord(f.verification);
    const theme = asRecord(f.theme);
    const srcs = Array.isArray(r.sources) ? (r.sources as Array<Record<string, unknown>>) : [];
    out.push({
      sourceType: "replay_point",
      sourceId: r.id,
      conversationId: r.conversationId,
      at: r.at ? new Date(r.at).toISOString() : new Date(0).toISOString(),
      client: r.clientText,
      previous: Array.isArray(r.history) ? (r.history as TurnFacts["previous"]).slice(-4) : [],
      agent: r.agentText ?? "",
      human: r.humanText,
      reason: typeof f.reason === "string" ? f.reason : undefined,
      themeId: typeof f.themeId === "string" ? f.themeId : null,
      themeMethod: typeof theme.method === "string" ? theme.method : null,
      themeSimilarity: typeof theme.similarity === "number" ? theme.similarity : null,
      handoff: r.agentHandoff,
      handoffCause: r.agentHandoff ? (typeof f.handoffCause === "string" ? f.handoffCause : "model") : null,
      prefetch: Object.keys(prefetchFact).length > 0
        ? {
            searched: prefetchFact.searched === true,
            searchable: prefetchFact.searchable !== false,
            found: Number(prefetchFact.found ?? 0),
            docIds: Array.isArray(prefetchFact.docIds) ? (prefetchFact.docIds as string[]) : [],
            truncatedDocIds: Array.isArray(prefetchFact.truncatedDocIds) ? (prefetchFact.truncatedDocIds as string[]) : [],
          }
        : null,
      sources: srcs.map((s) => ({ title: String(s.title ?? ""), content: String(s.content ?? "") })),
      unsupported: Array.isArray(verification.unsupported) ? (verification.unsupported as string[]) : [],
      forcedHandoff: verification.forcedHandoff === true,
      discarded: Array.isArray(f.discardedActions) ? (f.discardedActions as string[]).map((t) => ({ type: t })) : [],
      error: r.error,
      replay: {
        outcome: r.outcome,
        causa: String(v.causa ?? "ok"),
        inventou: v.inventou === true,
        invencao: String(v.invencao ?? ""),
        humanoConsultouSistema: v.humanoConsultouSistema === true,
        tom: String(v.tom ?? "adequado"),
        explicacao: String(v.explicacao ?? ""),
      },
    });
  }
  return out;
}

function contentWords(text: string): number {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4).length;
}

/**
 * O que merece análise. Turno que deu certo não vai ao modelo; só conta no
 * volume. Parte já sai classificada por regra (descartes, mídia, integração,
 * falha técnica).
 */
export function selectCandidates(all: TurnFacts[], config: V2AgentConfig): Candidate[] {
  const out: Candidate[] = [];
  let n = 0;
  const hasThemes = (config.themes ?? []).length > 0;
  for (const f of all) {
    const base = { ...f, id: `c${++n}`, weight: SOURCE_WEIGHT[f.sourceType] };

    // Falha técnica do agente (não "turno ignorado").
    if (f.error && !f.agent && f.sourceType !== "replay_point") {
      out.push({ ...base, severity: 2, deterministic: { category: "motor", need: clip(f.error, 120), key: `motor:${f.error.slice(0, 40)}` } });
      continue;
    }

    // Ação ou mensagem pronta que o modelo quis usar e a configuração barrou.
    const disc = f.discarded.filter((d) => d.type !== "handoff");
    if (disc.length > 0) {
      for (const d of disc) {
        const isModel = d.type === "send_message_model";
        out.push({
          ...base,
          id: `c${++n}`,
          severity: 2,
          deterministic: {
            category: isModel ? "mensagem_pronta" : "acao_nao_liberada",
            need: isModel ? "Mensagem pronta pedida que não está liberada" : `Ação "${d.type}" pedida sem estar liberada`,
            key: isModel ? `msg:${d.modelId ?? "?"}` : `acao:${d.type}`,
          },
        });
      }
    }

    if (f.replay) {
      const outcome = f.replay.outcome ?? "";
      if (["igual", "parcial", "transferiu_certo"].includes(outcome)) continue;
      const severity = REPLAY_SEVERITY[outcome] ?? 2;
      if (f.replay.causa === "midia" || f.replay.causa === "integracao") {
        out.push({
          ...base,
          severity,
          deterministic: { category: f.replay.causa, need: clip(f.replay.explicacao || f.client, 140), key: `${f.replay.causa}:${f.themeId ?? ""}` },
        });
        continue;
      }
      out.push({ ...base, severity: f.replay.tom === "inadequado" && severity < 2 ? 1 : severity });
      continue;
    }

    let severity = 0;
    if (f.forcedHandoff) severity = Math.max(severity, 5);
    else if (f.unsupported.length > 0) severity = Math.max(severity, 4);
    if (f.feedback) severity = Math.max(severity, 4);
    if (f.handoff && f.handoffCause && !EXPECTED_HANDOFF.has(f.handoffCause)) severity = Math.max(severity, 3);
    if (f.prefetch?.searched && f.prefetch.found === 0 && hasSearchableQuestion(f.client)) severity = Math.max(severity, 3);
    if (hasThemes && f.themeMethod === "none" && contentWords(f.client) >= 4) severity = Math.max(severity, 2);
    if (f.outOfScope) severity = Math.max(severity, 1);
    if (severity > 0) out.push({ ...base, severity });
  }
  return out;
}

/** Cosseno entre vetores de embedding. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Agrupa por ligação simples: dois itens ficam juntos quando o cosseno das
 * "necessidades" passa do limiar. Devolve listas de índices.
 */
export function clusterByVectors(vectors: number[][], threshold = 0.8): number[][] {
  const parent = vectors.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      if (cosine(vectors[i], vectors[j]) >= threshold) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  vectors.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  return [...groups.values()];
}

/** Máscara para evidências: dados sensíveis, nomes e telefones do contato. */
export function maskEvidenceText(text: string, names: string[] = []): string {
  let out = maskSensitive(text).text;
  const parts = [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/)]).map((n) => n.trim()).filter((n) => n.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  if (parts.length > 0) {
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu"), "[nome]");
  }
  return out.replace(/\(?\+?\d[\d\s().-]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "[telefone]" : m));
}

/** Etiquetas curtas dos fatos para mostrar junto da evidência. */
export function factPills(f: TurnFacts, themeName: (id: string) => string | undefined): string[] {
  const pills: string[] = [];
  if (f.themeId) pills.push(`assunto: ${themeName(f.themeId) ?? f.themeId}${f.themeMethod === "semantic" ? " (sentido)" : f.themeMethod === "trigger" ? " (palavras)" : ""}`);
  else if (f.themeMethod === "none") pills.push("nenhum assunto");
  if (f.prefetch?.searched) pills.push(f.prefetch.found > 0 ? `buscou: ${f.prefetch.found} trecho(s)` : "buscou: nada encontrado");
  if (f.unsupported.length > 0) pills.push(`citou sem fonte: ${clip(f.unsupported.join(", "), 80)}`);
  if (f.handoff) pills.push(`transferiu${f.handoffCause ? `: ${HANDOFF_CAUSE_LABEL[f.handoffCause] ?? f.handoffCause}` : ""}`);
  if (f.discarded.length > 0) pills.push(`descartou: ${f.discarded.map((d) => d.type).join(", ")}`);
  if (f.replay?.outcome) pills.push(`comparação: ${f.replay.outcome.replace(/_/g, " ")}`);
  if (f.feedback) pills.push("marcado como erro");
  return pills;
}

export const HANDOFF_CAUSE_LABEL: Record<string, string> = {
  model: "decisão do modelo",
  human_request: "cliente pediu pessoa",
  verification: "citava algo sem fonte",
  no_source: "sem material",
  rule: "atalho",
  direct_theme: "assunto só encaminha",
  media: "mídia",
  identification: "identificação",
  onboarding: "etapa travada",
  sentiment: "cliente insatisfeito",
  limit: "limite",
  guard: "promessa de retorno",
  message_model_not_allowed: "mensagem pronta não liberada",
  message_model_failed: "mensagem pronta não enviada",
  error: "erro do modelo",
  cost_cap: "limite de custo",
};
