/**
 * Dados sensíveis no texto do cliente, no que vai para o modelo e no que
 * fica gravado nos logs do agente.
 *
 * - Documento (CPF, CNPJ, RG) e e-mail que o cliente digita viram marcadores
 *   ("[CPF 1]") antes de ir ao modelo. O motor devolve o valor real só onde
 *   ele é necessário: argumentos de ferramenta, variáveis coletadas e ações.
 *   Na resposta ao cliente aparece mascarado.
 * - Senha, código de acesso e número de cartão nunca chegam ao modelo nem
 *   voltam: são removidos.
 * - Logs e telas de teste gravam só a versão mascarada.
 *
 * Nenhum domínio de cliente.
 */

export type SensitiveKind = "cpf" | "cnpj" | "rg" | "email" | "senha" | "cartao";

const LABELS: Record<Exclude<SensitiveKind, "senha" | "cartao">, string> = {
  cpf: "CPF",
  cnpj: "CNPJ",
  rg: "DOCUMENTO",
  email: "E-MAIL",
};

export const SECRET_REMOVED = "[senha removida]";
export const CARD_REMOVED = "[cartão removido]";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Palavra de segredo + (qualificadores) + separador opcional + valor.
const SECRET_RE = /\b(senha|password|pass|pin|c[oó]digo(?:\s+de)?\s+(?:acesso|verifica[cç][aã]o|seguran[cç]a|confirma[cç][aã]o))\b((?:\s+(?:[ée]|eh|era|[ée]\s+a|atual|nova|padr[aã]o|provis[oó]ria|tempor[aá]ria|para|pra))*)\s*([:=\-–]\s*)?(\S{3,})/gi;
const CPF_FORMATTED_RE = /(?<![\d.])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\d])/g;
const CNPJ_FORMATTED_RE = /(?<![\d.])\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g;
const DIGIT_RUN_RE = /(?<![\d])\d(?:[\d .-]{9,21}\d)(?![\d])/g;
const LABELED_CPF_RE = /\b(cpf)\s*[:\-–]?\s*(\d[\d.\-\s]{9,15}\d)/gi;
const LABELED_RG_RE = /\b(rg|r\.g\.)\s*[:\-–]?\s*(\d[\dxX.\-]{4,13})/gi;

function onlyDigits(s: string): string {
  return s.replace(/\D/g, "");
}

