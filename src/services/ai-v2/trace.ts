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

type TraceStore = { startedAt: number; steps: V2TraceStep[]; logged: boolean };

const store = new AsyncLocalStorage<TraceStore>();

const MAX_STEPS = 60;
const MAX_DETAIL = 300;

export function runWithV2Trace<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ startedAt: Date.now(), steps: [], logged: false }, fn);
}

/** Registra um passo no turno corrente. Fora de um turno não faz nada. */
export function traceStep(step: string, detail: string, data?: Record<string, unknown>): void {
  const s = store.getStore();
  if (!s || s.steps.length >= MAX_STEPS) return;
  s.steps.push({
    step,
    detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail,
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

/** O turno já gravou log? (o motor grava um log de erro quando não gravou) */
export function v2TraceWasLogged(): boolean {
  return store.getStore()?.logged ?? false;
}
