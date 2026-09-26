/**
 * Campos do CRM que o agente mostra ao cliente: máscara por campo e
 * informações montadas a partir de outros campos.
 *
 * Máscara ("O que ele sabe › Dados do cliente"):
 *  - "partial": mantém o começo e o fim e troca o meio por "x", preservando
 *    a pontuação — 218.456.789-21 → 218.xxx.xxx-21;
 *  - "email": mantém o começo do usuário e o domínio — ma***@dominio.com.br.
 * O valor mascarado é o único que o modelo recebe e o que sai na
 * confirmação e nas mensagens com @variável.
 *
 * Informação montada: partes de campos (inteiro, primeiros N ou últimos N
 * caracteres, opcionalmente só os dígitos) e textos fixos. Calculada pelo
 * motor — o modelo não monta valores. Se algum campo usado estiver vazio,
 * a informação fica vazia (nunca sai pela metade).
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2DerivedField, V2FieldMask } from "./types";

const ALNUM = /[\p{L}\p{N}]/u;

/** Valor com a máscara do campo. */
export function maskFieldValue(value: string, mask: V2FieldMask | undefined): string {
  const v = value.trim();
  if (!v || !mask || mask === "none") return v;
  if (mask === "email") {
    const at = v.indexOf("@");
    if (at > 0) {
      const user = v.slice(0, at);
      return `${user.slice(0, Math.min(2, Math.max(1, user.length - 1)))}***${v.slice(at)}`;
    }
  }
  // "partial" (e e-mail sem @): começo e fim visíveis, o meio vira "x".
  const positions = [...v].map((c, i) => (ALNUM.test(c) ? i : -1)).filter((i) => i >= 0);
  if (positions.length <= 4) return v.replace(/[\p{L}\p{N}]/gu, "x");
  const keepStart = positions.length >= 9 ? 3 : 2;
  const keepEnd = 2;
  const hidden = new Set(positions.slice(keepStart, positions.length - keepEnd));
  return [...v].map((c, i) => (hidden.has(i) ? "x" : c)).join("");
}

/** Valor de uma informação montada; "" se faltar algum campo usado. */
export function derivedFieldValue(
  field: V2DerivedField,
  contact: Record<string, unknown> | null | undefined,
  deal: Record<string, unknown> | null | undefined,
): string {
  let out = "";
  for (const part of field.parts ?? []) {
    if (part.kind === "text") {
      out += part.text ?? "";
      continue;
    }
    const source = part.entity === "deal" ? deal : contact;
    const raw = part.key ? source?.[part.key] : undefined;
    let text = raw === null || raw === undefined ? "" : String(raw).trim();
    if (part.digitsOnly) text = text.replace(/\D/g, "");
    if (!text) return "";
    const n = Math.max(0, Math.floor(part.count ?? 0));
    if (part.take === "first" && n > 0) text = text.slice(0, n);
    else if (part.take === "last" && n > 0) text = text.slice(-n);
    out += text;
  }
  return out;
}

/** Máscaras configuradas por chave e por rótulo do campo. */
export function fieldMasks(config: Pick<V2AgentConfig, "contextFields">): Record<string, V2FieldMask> {
  const out: Record<string, V2FieldMask> = {};
  for (const f of [...(config.contextFields?.contact ?? []), ...(config.contextFields?.deal ?? [])]) {
    if (!f.mask || f.mask === "none") continue;
    out[f.key] = f.mask;
    if (f.label) out[f.label] = f.mask;
  }
  return out;
}

/** Informações montadas já calculadas (com a máscara de cada uma), por rótulo. */
export function derivedFieldValues(
  config: Pick<V2AgentConfig, "derivedFields">,
  contact: Record<string, unknown> | null | undefined,
  deal: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of config.derivedFields ?? []) {
    const label = f.label?.trim();
    if (!label) continue;
    const value = derivedFieldValue(f, contact, deal);
    if (value) out[label] = maskFieldValue(value, f.mask);
  }
  return out;
}
