/**
 * Webchat v2 — condições de automação sobre o contexto vivo e a linha do
 * tempo do site (docs/decisoes/webchat-widget.md §9.10). Leem as mesmas
 * tabelas do painel e do bloco da IA; chaves e nomes de evento são texto
 * livre da org (nada fixo aqui).
 *
 * Passo "Condição" (regras `{ field, op, value }`):
 *  - `field = "siteContext.<chave>"` com `exists` / `not_exists` / `eq` /
 *    `ne` / `includes` (e os demais ops escalares do avaliador). A chave é
 *    tudo depois do prefixo (pode conter ponto).
 *  - `field = "siteEvent.<nome>"` com `occurred_within` /
 *    `not_occurred_within` e `value` = N minutos.
 *
 * Condições do gatilho (`triggerConfig.conditions`, semântica E):
 *  - `{ type: "site_context", key, op: "exists" | "not_exists" | "eq" | "includes", value? }`
 *  - `{ type: "site_event", name, minutes, op?: "occurred" | "not_occurred" }`
 *
 * Dono dos dados = o contato (todas as linhas de contexto dele, a mais
 * recente vence por chave). Sem contato → contexto vazio e nenhum evento.
 * Toda consulta filtra por `organizationId` (além do escopo do prisma).
 */
import { prisma } from "@/lib/prisma";
import { readContextState, type WebchatContextState } from "@/lib/webchat/live-context";
import { WEBCHAT_CONTEXT_KEY_RE, WEBCHAT_EVENT_NAME_RE } from "@/lib/webchat/v2-config";

export const SITE_CONTEXT_FIELD_PREFIX = "siteContext.";
export const SITE_EVENT_FIELD_PREFIX = "siteEvent.";

/** Janela máxima de "ocorreu nos últimos N minutos" (= retenção máxima, 365 dias). */
export const SITE_EVENT_MAX_WINDOW_MINUTES = 365 * 24 * 60;

export type SiteContextOp = "exists" | "not_exists" | "eq" | "ne" | "includes";

/** Chave do contexto em `siteContext.<chave>`; `null` se não é campo do site. */
export function siteContextKeyOf(field: string | null | undefined): string | null {
  if (!field || !field.startsWith(SITE_CONTEXT_FIELD_PREFIX)) return null;
  const key = field.slice(SITE_CONTEXT_FIELD_PREFIX.length).trim();
  return WEBCHAT_CONTEXT_KEY_RE.test(key) ? key : null;
}

/** Nome do evento em `siteEvent.<nome>`; `null` se não é campo do site. */
export function siteEventNameOf(field: string | null | undefined): string | null {
  if (!field || !field.startsWith(SITE_EVENT_FIELD_PREFIX)) return null;
  const name = field.slice(SITE_EVENT_FIELD_PREFIX.length).trim();
  return WEBCHAT_EVENT_NAME_RE.test(name) ? name : null;
}

/** N minutos válido (inteiro 1…365 dias) ou `null`. */
export function parseWindowMinutes(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const m = Math.floor(n);
  if (m < 1) return null;
  return Math.min(m, SITE_EVENT_MAX_WINDOW_MINUTES);
}

function asText(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v == null) return "";
  return String(v).trim().toLowerCase();
}

