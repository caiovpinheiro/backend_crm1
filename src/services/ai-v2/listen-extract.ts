/**
 * "Escutar a equipe" — partes sem banco e sem modelo: quem escreveu cada
 * mensagem, transcrição com a pessoa escutada marcada como "Referência",
 * leitura da análise do modelo, agregação por frequência (um jeito de
 * atender só vira proposta quando se repete) e conversão das propostas em
 * alterações da configuração. Nenhum domínio de cliente: as conversas são
 * dado e os textos são genéricos.
 */

import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { getAtPath, type V2ConfigChange } from "./config-patch";
import { clusterByVectors, maskEvidenceText } from "./feedback-extract";
import { fold, type LearnMessage } from "./learn-extract";

export const LISTEN_LIMITS = {
  maxPeople: 10,
  /** Conversas analisadas por varredura. */
  batch: 20,
  concurrency: 3,
  maxTranscriptChars: 7000,
  maxMessages: 60,
  /** A pessoa escutada precisa ter escrito pelo menos isso na conversa. */
  minReferenceMessages: 2,
  /** Um jeito de atender vira proposta com pelo menos N conversas… */
  minOccurrences: 3,
  /** …e em pelo menos esta fração das conversas lidas. */
  minShare: 0.35,
  maxProposalsPerKind: 8,
  clusterThreshold: 0.82,
  /** Pergunta já respondida por um material com esta similaridade: não propõe. */
  coveredSimilarity: 0.85,
  /** Tokens por conversa analisada, para a estimativa. */
  tokensInPerConversation: 2000,
  tokensOutPerConversation: 600,
};

export type ListenMode = "today" | "days" | "range" | "continuous";
export type ListenStatus = "on" | "paused" | "expired" | "off";

// ─── Período e estado ───────────────────────────────────────────────────

function brDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Início do dia de hoje no horário de Brasília. */
export function startOfTodayBrazil(now: Date = new Date()): Date {
  return new Date(`${brDay(now)}T00:00:00-03:00`);
}

/** Fim da escuta: hoje 23:59:59 (Brasília), N dias, data escolhida ou sem fim. */
export function listenEndsAt(mode: ListenMode, opts: { days?: number; endsAt?: string | Date | null }, now: Date = new Date()): Date | null {
  if (mode === "continuous") return null;
  if (mode === "today") return new Date(`${brDay(now)}T23:59:59-03:00`);
  if (mode === "days") {
    const days = Math.min(Math.max(Math.round(opts.days ?? 7), 1), 90);
    return new Date(new Date(`${brDay(now)}T23:59:59-03:00`).getTime() + (days - 1) * 86_400_000);
  }
  const end = opts.endsAt ? new Date(opts.endsAt) : null;
  if (!end || Number.isNaN(end.getTime()) || end.getTime() <= now.getTime()) throw new Error("Escolha uma data de fim no futuro.");
  return end;
}

/** Ligada com o prazo vencido conta como encerrada; pausada não vence. */
export function effectiveListenStatus(s: { status: ListenStatus; endsAt: Date | string | null }, now: Date = new Date()): ListenStatus {
  if (s.status === "on" && s.endsAt && new Date(s.endsAt).getTime() < now.getTime()) return "expired";
  return s.status;
}

// ─── Autoria e transcrição ──────────────────────────────────────────────

export type ListenMessage = LearnMessage & { id: string; senderName?: string | null; userId?: string | null };

/**
 * Quem da equipe escreveu cada mensagem: o evento de envio (quem estava
 * logado) vale mais; sem evento, o nome gravado na mensagem casado com o
 * nome da pessoa. Mensagem de IA ou automação nunca vira da equipe.
 */
export function attributeHumanMessages(
  messages: ListenMessage[],
  actorByMessage: Map<string, string>,
  userByName: Map<string, string>,
): ListenMessage[] {
  return messages.map((m) => {
    if (m.direction !== "out" || m.authorType !== "human") return { ...m, userId: null };
    const byEvent = actorByMessage.get(m.id);
    const byName = m.senderName ? userByName.get(fold(m.senderName)) : undefined;
    return { ...m, userId: byEvent ?? byName ?? null };
  });
}

export type ListenSpeaker = "Cliente" | "Referência" | "Equipe (outra pessoa)" | "Agente IA" | "Automação";

export function listenSpeaker(m: ListenMessage, referenceIds: Set<string>): ListenSpeaker {
  if (m.direction === "in") return "Cliente";
  if (m.authorType === "human") return m.userId && referenceIds.has(m.userId) ? "Referência" : "Equipe (outra pessoa)";
  return m.isAi ? "Agente IA" : "Automação";
}

