/**
 * Webchat v2 — configuração do canal (docs/decisoes/webchat-widget.md §9.7).
 *
 * Vive em `Channel.config.v2` (JSON). NÃO entra no `GET /api/public/webchat/config`
 * (o público continua sendo só o `WebchatChannelConfig` da v1): mapeamentos,
 * URL de callback e regras são do painel. Os segredos ficam fora daqui
 * (`lib/webchat/secrets.ts`, encriptados no config). Funções puras, sem banco.
 *
 * Nada fixo de cliente/segmento: chaves, rótulos, campos e regras são dados
 * da org. Os defaults são neutros e seguros (tudo desligado/vazio).
 */

import { WebchatConfigError } from "@/lib/webchat/config";

/** Chave de contexto (`setContext`, `fields` do S2S, rótulos). */
export const WEBCHAT_CONTEXT_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** Nome de evento (`track`, lista de importantes). */
export const WEBCHAT_EVENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** Nome de atributo do `identify` (mapeado para campo personalizado). */
export const WEBCHAT_ATTRIBUTE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** Ids do CRM (CustomField, Tag, Department): cuid ou similar. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Teto do bloco "Contexto do site" entregue à IA (caracteres). */
export const WEBCHAT_AI_CONTEXT_MAX_CHARS = 1500;
/** Quantos eventos recentes entram no bloco da IA / no painel. */
export const WEBCHAT_RECENT_EVENTS = 10;
/** Teto fixo de chaves em `data` de um evento. */
export const WEBCHAT_EVENT_MAX_DATA_KEYS = 10;
/** Idempotência do servidor a servidor: por quanto tempo a chave vale. */
export const WEBCHAT_S2S_IDEMPOTENCY_TTL_HOURS = 24;
/** Janela do `X-Timestamp` do servidor a servidor (±). */
export const WEBCHAT_S2S_TIMESTAMP_TOLERANCE_SEC = 300;

/** Faixas (mín, padrão, máx) dos limites configuráveis. */
export const WEBCHAT_V2_LIMITS = {
  contextMaxKeys: { min: 1, def: 30, max: 100 },
  contextMaxValueChars: { min: 1, def: 200, max: 1000 },
  eventsMaxPerBatch: { min: 1, def: 20, max: 50 },
  eventsRetentionDays: { min: 1, def: 30, max: 365 },
} as const;

const MAX_LABELS = 100;
const MAX_LABEL_CHARS = 80;
const MAX_ATTRIBUTE_MAP = 50;
const MAX_IMPORTANT_EVENTS = 50;
const MAX_RULES = 20;
const MAX_RULE_VALUE_CHARS = 64;
const MAX_CALLBACK_URL_CHARS = 2000;

export type WebchatMatchField =
  | { type: "externalId" }
  | { type: "customField"; customFieldId: string };

export type WebchatAttributeMapping = {
  /** Nome do atributo no `identify({ attributes })`. */
  attribute: string;
  /** CustomField (entity=contact) que recebe o valor. */
  customFieldId: string;
};

/**
 * Regra de category/priority do servidor a servidor. Casa quando TODOS os
 * critérios presentes batem (comparação sem diferença de caixa, após trim).
 * Regra sem critério nunca casa. Ações aplicadas na ordem; várias regras
 * podem casar (todas aplicam).
 */
export type WebchatRoutingRule = {
  category?: string;
  priority?: string;
  /** Tag aplicada ao contato. */
  tagId?: string;
  /** Departamento da conversa. */
  departmentId?: string;
  /** Fixa a nota do S2S no topo da conversa (`Conversation.pinnedNoteId`). */
  pinNote?: boolean;
};

