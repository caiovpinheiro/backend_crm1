/**
 * Webchat v2 — linha do tempo do site (`BwipoWebchat.track`), parte pura:
 * validação do lote e texto neutro da nota de evento importante
 * (docs/decisoes/webchat-widget.md §9.3). Sem banco.
 *
 * Nada fixo de cliente: nomes de evento, chaves e valores são do site; o
 * rótulo de cada chave vem de `config.v2.context.labels` (sem rótulo = a
 * chave).
 */
import { cleanContextString, type WebchatContextState } from "@/lib/webchat/live-context";
import {
  WEBCHAT_CONTEXT_KEY_RE,
  WEBCHAT_EVENT_MAX_DATA_KEYS,
  WEBCHAT_EVENT_NAME_RE,
} from "@/lib/webchat/v2-config";

/** Janela aceita para o `at` do evento: até 24 h no passado. */
export const WEBCHAT_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Motivo de um evento ignorado no lote (resposta do `POST /events`). */
export type WebchatEventIgnoreReason =
  | "INVALID_EVENT"
  | "INVALID_NAME"
  | "INVALID_DATA"
  | "INVALID_AT"
  | "AT_OUT_OF_RANGE";

export type SanitizedWebchatEvent = {
  /** Posição no lote recebido. */
  index: number;
  name: string;
  data: WebchatContextState | null;
  /** Flag do site (`important: true`); a lista do canal é aplicada depois. */
  flaggedImportant: boolean;
  occurredAt: Date;
};

export type SanitizedWebchatBatch =
  | { ok: false; code: "INVALID_BODY" | "TOO_MANY_EVENTS" }
  | {
      ok: true;
      events: SanitizedWebchatEvent[];
      ignored: { index: number; reason: WebchatEventIgnoreReason }[];
    };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * `data` do evento: objeto raso com até `WEBCHAT_EVENT_MAX_DATA_KEYS`
 * chaves válidas e valores simples (string limpa e cortada, número finito,
 * booleano). `null` numa chave só descarta a chave. Qualquer outra coisa
 * invalida o evento inteiro (`undefined`).
 */
export function sanitizeEventData(
  raw: unknown,
  maxValueChars: number,
): WebchatContextState | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length > WEBCHAT_EVENT_MAX_DATA_KEYS) return undefined;
  const out: WebchatContextState = {};
  for (const [key, value] of entries) {
    if (!WEBCHAT_CONTEXT_KEY_RE.test(key)) return undefined;
    if (value === null) continue;
    if (typeof value === "string") out[key] = cleanContextString(value, maxValueChars);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else return undefined;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * `at` do site: ms epoch ou ISO. Ausente = agora. No futuro (relógio do
 * navegador adiantado) vira agora; mais velho que 24 h é recusado.
 */
export function resolveEventTime(
  raw: unknown,
  now: Date,
): { ok: true; at: Date } | { ok: false; reason: "INVALID_AT" | "AT_OUT_OF_RANGE" } {
  if (raw === undefined || raw === null) return { ok: true, at: now };
  let ms: number;
  if (typeof raw === "number") ms = raw;
  else if (typeof raw === "string" && raw.trim()) ms = Date.parse(raw);
  else return { ok: false, reason: "INVALID_AT" };
  if (!Number.isFinite(ms)) return { ok: false, reason: "INVALID_AT" };
  if (ms > now.getTime()) return { ok: true, at: now };
  if (ms < now.getTime() - WEBCHAT_EVENT_MAX_AGE_MS) return { ok: false, reason: "AT_OUT_OF_RANGE" };
  return { ok: true, at: new Date(ms) };
}

/**
 * Valida o lote `{ events: [...] }`. Lote maior que `maxPerBatch` é
 * recusado inteiro (400 `TOO_MANY_EVENTS`); evento inválido é ignorado
 * com o motivo e os outros seguem.
 */
export function sanitizeWebchatEventBatch(
  raw: unknown,
  limits: { maxPerBatch: number; maxValueChars: number },
  now: Date = new Date(),
): SanitizedWebchatBatch {
  if (!Array.isArray(raw)) return { ok: false, code: "INVALID_BODY" };
  if (raw.length > limits.maxPerBatch) return { ok: false, code: "TOO_MANY_EVENTS" };
  const events: SanitizedWebchatEvent[] = [];
  const ignored: { index: number; reason: WebchatEventIgnoreReason }[] = [];
  raw.forEach((item, index) => {
    if (!isPlainObject(item)) {
      ignored.push({ index, reason: "INVALID_EVENT" });
      return;
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!WEBCHAT_EVENT_NAME_RE.test(name)) {
      ignored.push({ index, reason: "INVALID_NAME" });
      return;
    }
    const data = sanitizeEventData(item.data, limits.maxValueChars);
    if (data === undefined) {
      ignored.push({ index, reason: "INVALID_DATA" });
      return;
    }
    const at = resolveEventTime(item.at, now);
    if (!at.ok) {
      ignored.push({ index, reason: at.reason });
      return;
    }
    events.push({ index, name, data, flaggedImportant: item.important === true, occurredAt: at.at });
  });
  return { ok: true, events, ignored };
}

/** Valor de contexto/evento como texto de uma linha (booleano = sim/não). */
export function formatWebchatValue(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "sim" : "não";
  return String(v).replace(/[\r\n]+/g, " ");
}

/** Teto de linhas de dados na nota (o painel do inbox mostra o resto). */
export const WEBCHAT_NOTE_MAX_DATA_LINES = 5;

/**
 * Chave/nome do site legível: `_`/`-` viram espaço, camelCase ganha
 * espaço, primeira letra maiúscula (`nivel_titulo` → "Nivel titulo",
 * `pageView` → "Page view"). Siglas ficam como estão (`pageURL` → "Page URL").
 */
export function humanizeWebchatKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return key;
  const words = spaced
    .split(" ")
    .map((w, i) => (i > 0 && /^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Rótulo da config do canal; sem rótulo, a chave legível. */
export function webchatKeyLabel(key: string, labels: Record<string, string>): string {
  const label = Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : undefined;
  return typeof label === "string" && label.trim() ? label.trim() : humanizeWebchatKey(key);
}

/**
 * Texto neutro e curto da nota de evento importante:
 * `📍 Evento no site · <nome legível>` + uma linha `rótulo: valor` por
 * dado (rótulo da config ou chave legível). Texto repetido de outra chave
 * sai uma vez só (número e booleano nunca: `1` em duas chaves são dados
 * diferentes); no máximo `WEBCHAT_NOTE_MAX_DATA_LINES` linhas de dados
 * (o resto vira `+N outros dados`).
 */
export function buildImportantEventNote(
  event: { name: string; data: WebchatContextState | null },
  labels: Record<string, string>,
): string {
  const lines = [`📍 Evento no site · ${webchatKeyLabel(event.name, labels)}`];
  const seen = new Set<string>();
  let hidden = 0;
  for (const [key, value] of Object.entries(event.data ?? {})) {
    const text = formatWebchatValue(value).trim();
    if (!text) continue;
    if (typeof value === "string" && /\p{L}/u.test(text)) {
      if (seen.has(text)) continue;
      seen.add(text);
    }
    if (lines.length - 1 >= WEBCHAT_NOTE_MAX_DATA_LINES) {
      hidden++;
      continue;
    }
    lines.push(`${webchatKeyLabel(key, labels)}: ${text}`);
  }
  if (hidden > 0) lines.push(`+${hidden} ${hidden === 1 ? "outro dado" : "outros dados"}`);
  return lines.join("\n");
}