export function isValidCpf(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

export function isValidCnpj(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

function isLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Máscara parcial para mostrar ao cliente ou gravar em log. */
export function partialMask(kind: SensitiveKind, value: string): string {
  if (kind === "senha") return SECRET_REMOVED;
  if (kind === "cartao") return CARD_REMOVED;
  if (kind === "email") {
    const [user, domain] = value.split("@");
    return `${user.slice(0, 1)}***@${domain ?? ""}`;
  }
  const d = onlyDigits(value);
  return `***${d.slice(-2)}`;
}

type Replacer = (kind: SensitiveKind, value: string) => string;

/**
 * Percorre o texto e troca cada dado sensível pelo que `replace` devolver.
 * Ordem importa: senha antes (o valor pode ter dígitos), documentos com
 * rótulo antes dos soltos.
 */
function scan(text: string, replace: Replacer): { text: string; kinds: Set<SensitiveKind> } {
  const kinds = new Set<SensitiveKind>();
  const hit = (kind: SensitiveKind, value: string) => {
    kinds.add(kind);
    return replace(kind, value);
  };
  let out = text;

  out = out.replace(SECRET_RE, (full, word: string, quals: string, sep: string | undefined, value: string) => {
    // "senha incorreta" não é senha: sem separador, só vale valor com
    // dígito ou símbolo.
    if (!sep && !/[\d_]|[^\p{L}\p{N}]/u.test(value.replace(/[.,!?]$/, ""))) return full;
    return `${word}${quals}${sep ? ` ${sep.trim()} ` : " "}${hit("senha", value)}`;
  });

  out = out.replace(EMAIL_RE, (m) => hit("email", m));
  out = out.replace(CNPJ_FORMATTED_RE, (m) => hit("cnpj", m));
  out = out.replace(CPF_FORMATTED_RE, (m) => hit("cpf", m));
  out = out.replace(LABELED_CPF_RE, (full, label: string, value: string) =>
    onlyDigits(value).length === 11 ? `${label} ${hit("cpf", value)}` : full);
  out = out.replace(LABELED_RG_RE, (full, label: string, value: string) =>
    onlyDigits(value).length >= 5 ? `${label} ${hit("rg", value)}` : full);

  out = out.replace(DIGIT_RUN_RE, (m) => {
    const d = onlyDigits(m);
    if (d.length === 11 && isValidCpf(d)) return hit("cpf", m);
    if (d.length === 14 && isValidCnpj(d)) return hit("cnpj", m);
    if (d.length >= 13 && d.length <= 19 && isLuhn(d)) return hit("cartao", m);
    return m;
  });

  return { text: out, kinds };
}

/** Máscara irreversível: logs, telas de teste, diagnóstico. */
export function maskSensitive(text: string): { text: string; kinds: SensitiveKind[] } {
  if (!text) return { text, kinds: [] };
  const r = scan(text, partialMask);
  return { text: r.text, kinds: [...r.kinds] };
}

/**
 * Resposta ao cliente: senha e cartão nunca saem; documento sai só
 * mascarado. E-mail passa (a resposta cita e-mail de atendimento do
 * material).
 */
export function maskOutgoing(text: string): { text: string; kinds: SensitiveKind[] } {
  if (!text) return { text, kinds: [] };
  const kinds = new Set<SensitiveKind>();
  const r = scan(text, (kind, value) => {
    if (kind === "email") return value;
    kinds.add(kind);
    return partialMask(kind, value);
  });
  return { text: r.text, kinds: [...kinds] };
}

/** Máscara irreversível em qualquer JSON (strings em qualquer nível). */
export function maskSensitiveDeep<T>(value: T): T {
  if (typeof value === "string") return maskSensitive(value).text as unknown as T;
  if (Array.isArray(value)) return value.map((v) => maskSensitiveDeep(v)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskSensitiveDeep(v);
    return out as T;
  }
  return value;
}

/**
 * Cofre de um turno: marcador → valor real. Mesmo valor recebe o mesmo
 * marcador em todas as mensagens do turno.
 */
export class SensitiveVault {
  private byToken = new Map<string, { kind: SensitiveKind; value: string }>();
  private byValue = new Map<string, string>();
  private counters: Partial<Record<SensitiveKind, number>> = {};
  readonly kinds = new Set<SensitiveKind>();

  get size(): number {
    return this.byToken.size;
  }

  /** Troca dados sensíveis por marcadores (segredo e cartão são removidos). */
  tokenize(text: string): string {
    if (!text) return text;
    const r = scan(text, (kind, value) => {
      this.kinds.add(kind);
      if (kind === "senha" || kind === "cartao") return partialMask(kind, value);
      const key = `${kind}:${kind === "email" ? value.toLowerCase() : onlyDigits(value)}`;
      const existing = this.byValue.get(key);
      if (existing) return existing;
      const n = (this.counters[kind] = (this.counters[kind] ?? 0) + 1);
      const token = `[${LABELS[kind]} ${n}]`;
      this.byValue.set(key, token);
      this.byToken.set(token, { kind, value });
      return token;
    });
    return r.text;
  }

  private replaceTokens(text: string, fn: (entry: { kind: SensitiveKind; value: string }) => string): string {
    if (this.byToken.size === 0 || !text.includes("[")) return text;
    let out = text;
    for (const [token, entry] of this.byToken) {
      if (out.includes(token)) out = out.split(token).join(fn(entry));
    }
    return out;
  }

  /** Valor real: argumentos de ferramenta, variáveis coletadas, ações. */
  restore(text: string): string {
    return this.replaceTokens(text, (e) => e.value);
  }

  /** Valor mascarado: resposta que vai ao cliente. */
  display(text: string): string {
    return this.replaceTokens(text, (e) => partialMask(e.kind, e.value));
  }

  restoreDeep<T>(value: T): T {
    if (this.byToken.size === 0) return value;
    if (typeof value === "string") return this.restore(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.restoreDeep(v)) as unknown as T;
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.restoreDeep(v);
      return out as T;
    }
    return value;
  }
}