export type WebchatV2Config = {
  identity: {
    /** Onde o `externalId` do site é procurado/gravado no contato. */
    matchField: WebchatMatchField;
    /** atributo do site → campo personalizado. Atributo sem linha é ignorado. */
    attributeMap: WebchatAttributeMapping[];
  };
  context: {
    /** chave → rótulo mostrado no painel e na IA (sem rótulo = a chave). */
    labels: Record<string, string>;
    maxKeys: number;
    maxValueChars: number;
    /** Aceita setContext/track de visitante não verificado (anônimo). */
    anonymous: boolean;
  };
  events: {
    maxPerBatch: number;
    retentionDays: number;
    /** Nomes de eventos que o canal considera importantes (além do flag do site). */
    important: string[];
    /** Evento importante sem conversa aberta abre uma (senão só nota se houver). */
    importantOpensConversation: boolean;
  };
  s2s: {
    /** Tag aplicada ao contato quando o S2S abre conversa nova. */
    queueTagId: string | null;
    /** https; recebe `{ ref, status, conversation_id }` assinado. Null = sem callback. */
    callbackUrl: string | null;
    rules: WebchatRoutingRule[];
  };
  /** CustomField (entity=deal) que recebe o `ref` no negócio aberto do contato. */
  refDealCustomFieldId: string | null;
};

/** Subclasse do erro da v1: as rotas de canal já respondem 400 com `message`. */
export class WebchatV2ConfigError extends WebchatConfigError {
  constructor(message: string) {
    super(message);
    this.name = "WebchatV2ConfigError";
  }
}

export function defaultWebchatV2Config(): WebchatV2Config {
  const L = WEBCHAT_V2_LIMITS;
  return {
    identity: { matchField: { type: "externalId" }, attributeMap: [] },
    context: {
      labels: {},
      maxKeys: L.contextMaxKeys.def,
      maxValueChars: L.contextMaxValueChars.def,
      anonymous: false,
    },
    events: {
      maxPerBatch: L.eventsMaxPerBatch.def,
      retentionDays: L.eventsRetentionDays.def,
      important: [],
      importantOpensConversation: false,
    },
    s2s: { queueTagId: null, callbackUrl: null, rules: [] },
    refDealCustomFieldId: null,
  };
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function obj(v: unknown, field: string): Obj | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new WebchatV2ConfigError(`${field} deve ser um objeto.`);
  return v;
}

function bool(v: unknown, field: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new WebchatV2ConfigError(`${field} deve ser booleano.`);
  return v;
}

function int(
  v: unknown,
  field: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < range.min || v > range.max) {
    throw new WebchatV2ConfigError(`${field} deve ser um inteiro entre ${range.min} e ${range.max}.`);
  }
  return v;
}

function id(v: unknown, field: string): string {
  if (typeof v !== "string" || !ID_RE.test(v.trim())) {
    throw new WebchatV2ConfigError(`${field} inválido.`);
  }
  return v.trim();
}

/** `null`/"" = sem valor; ausente = mantém. */
function optionalId(v: unknown, field: string, fallback: string | null): string | null {
  if (v === undefined) return fallback;
  if (v === null || v === "") return null;
  return id(v, field);
}

function parseMatchField(v: unknown, fallback: WebchatMatchField): WebchatMatchField {
  const o = obj(v, "identity.matchField");
  if (!o) return fallback;
  if (o.type === "externalId") return { type: "externalId" };
  if (o.type === "customField") {
    return { type: "customField", customFieldId: id(o.customFieldId, "identity.matchField.customFieldId") };
  }
  throw new WebchatV2ConfigError('identity.matchField.type deve ser "externalId" ou "customField".');
}

function parseAttributeMap(v: unknown, fallback: WebchatAttributeMapping[]): WebchatAttributeMapping[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) throw new WebchatV2ConfigError("identity.attributeMap deve ser uma lista.");
  if (v.length > MAX_ATTRIBUTE_MAP) {
    throw new WebchatV2ConfigError(`identity.attributeMap: no máximo ${MAX_ATTRIBUTE_MAP} linhas.`);
  }
  const seen = new Set<string>();
  const out: WebchatAttributeMapping[] = [];
  for (const row of v) {
    if (!isObj(row)) throw new WebchatV2ConfigError("identity.attributeMap: linha inválida.");
    const attribute = typeof row.attribute === "string" ? row.attribute.trim() : "";
    if (!WEBCHAT_ATTRIBUTE_RE.test(attribute)) {
      throw new WebchatV2ConfigError(`identity.attributeMap: atributo inválido "${attribute}".`);
    }
    if (seen.has(attribute)) {
      throw new WebchatV2ConfigError(`identity.attributeMap: atributo repetido "${attribute}".`);
    }
    seen.add(attribute);
    out.push({ attribute, customFieldId: id(row.customFieldId, "identity.attributeMap.customFieldId") });
  }
  return out;
}

