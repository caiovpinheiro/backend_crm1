/**
 * Renderizador de mensagens da v2.
 * Suporta:
 *   - @Variavel → valor formatado
 *   - @Variavel{ texto condicional } → só renderiza se a variável tiver valor;
 *     dentro do bloco, outras @Variáveis e blocos condicionais são resolvidos.
 *   - Formatação por tipo: data, moeda, número, lista.
 *
 * Nenhum termo de domínio de cliente aqui.
 */

export type V2MessageFormatter = (key: string, value: unknown) => string | undefined;

const KEY_CHARS = /[\p{L}\p{N}_. ]/u;

function isKeyChar(char: string): boolean {
  return KEY_CHARS.test(char);
}

function stripTrailingPunctuation(input: string): { text: string; removed: number } {
  let text = input;
  let removed = 0;
  while (text.length > 0 && /[.:\\,;!?]$/.test(text[text.length - 1])) {
    text = text.slice(0, -1);
    removed++;
  }
  return { text, removed };
}

function readKey(
  template: string,
  start: number,
  variables: Record<string, unknown>,
): { key: string; end: number } | null {
  // Lê o maior bloco possível de caracteres válidos para uma chave
  // (letras, números, underscore, ponto e espaço). Espaços são permitidos
  // para chaves de variáveis multi-palavra, como "Nome da empresa".
  let i = start;
  while (i < template.length && isKeyChar(template[i])) {
    i++;
  }

  // Remove pontuação no final do bloco, que não faz parte da chave.
  let end = i;
  while (end > start && /[.:\\,;!?]$/.test(template[end - 1])) {
    end--;
  }

  let raw = template.slice(start, end).trimEnd();
  if (!raw) return null;

  // Tenta casar a chave mais longa conhecida. Se a chave completa não existe,
  // volta removendo a última palavra até encontrar uma chave conhecida ou
  // chegar em uma única palavra. Em cada candidato, descarta pontuação no
  // final (ex.: "contact.name." → "contact.name") para que o ponto não seja
  // consumido como parte da chave. Isso evita que "@name e depois @name"
  // consuma o texto entre as duas variáveis como parte da primeira chave.
  const isKnown = (candidate: string): boolean => {
    const { text } = stripTrailingPunctuation(candidate);
    if (text === "") return false;
    if (Object.prototype.hasOwnProperty.call(variables, text)) return true;
    if (text.includes(".")) {
      const resolved = resolveVariable(variables, text);
      return resolved !== undefined;
    }
    return false;
  };

  let candidate = raw;
  while (candidate.length > 0 && !isKnown(candidate)) {
    const lastSpace = candidate.lastIndexOf(" ");
    if (lastSpace <= 0) break;
    candidate = candidate.slice(0, lastSpace).trimEnd();
  }

  if (candidate.length > 0 && isKnown(candidate)) {
    const { text, removed } = stripTrailingPunctuation(candidate);
    return { key: text, end: start + candidate.length - removed };
  }

  // Nenhuma chave multi-palavra conhecida: usa a primeira palavra do bloco
  // como chave, deixando o restante do texto intacto. Descarta pontuação final.
  const firstToken = raw.split(" ")[0];
  const { text, removed } = stripTrailingPunctuation(firstToken);
  if (!text) return null;
  return { key: text, end: start + firstToken.length - removed };
}

function resolveVariable(variables: Record<string, unknown>, key: string): unknown {
  const direct = variables[key];
  if (direct !== undefined) return direct;
  if (!key.includes(".")) return undefined;
  const parts = key.split(".");
  let current: unknown = variables;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return undefined;
  }
  return current;
}

