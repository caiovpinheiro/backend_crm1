/**
 * Logger estruturado multi-tenant baseado em Pino.
 *
 * Filosofia
 * ─────────
 * - **Estruturado em prod**: JSON por linha (NDJSON) com `time`, `level`, `scope`,
 *   `organizationId`, `userId`, `msg`. Pronto pra Loki/Better Stack/Datadog.
 * - **Pretty em dev**: `pino-pretty` mostra timestamp + scope coloridos quando
 *   `NODE_ENV !== "production"` ou `LOG_PRETTY=1`. Sem dependência runtime extra
 *   em prod (worker thread é registrada lazy).
 * - **Multi-tenant by default**: cada chamada anexa `organizationId`/`userId`
 *   automaticamente lendo o `request-context` via AsyncLocalStorage. Não há como
 *   "esquecer" de logar com tenant — se o contexto está populado, vai junto.
 * - **Redaction obrigatória**: campos sensíveis (`accessToken`, `appSecret`,
 *   `verifyToken`, `password`, `authorization`, `cookie`, etc.) são substituídos
 *   por `"[redacted]"` antes de chegar ao stream. A lista é a fonte da verdade
 *   pra evitar vazamento de credentials em logs operacionais.
 *
 * API
 * ───
 * Compatibilidade total com a versão antiga:
 *   import { getLogger } from "@/lib/logger";
 *   const log = getLogger("automation");
 *   log.info("Novo lead:", name);
 *   log.error("DB error:", err);
 *
 * Novas capacidades:
 *   log.info({ leadId, channel }, "Novo lead criado");   // estruturado
 *   const child = log.child({ campaignId });             // bindings extras
 *   const root = getRootLogger();                        // pino instance crua
 *
 * Adapter futuro (Better Stack / Grafana Cloud)
 * ─────────────────────────────────────────────
 * Quando migrarmos do self-host (Loki/Promtail) pra um SaaS (Better Stack), a
 * troca é só de transport — `LOG_TRANSPORT=better-stack` + `LOG_TOKEN=…` sem
 * tocar no call-site. Implementação concreta desse transport entra na PR 2.2/3.3.
 */

import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";
import { getRequestContext } from "@/lib/request-context";

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LEVELS)[number];

function resolveLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw && (LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

/**
 * Lista canônica de chaves sensíveis (case-insensitive). Usada em duas frentes:
 *
 *   1. Redaction nativa do Pino (paths absolutos no objeto raiz);
 *   2. `deepRedact()` que percorre objetos/arrays dos args do call-site
 *      antes de chegar no Pino, garantindo cobertura mesmo quando o segredo
 *      está aninhado em estruturas que o glob do Pino não alcança
 *      (ex.: `args[0].config.accessToken`).
 *
 * Mantida exaustiva por design — é mais barato listar a mais do que vazar.
 */
const SENSITIVE_KEYS = new Set(
  [
    "password",
    "passwordhash",
    "token",
    "accesstoken",
    "refreshtoken",
    "appsecret",
    "verifytoken",
    "apikey",
    "secret",
    "authorization",
    "cookie",
    "set-cookie",
    "smtp_user",
    "smtp_pass",
    "smtpuser",
    "smtppass",
    "smtp_from",
  ].map((k) => k.toLowerCase()),
);

/** Paths de redaction usados pelo Pino na raiz do log record. */
const REDACT_PATHS = [
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "appSecret",
  "*.appSecret",
  "verifyToken",
  "*.verifyToken",
  "apiKey",
  "*.apiKey",
  "secret",
  "*.secret",
  "authorization",
  "*.authorization",
  "Authorization",
  "*.Authorization",
  "cookie",
  "*.cookie",
  "Cookie",
  "*.Cookie",
  "set-cookie",
  "*.set-cookie",
  "headers.authorization",
  "headers.cookie",
  "headers['set-cookie']",
  "config.accessToken",
  "config.appSecret",
  "config.verifyToken",
  "channel.config.accessToken",
  "channel.config.appSecret",
  "channel.config.verifyToken",
];

function shouldUsePretty(): boolean {
  if (process.env.LOG_PRETTY === "1") return true;
  if (process.env.LOG_PRETTY === "0") return false;
  return process.env.NODE_ENV !== "production";
}

function buildBaseOptions(): LoggerOptions {
  return {
    level: resolveLevel(),
    base: {
      env: process.env.NODE_ENV ?? "development",
      app: "crm-eduit",
    },
    redact: {
      paths: REDACT_PATHS,
      censor: "[redacted]",
      remove: false,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
}

let rootLogger: PinoLogger | null = null;

/**
 * Cria o stream destino do logger.
 *
 * Em dev (`shouldUsePretty()`), usa pino-pretty como Stream INLINE (sync,
 * mesmo processo) em vez de transport via worker thread. Isso evita:
 *   - Falhas de bundling do Next.js/Turbopack quando ele tenta resolver o
 *     thread file path do pino-pretty;
 *   - Latência de spawn de worker em rotas serverless/edge-like.
 *
 * Em prod (default `NODE_ENV=production`), retorna `undefined` para o pino
 * usar `process.stdout` direto — saída JSON pronta pra Promtail/Loki ou
 * Better Stack ingerir como NDJSON.
 */
function buildDestination(): NodeJS.WritableStream | undefined {
  if (!shouldUsePretty()) return undefined;
  try {
    // Import dinâmico pra não puxar pino-pretty no bundle de prod.
    const prettyFactory = require("pino-pretty") as (
      opts?: Record<string, unknown>,
    ) => NodeJS.WritableStream;
    return prettyFactory({
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname,env,app",
      singleLine: false,
    });
  } catch {
    return undefined;
  }
}

function getRootLoggerInternal(): PinoLogger {
  if (!rootLogger) {
    const dest = buildDestination();
    rootLogger = dest ? pino(buildBaseOptions(), dest) : pino(buildBaseOptions());
  }
  return rootLogger;
}

export function getRootLogger(): PinoLogger {
  return getRootLoggerInternal();
}

/**
 * Mescla os bindings do request-context (organizationId/userId/superAdmin)
 * com os args passados pelo call-site, antes de chamar pino.
 *
 * Suporta tanto a forma legacy `log.info("texto", obj1, obj2)` quanto a
 * estruturada `log.info({ key: val }, "texto")`. O Pino aceita ambos.
 */
function withTenantBindings(
  base: PinoLogger,
  args: unknown[],
): { logger: PinoLogger; args: unknown[] } {
  const ctx = getRequestContext();
  if (!ctx) return { logger: base, args };
  const bindings: Record<string, unknown> = {};
  if (ctx.organizationId) bindings.organizationId = ctx.organizationId;
  if (ctx.userId) bindings.userId = ctx.userId;
  if (ctx.isSuperAdmin) bindings.superAdmin = true;
  return { logger: base.child(bindings), args };
}

/**
 * Coerce arguments to Pino's two-arg shape `(obj, msg)`.
 *
 * Por que? Boa parte do codebase chama `log.info("Novo lead:", name)` (estilo
 * console.log), que o Pino interpretaria como dois args separados. Aqui
 * normalizamos: o primeiro arg vira `msg`, qualquer arg subsequente vira
 * `args[0]`/`args[1]`/... no objeto estruturado, e o último Error vira `err`.
 */
function normalizeArgs(args: unknown[]): {
  obj?: Record<string, unknown>;
  msg?: string;
} {
  if (args.length === 0) return { msg: "" };

  const first = args[0];
  const isObject =
    first !== null && typeof first === "object" && !(first instanceof Error);

  if (isObject && args.length === 1) {
    return { obj: first as Record<string, unknown>, msg: undefined };
  }
  if (isObject && typeof args[1] === "string") {
    const obj = first as Record<string, unknown>;
    const rest = args.slice(2);
    if (rest.length > 0) {
      return {
        obj: { ...obj, args: rest },
        msg: args[1] as string,
      };
    }
    return { obj, msg: args[1] as string };
  }

  // Estilo legacy: msg + extras. Junta os extras em `args` e o último Error em `err`.
  const obj: Record<string, unknown> = {};
  const extras: unknown[] = [];
  let msg = "";
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (i === 0) {
      msg = typeof a === "string" ? a : safeStringify(a);
      continue;
    }
    if (a instanceof Error && obj.err === undefined) {
      obj.err = serializeError(a);
      continue;
    }
    extras.push(a);
  }
  if (extras.length > 0) obj.args = extras;
  return { obj: Object.keys(obj).length > 0 ? obj : undefined, msg };
}

function serializeError(err: Error): Record<string, unknown> {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(typeof (err as unknown as { code?: unknown }).code !== "undefined"
      ? { code: (err as unknown as { code: unknown }).code }
      : {}),
  };
}

/**
 * Redaction recursiva por chave. Substitui qualquer valor cuja chave (case-
 * insensitive) esteja em `SENSITIVE_KEYS` por `"[redacted]"`. Tolera ciclos
 * usando WeakSet. Não muta o input — devolve cópia rasa quando há mudança,
 * referência original quando não há (evita alocação em hot paths).
 */
function deepRedact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = deepRedact(item, seen);
      if (r !== item) changed = true;
      return r;
    });
    return changed ? out : value;
  }

  const src = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_KEYS.has(lk)) {
      out[k] = "[redacted]";
      changed = true;
      continue;
    }
    const child = src[k];
    const r = deepRedact(child, seen);
    if (r !== child) changed = true;
    out[k] = r;
  }
  return changed ? out : value;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * API back-compat. Mantém a mesma forma do logger antigo (debug/info/warn/error
 * recebendo `...args`) mas roda por baixo no Pino com bindings de tenant
 * automáticos e redaction obrigatória.
 *
 * Também expõe `child(bindings)` para enriquecer com keys específicas do escopo
 * (campaignId, conversationId, etc.) sem mexer no scope global.
 */
export type Logger = {
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  child: (bindings: Record<string, unknown>) => Logger;
  raw: () => PinoLogger;
};

function wrap(base: PinoLogger): Logger {
  function emit(level: LogLevel, args: unknown[]): void {
    const { logger } = withTenantBindings(base, args);
    const { obj, msg } = normalizeArgs(args);
    const safe = obj
      ? (deepRedact(obj) as Record<string, unknown>)
      : undefined;
    if (safe && msg !== undefined) logger[level](safe, msg);
    else if (safe) logger[level](safe);
    else logger[level](msg ?? "");
  }
  return {
    trace: (...args) => emit("trace", args),
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    fatal: (...args) => emit("fatal", args),
    child: (bindings) => wrap(base.child(bindings)),
    raw: () => base,
  };
}

const loggerCache = new Map<string, Logger>();

export function getLogger(scope: string): Logger {
  const cached = loggerCache.get(scope);
  if (cached) return cached;
  const base = getRootLoggerInternal().child({ scope });
  const wrapped = wrap(base);
  loggerCache.set(scope, wrapped);
  return wrapped;
}

/**
 * Reseta a cache de loggers (apenas para testes que mockam ENV).
 */
export function _resetLoggerForTests(): void {
  loggerCache.clear();
  rootLogger = null;
}