/** Compara o valor do contexto (já lido) com o operador da regra. */
export function evalSiteContextValue(
  actual: string | number | boolean | undefined,
  op: string,
  expected: unknown,
): boolean {
  const present = actual !== undefined;
  switch (op) {
    case "exists":
    case "not_empty":
      return present && asText(actual) !== "";
    case "not_exists":
    case "empty":
      return !present || asText(actual) === "";
    case "eq":
      return present && asText(actual) === asText(expected);
    case "ne":
      return !present || asText(actual) !== asText(expected);
    case "includes": {
      const needle = asText(expected);
      return present && needle !== "" && asText(actual).includes(needle);
    }
    case "starts_with":
      return present && asText(actual).startsWith(asText(expected));
    case "ends_with":
      return present && asText(actual).endsWith(asText(expected));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = typeof actual === "number" ? actual : Number(actual);
      const b = typeof expected === "number" ? expected : Number(expected);
      if (!present || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

/**
 * Leitor preguiçoso, com cache por avaliação: o contexto do contato é lido
 * uma vez; cada (evento, janela) uma consulta `findFirst` pelo índice
 * `(contactId, name, occurredAt)`.
 */
export function createSiteConditionReader(args: {
  organizationId: string | null | undefined;
  contactId: string | null | undefined;
  now?: () => Date;
}) {
  const { organizationId, contactId } = args;
  const now = args.now ?? (() => new Date());
  let contextPromise: Promise<WebchatContextState> | null = null;
  const eventCache = new Map<string, Promise<boolean>>();

  const loadContext = (): Promise<WebchatContextState> => {
    if (!organizationId || !contactId) return Promise.resolve({});
    contextPromise ??= prisma.webchatLiveContext
      .findMany({
        where: { organizationId, contactId },
        orderBy: { updatedAt: "asc" },
        take: 20,
        select: { state: true },
      })
      .then((rows) => {
        const state: WebchatContextState = {};
        for (const r of rows) Object.assign(state, readContextState(r.state));
        return state;
      });
    return contextPromise;
  };

  const occurredWithin = (name: string, minutes: number): Promise<boolean> => {
    if (!organizationId || !contactId) return Promise.resolve(false);
    const cacheKey = `${name}\u0000${minutes}`;
    let pending = eventCache.get(cacheKey);
    if (!pending) {
      const since = new Date(now().getTime() - minutes * 60_000);
      pending = prisma.webchatEvent
        .findFirst({
          where: { organizationId, contactId, name, occurredAt: { gte: since } },
          select: { id: true },
        })
        .then((row) => !!row);
      eventCache.set(cacheKey, pending);
    }
    return pending;
  };

  return {
    /** Valor da chave (undefined = ausente). */
    async contextValue(key: string): Promise<string | number | boolean | undefined> {
      const state = await loadContext();
      return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : undefined;
    },
    occurredWithin,
  };
}

export type SiteConditionReader = ReturnType<typeof createSiteConditionReader>;

type RuleLike = { field: string; op: string; value: unknown };

/** A regra do passo "Condição" é sobre o site? */
export function isSiteRule(rule: RuleLike): boolean {
  return (
    rule.field.startsWith(SITE_CONTEXT_FIELD_PREFIX) ||
    rule.field.startsWith(SITE_EVENT_FIELD_PREFIX)
  );
}

/**
 * Avalia uma regra do passo "Condição" sobre o site. Campo/ops inválidos →
 * `false` (não bate), exceto as formas negativas, que batem quando não há
 * dado.
 */
export async function evaluateSiteRule(rule: RuleLike, reader: SiteConditionReader): Promise<boolean> {
  if (rule.field.startsWith(SITE_EVENT_FIELD_PREFIX)) {
    const name = siteEventNameOf(rule.field);
    const minutes = parseWindowMinutes(rule.value);
    if (rule.op !== "occurred_within" && rule.op !== "not_occurred_within") return false;
    if (!name || !minutes) return false;
    const hit = await reader.occurredWithin(name, minutes);
    return rule.op === "occurred_within" ? hit : !hit;
  }
  const key = siteContextKeyOf(rule.field);
  if (!key) return false;
  return evalSiteContextValue(await reader.contextValue(key), rule.op, rule.value);
}

function readStr(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

/**
 * Condição do gatilho (`type: "site_context" | "site_event"`). `null` =
 * não é condição do site (o chamador segue com as dele). Condição vazia
 * (sem chave/nome) não filtra, como as demais do drawer.
 */
export async function evaluateSiteTriggerCondition(
  c: Record<string, unknown>,
  reader: SiteConditionReader,
): Promise<boolean | null> {
  const type = readStr(c, "type");
  if (type === "site_context") {
    const key = readStr(c, "key");
    if (!key) return true;
    if (!WEBCHAT_CONTEXT_KEY_RE.test(key)) return false;
    const op = readStr(c, "op") || "exists";
    return evalSiteContextValue(await reader.contextValue(key), op, c.value);
  }
  if (type === "site_event") {
    const name = readStr(c, "name");
    if (!name) return true;
    const minutes = parseWindowMinutes(c.minutes);
    if (!WEBCHAT_EVENT_NAME_RE.test(name) || !minutes) return false;
    const hit = await reader.occurredWithin(name, minutes);
    return readStr(c, "op") === "not_occurred" ? !hit : hit;
  }
  return null;
}