/**
 * Conversa para o modelo: cada linha com quem falou, mascarada (dados
 * sensíveis, nome do contato e da pessoa escutada, telefones). Devolve
 * também o que a Referência escreveu, para conferir as citações.
 */
export function buildListenTranscript(
  messages: ListenMessage[],
  referenceIds: Set<string>,
  names: string[] = [],
): { text: string; referenceText: string; referenceCount: number } {
  const clean = messages.filter((m) => (m.content ?? "").trim()).slice(0, LISTEN_LIMITS.maxMessages);
  const lines: string[] = [];
  const reference: string[] = [];
  let size = 0;
  for (const m of clean) {
    const who = listenSpeaker(m, referenceIds);
    const content = maskEvidenceText((m.content ?? "").trim(), names).slice(0, 1200);
    const line = `${who}: ${content}`;
    if (size + line.length > LISTEN_LIMITS.maxTranscriptChars) break;
    lines.push(line);
    size += line.length + 1;
    if (who === "Referência") reference.push(content);
  }
  return { text: lines.join("\n"), referenceText: reference.join("\n"), referenceCount: reference.length };
}

// ─── Análise de uma conversa ────────────────────────────────────────────

export type ListenKnowledgeItem = { kind: "fact" | "procedure" | "policy"; question: string; answer: string; quote: string | null };

export type ListenTone = {
  formality: number | null;
  length: "short" | "medium" | "long" | null;
  emojis: "none" | "light" | "moderate" | null;
  bold: "auto" | "key" | "off" | null;
  treatment: string;
  greeting: string;
  signoff: string;
  vocabulary: string[];
  samples: string[];
};

export type ListenAnalysis = {
  outcome: "resolved" | "unresolved" | "unclear";
  knowledge: ListenKnowledgeItem[];
  approach: { opening: string; closing: string; habits: string[]; handoffReason: string };
  tone: ListenTone;
};