function parseLabels(v: unknown, fallback: Record<string, string>): Record<string, string> {
  if (v === undefined) return fallback;
  const o = obj(v, "context.labels") ?? {};
  const entries = Object.entries(o);
  if (entries.length > MAX_LABELS) {
    throw new WebchatV2ConfigError(`context.labels: no máximo ${MAX_LABELS} rótulos.`);
  }
  const out: Record<string, string> = {};
  for (const [key, label] of entries) {
    if (!WEBCHAT_CONTEXT_KEY_RE.test(key)) {
      throw new WebchatV2ConfigError(`context.labels: chave inválida "${key}".`);
    }
    if (typeof label !== "string") throw new WebchatV2ConfigError(`context.labels.${key} deve ser texto.`);
    const t = label.trim();
    if (t.length > MAX_LABEL_CHARS) {
      throw new WebchatV2ConfigError(`context.labels.${key} passa de ${MAX_LABEL_CHARS} caracteres.`);
    }
    if (t) out[key] = t;
  }
  return out;
}

function parseEventNames(v: unknown, fallback: string[]): string[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) throw new WebchatV2ConfigError("events.important deve ser uma lista.");
  const out = new Set<string>();
  for (const n of v) {
    const name = typeof n === "string" ? n.trim() : "";
    if (!WEBCHAT_EVENT_NAME_RE.test(name)) {
      throw new WebchatV2ConfigError(`events.important: nome de evento inválido "${String(n)}".`);
    }
    out.add(name);
  }
  if (out.size > MAX_IMPORTANT_EVENTS) {
    throw new WebchatV2ConfigError(`events.important: no máximo ${MAX_IMPORTANT_EVENTS} nomes.`);
  }
  return [...out];
}

function parseCallbackUrl(v: unknown, fallback: string | null): string | null {
  if (v === undefined) return fallback;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > MAX_CALLBACK_URL_CHARS) {
    throw new WebchatV2ConfigError("s2s.callbackUrl deve ser uma URL https.");
  }
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    throw new WebchatV2ConfigError("s2s.callbackUrl deve ser uma URL https.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new WebchatV2ConfigError("s2s.callbackUrl deve ser uma URL https (sem usuário/senha).");
  }
  return url.toString();
}

function ruleValue(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new WebchatV2ConfigError(`${field} deve ser texto.`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > MAX_RULE_VALUE_CHARS) {
    throw new WebchatV2ConfigError(`${field} passa de ${MAX_RULE_VALUE_CHARS} caracteres.`);
  }
  return t;
}

function parseRules(v: unknown, fallback: WebchatRoutingRule[]): WebchatRoutingRule[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) throw new WebchatV2ConfigError("s2s.rules deve ser uma lista.");
  if (v.length > MAX_RULES) throw new WebchatV2ConfigError(`s2s.rules: no máximo ${MAX_RULES} regras.`);
  return v.map((raw, i) => {
    if (!isObj(raw)) throw new WebchatV2ConfigError(`s2s.rules[${i}] deve ser um objeto.`);
    const rule: WebchatRoutingRule = {};
    const category = ruleValue(raw.category, `s2s.rules[${i}].category`);
    const priority = ruleValue(raw.priority, `s2s.rules[${i}].priority`);
    if (!category && !priority) {
      throw new WebchatV2ConfigError(`s2s.rules[${i}]: informe category e/ou priority.`);
    }
    if (category) rule.category = category;
    if (priority) rule.priority = priority;
    const tagId = optionalId(raw.tagId, `s2s.rules[${i}].tagId`, null);
    const departmentId = optionalId(raw.departmentId, `s2s.rules[${i}].departmentId`, null);
    if (tagId) rule.tagId = tagId;
    if (departmentId) rule.departmentId = departmentId;
    if (bool(raw.pinNote, `s2s.rules[${i}].pinNote`, false)) rule.pinNote = true;
    if (!rule.tagId && !rule.departmentId && !rule.pinNote) {
      throw new WebchatV2ConfigError(`s2s.rules[${i}]: escolha ao menos uma ação.`);
    }
    return rule;
  });
}

