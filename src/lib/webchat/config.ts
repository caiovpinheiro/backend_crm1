/**
 * Configuração do canal WEBCHAT (docs/decisoes/webchat-widget.md §3.1).
 *
 * Vive em `Channel.config` (JSON, sem encriptação — nada aqui é segredo).
 * A `publicKey` também fica em coluna própria (`Channel.publicKey`, única)
 * porque toda chamada pública resolve o canal por ela; no JSON ela é só
 * espelho para o painel. Funções puras, sem banco.
 */
import { randomBytes } from "node:crypto";

export const WEBCHAT_IDENTIFICATION_MODES = [
  "none",
  "name",
  "name_email",
  "name_phone",
] as const;
export type WebchatIdentificationMode = (typeof WEBCHAT_IDENTIFICATION_MODES)[number];

export const WEBCHAT_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WebchatWeekday = (typeof WEBCHAT_WEEKDAYS)[number];

export type WebchatBusinessHours = {
  /** IANA, ex.: "America/Sao_Paulo". */
  tz: string;
  /** Faixas "HH:MM"–"HH:MM" por dia. Dia ausente/vazio = fechado. */
  week: Partial<Record<WebchatWeekday, [string, string][]>>;
};

export type WebchatTheme = {
  /** Ausente = herda `Organization.primaryColor` (resolvido no `GET /config`). */
  primary?: string;
  position: "right" | "left";
  /** Ausente = herda `Organization.logoUrl`. */
  avatarUrl?: string;
  title: string;
};

/** Tema efetivo (o que o widget recebe): cor sempre resolvida. */
export type ResolvedWebchatTheme = {
  primary: string;
  position: "right" | "left";
  avatarUrl: string | null;
  title: string;
};

/** Cor do widget quando nem o canal nem a org definem uma válida. */
export const WEBCHAT_FALLBACK_PRIMARY = "#2563EB";

export type WebchatChannelConfig = {
  publicKey: string;
  allowedOrigins: string[];
  identification: WebchatIdentificationMode;
  greeting: string;
  offlineMessage: string;
  theme: WebchatTheme;
  businessHours?: WebchatBusinessHours;
  collectTranscriptEmail: boolean;
};

export const WEBCHAT_MAX_CONTENT_CHARS = 4000;
export const WEBCHAT_MAX_ALLOWED_ORIGINS = 20;
const MAX_TEXT = 500;
const PUBLIC_KEY_RE = /^wc_[A-Za-z0-9]{24}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Erro de validação do config — as rotas devolvem 400 com `message`. */
export class WebchatConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebchatConfigError";
  }
}

/** "wc_" + 24 chars alfanuméricos (sem viés: rejection sampling). */
export function generateWebchatPublicKey(): string {
  let out = "";
  while (out.length < 24) {
    for (const b of randomBytes(32)) {
      // 248 = 4 × 62: descarta o resto para não enviesar o alfabeto.
      if (b < 248 && out.length < 24) out += KEY_ALPHABET[b % 62];
    }
  }
  return `wc_${out}`;
}

export function isWebchatPublicKey(v: unknown): v is string {
  return typeof v === "string" && PUBLIC_KEY_RE.test(v);
}

export function defaultWebchatConfig(publicKey: string): WebchatChannelConfig {
  return {
    publicKey,
    allowedOrigins: [],
    identification: "none",
    greeting: "Olá! Como podemos ajudar?",
    offlineMessage: "Estamos fora do horário de atendimento. Deixe sua mensagem que retornamos assim que possível.",
    // Sem `primary`/`avatarUrl`: o widget herda a marca da org.
    theme: { position: "right", title: "Fale conosco" },
    collectTranscriptEmail: false,
  };
}

/**
 * Origem canônica (`esquema://host[:porta]`, minúsculas, sem porta padrão,
 * sem path). `null` = não é uma origem http(s) válida.
 */
export function canonicalOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return `${url.protocol}//${url.host}`;
}

function text(v: unknown, field: string, fallback: string, max = MAX_TEXT): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string") throw new WebchatConfigError(`${field} deve ser texto.`);
  const t = v.trim();
  if (t.length > max) throw new WebchatConfigError(`${field} passa de ${max} caracteres.`);
  return t;
}

