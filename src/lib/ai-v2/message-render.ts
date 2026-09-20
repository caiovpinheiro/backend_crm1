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

const KEY_CHARS = /[\p{L}\p{N}_ ]/u;

function isKeyChar(char: string): boolean {
  return KEY_CHARS.test(char);
}

function readKey(template: string, start: number): { key: string; end: number } | null {
  let i = start;
  while (i < template.length && isKeyChar(template[i])) {
    i++;
  }
  const key = template.slice(start, i).trim();
  if (!key) return null;
  return { key, end: i };
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
  const value = variables[key];
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
      const keyRead = readKey(template, i + 1);
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
      result += formatValue(key, variables[key], formatter);
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

/** Wrapper que junta variáveis do agente com campos do contato/negócio. */
export function buildVariableMap(
  agentVariables: Array<{ key: string; value: string }>,
  contact: Record<string, unknown> | null,
  deal: Record<string, unknown> | null,
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const v of agentVariables) {
    map[v.key] = v.value;
  }
  if (contact) {
    for (const [k, v] of Object.entries(contact)) {
      map[k] = v;
    }
  }
  if (deal) {
    for (const [k, v] of Object.entries(deal)) {
      map[k] = v;
    }
  }
  return map;
}
