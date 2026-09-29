/**
 * "Aprender com conversas" — partes sem banco e sem modelo: termos de busca,
 * recorte da transcrição, leitura da classificação e checagem da citação do
 * cliente. O assunto vem do usuário; nada de domínio de cliente aqui.
 */

import { maskEvidenceText } from "./feedback-extract";

export type LearnWho = "human" | "agent" | "both";

export type LearnParams = {
  /** Assunto em palavras do usuário (ex.: o processo que ele quer documentar). */
  topic: string;
  days: 30 | 90 | 180;
  /** Só conversas com estas tabulações (vazio = qualquer uma). */
  tabulationIds: string[];
  /** De quem são as respostas que servem de exemplo. */
  who: LearnWho;
  /** Só atendimentos encerrados. */
  onlyResolved: boolean;
};

export const LEARN_LIMITS = { maxTerms: 10, maxCandidates: 150, maxAnalyzed: 40, maxTranscriptChars: 7000, maxMessages: 60, maxDocs: 3, concurrency: 4 };

export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Termos para o ILIKE: o assunto, os sinônimos do modelo e as versões sem
 * acento (o banco não tem `unaccent` garantido). Curtos demais casam com
 * tudo e ficam de fora.
 */
export function searchTerms(topic: string, extra: string[]): string[] {
  const out = new Set<string>();
  for (const raw of [topic, ...extra]) {
    const t = raw.replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (t.length < 4) continue;
    out.add(t);
    const f = fold(t);
    if (f !== t) out.add(f);
  }
  return [...out].slice(0, LEARN_LIMITS.maxTerms * 2);
}

export type LearnMessage = { direction: string; authorType: string; content: string | null; createdAt: Date | string; isAi?: boolean };

/** Quem falou, como a transcrição mostra. */
export function speaker(m: LearnMessage): "Cliente" | "Equipe" | "Agente IA" | "Automação" {
  if (m.direction === "in") return "Cliente";
  if (m.authorType === "human") return "Equipe";
  return m.isAi ? "Agente IA" : "Automação";
}

/**
 * Recorte da conversa em volta do assunto: a partir de 3 mensagens antes da
 * primeira que cita um termo, até o limite de mensagens e caracteres.
 * Mascarado (documento, telefone, e-mail, nomes).
 */
export function buildTranscript(messages: LearnMessage[], terms: string[], names: string[] = []): { text: string; clientText: string; hitIndex: number } {
  const clean = messages.filter((m) => (m.content ?? "").trim());
  const folded = terms.map(fold);
  let hit = clean.findIndex((m) => m.direction === "in" && folded.some((t) => fold(m.content ?? "").includes(t)));
  if (hit < 0) hit = 0;
  const slice = clean.slice(Math.max(0, hit - 3), Math.max(0, hit - 3) + LEARN_LIMITS.maxMessages);
  const lines: string[] = [];
  let size = 0;
  for (const m of slice) {
    const line = `${speaker(m)}: ${maskEvidenceText((m.content ?? "").trim(), names).slice(0, 1200)}`;
    if (size + line.length > LEARN_LIMITS.maxTranscriptChars) break;
    lines.push(line);
    size += line.length + 1;
  }
  const clientText = slice
    .filter((m) => m.direction === "in")
    .map((m) => maskEvidenceText(m.content ?? "", names))
    .join("\n");
  return { text: lines.join("\n"), clientText, hitIndex: hit };
}

export type LearnAnalysis = {
  onTopic: boolean;
  outcome: "resolved" | "unresolved" | "unclear";
  /** Trecho do cliente que mostra que deu certo. */
  clientConfirmation: string | null;
  clientAsked: string;
  steps: string[];
  issues: string[];
  requirements: string[];
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown, max = 15) =>
  Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : [];

/**
 * JSON do modelo → análise. A confirmação do cliente só vale se o trecho
 * estiver mesmo nas mensagens dele; senão o desfecho vira "unclear".
 */
export function parseAnalysis(raw: unknown, clientText: string): LearnAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const outcome = r.outcome === "resolved" || r.outcome === "unresolved" ? r.outcome : "unclear";
  const quote = str(r.clientConfirmation) || null;
  const quoteOk = !!quote && quote.length >= 2 && fold(clientText).includes(fold(quote).replace(/^["“']|["”']$/g, ""));
  return {
    onTopic: r.onTopic === true,
    outcome: outcome === "resolved" && !quoteOk ? "unclear" : outcome,
    clientConfirmation: quoteOk ? quote : null,
    clientAsked: str(r.clientAsked).slice(0, 300),
    steps: strList(r.steps),
    issues: strList(r.issues, 10),
    requirements: strList(r.requirements, 10),
  };
}

/**
 * Serve de exemplo: no assunto e deu certo. Com filtro de tabulação (o
 * usuário escolheu as que indicam sucesso), "não ficou claro" também vale;
 * "não resolveu" nunca.
 */
export function isSuccess(a: LearnAnalysis, tabulationFiltered: boolean): boolean {
  if (!a.onTopic || a.steps.length === 0) return false;
  if (a.outcome === "resolved") return true;
  return tabulationFiltered && a.outcome === "unclear";
}

export type LearnDocDraft = { title: string; content: string; basedOn: number[] };

/** JSON da síntese → rascunhos (índices 1-based das conversas de apoio). */
export function parseDocs(raw: unknown, successCount: number): LearnDocDraft[] {
  const docs = (raw as { docs?: unknown } | null)?.docs;
  if (!Array.isArray(docs)) return [];
  const out: LearnDocDraft[] = [];
  for (const d of docs) {
    if (out.length >= LEARN_LIMITS.maxDocs) break;
    const title = str((d as Record<string, unknown>)?.title).slice(0, 200);
    const content = str((d as Record<string, unknown>)?.content);
    if (!title || content.length < 40) continue;
    const basedOn = [...new Set(((d as { basedOn?: unknown }).basedOn as unknown[] | undefined ?? [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= successCount))].sort((a, b) => a - b);
    out.push({ title, content, basedOn });
  }
  return out;
}