const str = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown, max = 10, len = 200) => (Array.isArray(v) ? v.map((x) => str(x, len)).filter(Boolean).slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (list.includes(v as T) ? (v as T) : null);

/** O trecho está mesmo no que a Referência escreveu (ignora aspas e acentos). */
function quoted(quote: string, referenceText: string): boolean {
  const q = fold(quote).replace(/^["“']|["”']$/g, "");
  return q.length >= 4 && fold(referenceText).includes(q);
}

/**
 * JSON do modelo → análise. Citações e exemplos só valem se estiverem no
 * texto da Referência; tudo mascarado. Conhecimento de conversa que não se
 * resolveu é descartado (não aprender o erro); abordagem também.
 */
export function parseSampleAnalysis(raw: unknown, referenceText: string, names: string[] = []): ListenAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const outcome = oneOf(r.outcome, ["resolved", "unresolved", "unclear"] as const) ?? "unclear";
  const mask = (s: string) => maskEvidenceText(s, names);
  const knowledge: ListenKnowledgeItem[] = outcome === "unresolved"
    ? []
    : (Array.isArray(r.knowledge) ? r.knowledge : [])
        .slice(0, 8)
        .map((k: Record<string, unknown>) => {
          const quote = str(k?.quote, 300);
          return {
            kind: oneOf(k?.kind, ["fact", "procedure", "policy"] as const) ?? "fact",
            question: mask(str(k?.question, 300)),
            answer: mask(str(k?.answer, 1200)),
            quote: quote && quoted(quote, referenceText) ? mask(quote) : null,
          };
        })
        .filter((k: ListenKnowledgeItem) => k.question && k.answer.length >= 10);
  const a = (r.approach ?? {}) as Record<string, unknown>;
  const approach = outcome === "unresolved"
    ? { opening: "", closing: "", habits: [], handoffReason: "" }
    : {
        opening: mask(str(a.opening, 300)),
        closing: mask(str(a.closing, 300)),
        habits: strList(a.habits, 8).map(mask),
        handoffReason: mask(str((a.handoff as Record<string, unknown> | undefined)?.reason ?? a.handoffReason, 300)),
      };
  const t = (r.tone ?? {}) as Record<string, unknown>;
  const formality = Number(t.formality);
  const tone: ListenTone = {
    formality: Number.isInteger(formality) && formality >= 1 && formality <= 5 ? formality : null,
    length: oneOf(t.length, ["short", "medium", "long"] as const),
    emojis: oneOf(t.emojis, ["none", "light", "moderate"] as const),
    bold: oneOf(t.bold, ["auto", "key", "off"] as const),
    treatment: str(t.treatment, 40),
    greeting: mask(str(t.greeting, 200)),
    signoff: mask(str(t.signoff, 200)),
    vocabulary: strList(t.vocabulary, 12, 40).map(mask),
    samples: strList(t.samples, 3, 300).filter((s) => quoted(s, referenceText)).map(mask),
  };
  return { outcome, knowledge, approach, tone };
}

// ─── Agregação ──────────────────────────────────────────────────────────

export type ListenSample = { id: string; conversationNumber: number | null; analysis: ListenAnalysis };

export type PatternItem = { text: string; sampleId: string };
/** `textSampleIds[i]` é a conversa de `texts[i]`; `sampleIds` são as conversas distintas. */
export type Pattern = { texts: string[]; textSampleIds: string[]; sampleIds: string[]; occurrences: number };

/**
 * Agrupa textos parecidos (vetores do mesmo tamanho da lista) e conta em
 * quantas conversas diferentes cada grupo aparece.
 */
export function groupPatterns(items: PatternItem[], vectors: number[][], threshold = LISTEN_LIMITS.clusterThreshold): Pattern[] {
  if (items.length === 0) return [];
  return clusterByVectors(vectors, threshold)
    .map((idxs) => {
      const sampleIds = [...new Set(idxs.map((i) => items[i].sampleId))];
      return { texts: idxs.map((i) => items[i].text), textSampleIds: idxs.map((i) => items[i].sampleId), sampleIds, occurrences: sampleIds.length };
    })
    .sort((a, b) => b.occurrences - a.occurrences);
}

/** Só o que se repete: N conversas e uma fração mínima das lidas. */
export function frequentPatterns(patterns: Pattern[], sampleCount: number, limits = LISTEN_LIMITS): Pattern[] {
  if (sampleCount === 0) return [];
  return patterns
    .filter((p) => p.occurrences >= limits.minOccurrences && p.occurrences / sampleCount >= limits.minShare)
    .slice(0, limits.maxProposalsPerKind);
}

/** Itens de abordagem de cada conversa (hábitos, abertura, fecho, motivo de transferir). */
export function approachItems(samples: ListenSample[]): PatternItem[] {
  return samples.flatMap((s) => {
    const a = s.analysis.approach;
    return [
      ...a.habits,
      a.opening ? `Abertura: ${a.opening}` : "",
      a.closing ? `Fecho: ${a.closing}` : "",
      a.handoffReason ? `Chama a equipe quando: ${a.handoffReason}` : "",
    ].filter(Boolean).map((text) => ({ text, sampleId: s.id }));
  });
}

/** Perguntas e respostas de cada conversa (para agrupar pelo sentido). */
export function knowledgeItems(samples: ListenSample[]): Array<PatternItem & { item: ListenKnowledgeItem }> {
  return samples.flatMap((s) => s.analysis.knowledge.map((item) => ({ text: `${item.question}\n${item.answer}`, sampleId: s.id, item })));
}

/**
 * Conhecimento que vale propor: apareceu em 2+ conversas, ou um passo a
 * passo (3+ passos) de uma conversa só — esse vai marcado para confirmar.
 */
export function knowledgeCandidates(
  groups: Pattern[],
  itemsByText: Map<string, ListenKnowledgeItem>,
): Array<{ pattern: Pattern; items: ListenKnowledgeItem[]; itemSampleIds: string[]; confirm: boolean }> {
  const out: Array<{ pattern: Pattern; items: ListenKnowledgeItem[]; itemSampleIds: string[]; confirm: boolean }> = [];
  for (const g of groups) {
    const pairs = g.texts.map((t, i) => [itemsByText.get(t), g.textSampleIds[i]] as const).filter((x): x is readonly [ListenKnowledgeItem, string] => !!x[0]);
    const items = pairs.map((p) => p[0]);
    const itemSampleIds = pairs.map((p) => p[1]);
    const steps = items.some((i) => i.kind === "procedure" && (i.answer.match(/(?:^|\n)\s*\d+[.)]\s/g) ?? []).length >= 3);
    if (g.occurrences >= 2) out.push({ pattern: g, items, itemSampleIds, confirm: false });
    else if (steps) out.push({ pattern: g, items, itemSampleIds, confirm: true });
    if (out.length >= LISTEN_LIMITS.maxProposalsPerKind) break;
  }
  return out;
}

export type ToneAggregate = {
  sampleCount: number;
  formality: number | null;
  length: ListenTone["length"];
  emojis: ListenTone["emojis"];
  bold: ListenTone["bold"];
  treatment: string;
  greetings: string[];
  signoffs: string[];
  vocabulary: string[];
  samples: string[];
};

function mode<T>(values: Array<T | null | undefined | "">): T | null {
  const counts = new Map<T, number>();
  for (const v of values) if (v !== null && v !== undefined && v !== "") counts.set(v as T, (counts.get(v as T) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

function top(values: string[], k: number): string[] {
  const counts = new Map<string, { text: string; n: number }>();
  for (const v of values) {
    const key = fold(v);
    if (!key) continue;
    const cur = counts.get(key) ?? { text: v, n: 0 };
    cur.n += 1;
    counts.set(key, cur);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, k).map((x) => x.text);
}

/** Tom da equipe escutada: o mais comum em cada traço. Só com conversas suficientes. */
export function aggregateTone(samples: ListenSample[], minOccurrences = LISTEN_LIMITS.minOccurrences): ToneAggregate | null {
  if (samples.length < minOccurrences) return null;
  const t = samples.map((s) => s.analysis.tone);
  return {
    sampleCount: samples.length,
    formality: mode(t.map((x) => x.formality)),
    length: mode(t.map((x) => x.length)),
    emojis: mode(t.map((x) => x.emojis)),
    bold: mode(t.map((x) => x.bold)),
    treatment: mode(t.map((x) => fold(x.treatment))) ?? "",
    greetings: top(t.map((x) => x.greeting), 3),
    signoffs: top(t.map((x) => x.signoff), 3),
    vocabulary: top(t.flatMap((x) => x.vocabulary), 8),
    samples: top(t.flatMap((x) => x.samples), 3),
  };
}

// ─── Propostas → alterações na configuração ─────────────────────────────

/** Contém o nome (ou parte dele) de uma pessoa escutada. */
export function mentionsPerson(text: string, names: string[]): boolean {
  const t = ` ${fold(text).replace(/[^a-z0-9]+/g, " ")} `;
  return names
    .flatMap((n) => [n, ...n.split(/\s+/)])
    .map((n) => fold(n).replace(/[^a-z0-9]+/g, " ").trim())
    .filter((n) => n.length >= 3)
    .some((n) => t.includes(` ${n} `));
}

export type ToneDraft = {
  tone: string;
  responseLength?: "short" | "medium" | "long" | null;
  emojis?: "none" | "light" | "moderate" | null;
  bold?: "auto" | "key" | "off" | null;
  examples?: string[];
};

/**
 * Proposta de tom → alterações: texto do tom (com exemplos de como a equipe
 * escreve) e formato. Só entra o campo que muda. Texto com o nome de quem
 * foi escutado é recusado (o agente não pode se passar pela pessoa).
 */
export function toneChanges(config: V2AgentConfig, draft: ToneDraft, personNames: string[]): V2ConfigChange[] {
  const examples = (draft.examples ?? []).filter((e) => e.trim() && !mentionsPerson(e, personNames)).slice(0, 3);
  const text = [draft.tone.trim(), examples.length ? `Exemplos de como a equipe escreve:\n${examples.map((e) => `- ${e}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  if (!draft.tone.trim() || mentionsPerson(draft.tone, personNames)) return [];
  const changes: V2ConfigChange[] = [];
  if (text !== getAtPath(config, "tone")) changes.push({ path: "tone", op: "set", value: text });
  for (const key of ["responseLength", "emojis", "bold"] as const) {
    const v = draft[key];
    if (v && v !== getAtPath(config, key)) changes.push({ path: key, op: "set", value: v });
  }
  return changes;
}

export type ApproachDraft = { titulo: string; texto: string; themeId?: string | null };

/**
 * Regra de abordagem → alteração: nas instruções do assunto quando ele
 * existe; senão nas regras gerais. Regra com nome da pessoa é recusada.
 */
export function approachChanges(config: V2AgentConfig, draft: ApproachDraft, personNames: string[]): V2ConfigChange[] {
  const texto = draft.texto.trim();
  if (!texto || mentionsPerson(texto, personNames)) return [];
  const theme = draft.themeId ? config.themes.find((t) => t.id === draft.themeId) : undefined;
  if (theme) {
    if (fold(theme.instructions ?? "").includes(fold(texto))) return [];
    return [{ path: `themes[id=${theme.id}].instructions`, op: "set", value: [theme.instructions?.trim(), texto].filter(Boolean).join("\n") }];
  }
  if ((config.globalRules ?? []).some((r) => fold(r) === fold(texto))) return [];
  return [{ path: "globalRules", op: "add", value: [texto] }];
}

// ─── Custo ──────────────────────────────────────────────────────────────

/** US$ por dia: conversas × tokens por conversa, mais 3 sínteses. */
export function estimateListenCostMath(
  conversationsPerDay: number,
  price: (inputTokens: number, outputTokens: number) => number,
): number {
  if (conversationsPerDay <= 0) return 0;
  const perConversation = price(LISTEN_LIMITS.tokensInPerConversation, LISTEN_LIMITS.tokensOutPerConversation);
  const synth = 3 * price(6000, 2500);
  return Math.round((conversationsPerDay * perConversation + synth) * 1000) / 1000;
}
