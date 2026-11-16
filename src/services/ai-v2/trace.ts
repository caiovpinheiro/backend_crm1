/**
 * Rastro do turno: cada decisão do motor vira um passo curto, gravado junto
 * do log do turno (`contextSnapshot.trace`). É o que a tela de conversas de
 * teste mostra e o que o diagnóstico de erro lê.
 *
 * AsyncLocalStorage em vez de parâmetro: o motor chama muitos módulos
 * (assunto, pré-busca, ações, envio) e todos podem registrar o próprio
 * passo sem que cada assinatura carregue o coletor.
 * Nenhum domínio de cliente.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type V2TraceStep = {
  /** Etapa do motor: "regra", "assunto", "base", "llm", "ação", "resposta"… */
  step: string;
  /** Uma linha, em português, dizendo o que foi decidido e por quê. */
  detail: string;
  /** Dados curtos para quem quiser abrir o passo (ids, similaridade…). */
  data?: Record<string, unknown>;
  /** ms desde o início do turno. */
  at: number;
};

type TraceStore = { startedAt: number; steps: V2TraceStep[]; logged: boolean; facts: Record<string, unknown> };

const store = new AsyncLocalStorage<TraceStore>();

const MAX_STEPS = 60;
const MAX_DETAIL = 300;

export function runWithV2Trace<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ startedAt: Date.now(), steps: [], logged: false, facts: {} }, fn);
}

/**
 * Corta em `max` unidades sem partir um emoji (par surrogate) ao meio. Meio
 * emoji no JSON faz o Prisma recusar o log do turno ("unexpected end of hex
 * escape") e o turno inteiro falhar sem resposta (DNAWORK #83167).
 */
export function sliceWholeChars(s: string, max: number): string {
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Tira metades de emoji soltas (surrogate sem par), que o JSON do banco recusa. */
export function dropLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** Registra um passo no turno corrente. Fora de um turno não faz nada. */
export function traceStep(step: string, detail: string, data?: Record<string, unknown>): void {
  const s = store.getStore();
  if (!s || s.steps.length >= MAX_STEPS) return;
  s.steps.push({
    step,
    detail: detail.length > MAX_DETAIL ? `${sliceWholeChars(detail, MAX_DETAIL)}…` : detail,
    ...(data ? { data } : {}),
    at: Date.now() - s.startedAt,
  });
}

/** Cópia dos passos para gravar no log; marca que o turno foi registrado. */
export function takeV2TraceForLog(): V2TraceStep[] | undefined {
  const s = store.getStore();
  if (!s) return undefined;
  s.logged = true;
  return [...s.steps];
}

/**
 * Fato estruturado do turno (motivo da transferência, busca, verificação…),
 * gravado em `contextSnapshot.facts`. O rastro é texto para pessoas; os fatos
 * são para o relatório de feedback agregar sem ler texto livre.
 * `keepFirst`: o primeiro valor vence (ex.: a primeira causa de transferência).
 */
export function noteV2Fact(key: string, value: unknown, opts?: { keepFirst?: boolean }): void {
  const s = store.getStore();
  if (!s) return;
  if (opts?.keepFirst && s.facts[key] !== undefined) return;
  s.facts[key] = value;
}

/** Valor de um fato já anotado no turno. */
export function peekV2Fact(key: string): unknown {
  return store.getStore()?.facts[key];
}

/** Fatos do turno corrente (cópia). */
export function takeV2Facts(): Record<string, unknown> | undefined {
  const s = store.getStore();
  return s ? { ...s.facts } : undefined;
}

/** O turno já gravou log? (o motor grava um log de erro quando não gravou) */
export function v2TraceWasLogged(): boolean {
  return store.getStore()?.logged ?? false;
}