function parseOrigins(v: unknown, fallback: string[]): string[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) throw new WebchatConfigError("allowedOrigins deve ser uma lista.");
  const out = new Set<string>();
  for (const item of v) {
    const o = canonicalOrigin(item);
    if (!o) {
      throw new WebchatConfigError(
        `Origem inválida em allowedOrigins: "${String(item)}". Use https://dominio.com.br (sem caminho).`,
      );
    }
    out.add(o);
  }
  if (out.size > WEBCHAT_MAX_ALLOWED_ORIGINS) {
    throw new WebchatConfigError(`No máximo ${WEBCHAT_MAX_ALLOWED_ORIGINS} origens.`);
  }
  return [...out];
}

function parseTheme(v: unknown, fallback: WebchatTheme): WebchatTheme {
  if (v === undefined) return fallback;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new WebchatConfigError("theme deve ser um objeto.");
  }
  const t = v as Record<string, unknown>;
  // `null`/"" = voltar a herdar da org.
  const primary = t.primary === undefined ? fallback.primary : t.primary;
  if (
    primary !== undefined &&
    primary !== null &&
    primary !== "" &&
    (typeof primary !== "string" || !HEX_COLOR_RE.test(primary))
  ) {
    throw new WebchatConfigError("theme.primary deve ser uma cor #RRGGBB ou null.");
  }
  const position = t.position === undefined ? fallback.position : t.position;
  if (position !== "right" && position !== "left") {
    throw new WebchatConfigError('theme.position deve ser "right" ou "left".');
  }
  const out: WebchatTheme = {
    position,
    title: text(t.title, "theme.title", fallback.title, 80),
  };
  if (typeof primary === "string" && primary) out.primary = primary;
  const avatar = t.avatarUrl === undefined ? fallback.avatarUrl : t.avatarUrl;
  if (avatar !== undefined && avatar !== null && avatar !== "") {
    if (typeof avatar !== "string" || !/^https:\/\//i.test(avatar) || avatar.length > 2000) {
      throw new WebchatConfigError("theme.avatarUrl deve ser uma URL https.");
    }
    out.avatarUrl = avatar;
  }
  return out;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseBusinessHours(
  v: unknown,
  fallback: WebchatBusinessHours | undefined,
): WebchatBusinessHours | undefined {
  if (v === undefined) return fallback;
  if (v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new WebchatConfigError("businessHours deve ser um objeto ou null.");
  }
  const b = v as Record<string, unknown>;
  const tz = typeof b.tz === "string" && b.tz.trim() ? b.tz.trim() : "America/Sao_Paulo";
  if (!isValidTimeZone(tz)) throw new WebchatConfigError(`Fuso inválido: "${tz}".`);
  const weekRaw = b.week ?? {};
  if (!weekRaw || typeof weekRaw !== "object" || Array.isArray(weekRaw)) {
    throw new WebchatConfigError("businessHours.week deve ser um objeto.");
  }
  const week: WebchatBusinessHours["week"] = {};
  for (const [day, ranges] of Object.entries(weekRaw as Record<string, unknown>)) {
    if (!(WEBCHAT_WEEKDAYS as readonly string[]).includes(day)) {
      throw new WebchatConfigError(`Dia inválido em businessHours.week: "${day}".`);
    }
    if (!Array.isArray(ranges)) {
      throw new WebchatConfigError(`businessHours.week.${day} deve ser uma lista de faixas.`);
    }
    const parsed: [string, string][] = [];
    for (const r of ranges) {
      if (
        !Array.isArray(r) ||
        r.length !== 2 ||
        typeof r[0] !== "string" ||
        typeof r[1] !== "string" ||
        !HHMM_RE.test(r[0]) ||
        !HHMM_RE.test(r[1]) ||
        r[0] >= r[1]
      ) {
        throw new WebchatConfigError(
          `Faixa inválida em businessHours.week.${day}: use ["08:00","18:00"].`,
        );
      }
      parsed.push([r[0], r[1]]);
    }
    week[day as WebchatWeekday] = parsed;
  }
  return { tz, week };
}

/**
 * Valida e completa um config de webchat. `patch` é parcial (PUT do painel
 * manda só o que mudou); o resto vem de `base`. A `publicKey` nunca vem do
 * cliente — é sempre a do canal.
 */