/**
 * Valida e completa o `v2` do config. `patch` é parcial em qualquer nível
 * (o painel pode mandar só `context.labels`); o resto vem de `base`.
 */
export function normalizeWebchatV2Config(patch: unknown, base: WebchatV2Config): WebchatV2Config {
  if (patch === undefined || patch === null) return base;
  const p = obj(patch, "v2") ?? {};
  const L = WEBCHAT_V2_LIMITS;
  const identity = obj(p.identity, "v2.identity") ?? {};
  const context = obj(p.context, "v2.context") ?? {};
  const events = obj(p.events, "v2.events") ?? {};
  const s2s = obj(p.s2s, "v2.s2s") ?? {};
  return {
    identity: {
      matchField: parseMatchField(identity.matchField, base.identity.matchField),
      attributeMap: parseAttributeMap(identity.attributeMap, base.identity.attributeMap),
    },
    context: {
      labels: parseLabels(context.labels, base.context.labels),
      maxKeys: int(context.maxKeys, "context.maxKeys", base.context.maxKeys, L.contextMaxKeys),
      maxValueChars: int(
        context.maxValueChars,
        "context.maxValueChars",
        base.context.maxValueChars,
        L.contextMaxValueChars,
      ),
      anonymous: bool(context.anonymous, "context.anonymous", base.context.anonymous),
    },
    events: {
      maxPerBatch: int(events.maxPerBatch, "events.maxPerBatch", base.events.maxPerBatch, L.eventsMaxPerBatch),
      retentionDays: int(
        events.retentionDays,
        "events.retentionDays",
        base.events.retentionDays,
        L.eventsRetentionDays,
      ),
      important: parseEventNames(events.important, base.events.important),
      importantOpensConversation: bool(
        events.importantOpensConversation,
        "events.importantOpensConversation",
        base.events.importantOpensConversation,
      ),
    },
    s2s: {
      queueTagId: optionalId(s2s.queueTagId, "s2s.queueTagId", base.s2s.queueTagId),
      callbackUrl: parseCallbackUrl(s2s.callbackUrl, base.s2s.callbackUrl),
      rules: parseRules(s2s.rules, base.s2s.rules),
    },
    refDealCustomFieldId: optionalId(p.refDealCustomFieldId, "refDealCustomFieldId", base.refDealCustomFieldId),
  };
}

/**
 * Lê o `v2` gravado (o `Channel.config` inteiro) sem lançar: cada bloco
 * inválido volta ao default. Caminho público / workers usam esta.
 */
export function readWebchatV2Config(rawConfig: unknown): WebchatV2Config {
  const base = defaultWebchatV2Config();
  const raw = isObj(rawConfig) && isObj(rawConfig.v2) ? rawConfig.v2 : null;
  if (!raw) return base;
  const out = { ...base };
  const blocks = ["identity", "context", "events", "s2s", "refDealCustomFieldId"] as const;
  for (const key of blocks) {
    try {
      const parsed = normalizeWebchatV2Config({ [key]: raw[key] }, base);
      (out as Record<string, unknown>)[key] = parsed[key];
    } catch {
      /* bloco ruim: fica o default */
    }
  }
  return out;
}

/** O evento é importante (flag do site OU lista do canal)? */
export function isImportantWebchatEvent(
  name: string,
  flaggedBySite: boolean | undefined,
  config: WebchatV2Config,
): boolean {
  return flaggedBySite === true || config.events.important.includes(name);
}

/** Regras que casam com `category`/`priority` do S2S (sem caixa, com trim). */
export function matchWebchatRoutingRules(
  rules: WebchatRoutingRule[],
  input: { category?: string | null; priority?: string | null },
): WebchatRoutingRule[] {
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const category = norm(input.category);
  const priority = norm(input.priority);
  return rules.filter((r) => {
    if (!r.category && !r.priority) return false;
    if (r.category && norm(r.category) !== category) return false;
    if (r.priority && norm(r.priority) !== priority) return false;
    return true;
  });
}