function findMatchingBrace(template: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < template.length && depth > 0) {
    const char = template[i];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

function hasTruthyValue(variables: Record<string, unknown>, key: string): boolean {
  const value = resolveVariable(variables, key);
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (typeof value === "object" && value !== null && Object.keys(value).length === 0) return false;
  return true;
}

function formatValue(key: string, value: unknown, formatter?: V2MessageFormatter): string {
  if (formatter) {
    const result = formatter(key, value);
    if (result !== undefined) return result;
  }
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderMessage(
  template: string,
  variables: Record<string, unknown>,
  formatter?: V2MessageFormatter,
): string {
  let result = "";
  let i = 0;

  while (i < template.length) {
    const char = template[i];

    if (char === "@") {
      const keyRead = readKey(template, i + 1, variables);
      if (!keyRead) {
        result += char;
        i++;
        continue;
      }
      const { key, end } = keyRead;

      // Verifica se tem bloco condicional { ... }
      let after = end;
      while (after < template.length && template[after] === " ") after++;
      if (template[after] === "{") {
        const closeIndex = findMatchingBrace(template, after + 1);
        if (closeIndex > 0) {
          const innerTemplate = template.slice(after + 1, closeIndex);
          if (hasTruthyValue(variables, key)) {
            result += renderMessage(innerTemplate, variables, formatter);
          }
          i = closeIndex + 1;
          continue;
        }
      }

      // Referência simples
      result += formatValue(key, resolveVariable(variables, key), formatter);
      i = end;
      continue;
    }

    if (char === "{" || char === "}") {
      // Chaves soltas sem @ anterior são ignoradas (só aparecem dentro de blocos resolvidos)
      result += char;
      i++;
      continue;
    }

    result += char;
    i++;
  }

  // Limpa espaços duplos e vírgulas soltas deixadas por valores vazios
  return result
    .replace(/[ \t]+/g, " ")
    .replace(/\s*,\s*,/g, ",")
    .replace(/\s+,/g, "")
    .replace(/,\s*\./g, ".")
    .trim();
}

/** Formatação por tipo padrão. */
export function defaultFormatter(locale = "pt-BR"): V2MessageFormatter {
  return (key: string, value: unknown): string | undefined => {
    if (value === null || value === undefined) return "";

    const lowerKey = key.toLowerCase();

    // Data
    if (lowerKey.includes("data") || lowerKey.includes("date")) {
      if (value instanceof Date) {
        return value.toLocaleDateString(locale);
      }
      const d = new Date(String(value));
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString(locale);
      }
    }

    // Moeda
    if (lowerKey.includes("preço") || lowerKey.includes("valor") || lowerKey.includes("price") || lowerKey.includes("amount")) {
      const n = Number(value);
      if (!Number.isNaN(n)) {
        return n.toLocaleString(locale, { style: "currency", currency: "BRL" });
      }
    }

    // Número
    if (lowerKey.includes("numero") || lowerKey.includes("quantidade") || lowerKey.includes("count")) {
      const n = Number(value);
      if (!Number.isNaN(n)) return n.toLocaleString(locale);
    }

    return undefined;
  };
}

/** Wrapper que junta variáveis do agente com campos do contato/negócio.
 *  Usa os mapas `*Raw` (chaves técnicas) para variáveis como @contact.name;
 *  se ausentes, fallback para os mapas com rótulos legíveis.
 */
export function buildVariableMap(
  agentVariables: Array<{ key: string; value: string }>,
  contact: Record<string, unknown> | null,
  deal: Record<string, unknown> | null,
  contactRaw?: Record<string, unknown> | null,
  dealRaw?: Record<string, unknown> | null,
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const v of agentVariables) {
    map[v.key] = v.value;
  }
  const rawContact = contactRaw ?? contact;
  if (rawContact) {
    for (const [k, v] of Object.entries(rawContact)) {
      map[k] = v;
    }
    map.contact = { ...rawContact };
  }
  const rawDeal = dealRaw ?? deal;
  if (rawDeal) {
    for (const [k, v] of Object.entries(rawDeal)) {
      map[k] = v;
    }
    map.deal = { ...rawDeal };
  }
  return map;
}

function identityText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Valores dos campos de confirmação que estão preenchidos. Sem lista, usa o nome do contato. */
export function confirmationIdentityValues(args: {
  fieldKeys: string[];
  fieldLabels: Array<{ key: string; label?: string }>;
  sources: Array<Record<string, unknown> | null | undefined>;
}): string[] {
  const keys = args.fieldKeys.length > 0 ? args.fieldKeys : ["name"];
  const values: string[] = [];
  for (const key of keys) {
    const label = args.fieldLabels.find((field) => field.key === key)?.label;
    let found = "";
    for (const source of args.sources) {
      if (!source) continue;
      const raw = source[key] ?? (label ? source[label] : undefined);
      const text = identityText(raw);
      if (text) {
        found = text;
        break;
      }
    }
    if (found && !values.some((value) => value.toLocaleLowerCase() === found.toLocaleLowerCase())) {
      values.push(found);
    }
  }
  return values;
}

/** Coloca os dados confirmados na frase. "você" vira o valor; senão o valor entra no fim. */
export function applyConfirmationIdentity(message: string, values: string[]): string {
  const missing = values.filter((value) => value && !message.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
  if (missing.length === 0 || !message.trim()) return message;
  const identity = missing.join(", ");
  if (message.includes("você")) return message.replace("você", identity);
  return `${message.trim()}\n\n${identity}`;
}