export function normalizeWebchatConfig(
  patch: unknown,
  base: WebchatChannelConfig,
): WebchatChannelConfig {
  if (patch !== undefined && patch !== null && (typeof patch !== "object" || Array.isArray(patch))) {
    throw new WebchatConfigError("config deve ser um objeto.");
  }
  const p = (patch ?? {}) as Record<string, unknown>;
  const identification = p.identification === undefined ? base.identification : p.identification;
  if (
    typeof identification !== "string" ||
    !(WEBCHAT_IDENTIFICATION_MODES as readonly string[]).includes(identification)
  ) {
    throw new WebchatConfigError(
      `identification deve ser um de: ${WEBCHAT_IDENTIFICATION_MODES.join(", ")}.`,
    );
  }
  const collect = p.collectTranscriptEmail === undefined
    ? base.collectTranscriptEmail
    : p.collectTranscriptEmail;
  if (typeof collect !== "boolean") {
    throw new WebchatConfigError("collectTranscriptEmail deve ser booleano.");
  }
  const out: WebchatChannelConfig = {
    publicKey: base.publicKey,
    allowedOrigins: parseOrigins(p.allowedOrigins, base.allowedOrigins),
    identification: identification as WebchatIdentificationMode,
    greeting: text(p.greeting, "greeting", base.greeting),
    offlineMessage: text(p.offlineMessage, "offlineMessage", base.offlineMessage),
    theme: parseTheme(p.theme, base.theme),
    collectTranscriptEmail: collect,
  };
  const hours = parseBusinessHours(p.businessHours, base.businessHours);
  if (hours) out.businessHours = hours;
  return out;
}

/**
 * Lê o config gravado sem lançar: campos ruins voltam ao default. Usado no
 * caminho público (um config antigo/corrompido não pode derrubar o widget).
 */
export function readWebchatConfig(raw: unknown, publicKey: string): WebchatChannelConfig {
  const base = defaultWebchatConfig(publicKey);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof WebchatChannelConfig>(key: K): Partial<WebchatChannelConfig> => {
    try {
      return { [key]: normalizeWebchatConfig({ [key]: r[key] }, base)[key] } as Partial<WebchatChannelConfig>;
    } catch {
      return {};
    }
  };
  const merged: WebchatChannelConfig = {
    ...base,
    ...pick("allowedOrigins"),
    ...pick("identification"),
    ...pick("greeting"),
    ...pick("offlineMessage"),
    ...pick("theme"),
    ...pick("collectTranscriptEmail"),
  };
  const hours = pick("businessHours").businessHours;
  if (hours) merged.businessHours = hours;
  else delete merged.businessHours;
  return merged;
}

/** Marca da org que o widget herda (`webchatDefaults` do painel). */
export function webchatOrgDefaults(org: {
  primaryColor?: string | null;
  logoUrl?: string | null;
} | null | undefined): { primary: string; avatarUrl: string | null } {
  const color = org?.primaryColor?.trim();
  const logo = org?.logoUrl?.trim();
  return {
    primary: color && HEX_COLOR_RE.test(color) ? color : WEBCHAT_FALLBACK_PRIMARY,
    avatarUrl: logo || null,
  };
}

/** Tema do canal + marca da org → o que o widget pinta. */
export function resolveWebchatTheme(
  theme: WebchatTheme,
  defaults: { primary: string; avatarUrl: string | null },
): ResolvedWebchatTheme {
  return {
    primary: theme.primary ?? defaults.primary,
    position: theme.position,
    avatarUrl: theme.avatarUrl ?? defaults.avatarUrl,
    title: theme.title,
  };
}

/**
 * Dentro do horário comercial? Sem `businessHours` = sempre aberto.
 */
export function isWithinBusinessHours(
  hours: WebchatBusinessHours | undefined,
  now: Date = new Date(),
): boolean {
  if (!hours) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday").toLowerCase().slice(0, 3) as WebchatWeekday;
  const hhmm = `${get("hour").padStart(2, "0")}:${get("minute").padStart(2, "0")}`;
  const ranges = hours.week[day] ?? [];
  return ranges.some(([from, to]) => hhmm >= from && hhmm < to);
}
