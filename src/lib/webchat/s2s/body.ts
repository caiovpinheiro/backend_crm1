/**
 * Webchat v2 — corpo da entrada servidor a servidor
 * (docs/decisoes/webchat-widget.md §9.6). Funções puras: validam o JSON já
 * autenticado e devolvem o pedido normalizado ou o motivo da recusa (sem
 * ecoar valores — o motivo vai na resposta 400, nunca dado pessoal).
 */
import { normalizeWebchatExternalId } from "@/lib/webchat/contact-match";
import { normalizeWebchatRef } from "@/lib/webchat/conversation-ref";

export const WEBCHAT_S2S_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const WEBCHAT_S2S_MAX_TEXT_CHARS = 4000;
export const WEBCHAT_S2S_MAX_LABEL_CHARS = 64;
export const WEBCHAT_S2S_MAX_LINKS = 5;
export const WEBCHAT_S2S_MAX_LINK_LABEL_CHARS = 80;
export const WEBCHAT_S2S_MAX_LINK_URL_CHARS = 2000;

export type WebchatS2SLink = { label: string; url: string };

export type WebchatS2SRequest = {
  externalId: string;
  ref: string | null;
  category: string | null;
  priority: string | null;
  /** Texto da nota (já sem caracteres de controle exceto quebra de linha). */
  text: string | null;
  /** `fields` cru (objeto) — sanitizado pelas regras do contexto vivo. */
  fields: Record<string, unknown> | null;
  links: WebchatS2SLink[];
};

export type ParseS2SResult = { ok: true; request: WebchatS2SRequest } | { ok: false; message: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function isValidIdempotencyKey(v: string | null): v is string {
  return typeof v === "string" && WEBCHAT_S2S_IDEMPOTENCY_KEY_RE.test(v);
}

/** Texto curto opcional (category/priority): trim, sem controle, ≤ max. */
function shortLabel(v: unknown, max: number): string | null | false {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!t) return null;
  if (t.length > max || /[\u0000-\u001F\u007F]/.test(t)) return false;
  return t;
}

/** Texto da nota: mantém quebras de linha, remove outros controles. */
function noteText(v: unknown): string | null | false {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return false;
  const t = v
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ")
    .trim();
  if (!t) return null;
  return t.length > WEBCHAT_S2S_MAX_TEXT_CHARS ? false : t;
}

/** Só https, sem usuário/senha, ≤ 2000. O CRM nunca busca esta URL: só mostra. */
function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const raw = v.trim();
  if (!raw || raw.length > WEBCHAT_S2S_MAX_LINK_URL_CHARS) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const out = u.toString();
    return out.length > WEBCHAT_S2S_MAX_LINK_URL_CHARS ? null : out;
  } catch {
    return null;
  }
}

function parseLinks(v: unknown): WebchatS2SLink[] | false {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > WEBCHAT_S2S_MAX_LINKS) return false;
  const out: WebchatS2SLink[] = [];
  for (const raw of v) {
    if (!isObj(raw)) return false;
    const label = shortLabel(raw.label, WEBCHAT_S2S_MAX_LINK_LABEL_CHARS);
    const url = httpsUrl(raw.url);
    if (!label || !url) return false;
    out.push({ label, url });
  }
  return out;
}

export function parseWebchatS2SBody(body: unknown): ParseS2SResult {
  if (!isObj(body)) return { ok: false, message: "Corpo deve ser um objeto JSON." };
  const externalId = normalizeWebchatExternalId(body.external_id);
  if (!externalId) return { ok: false, message: "external_id obrigatório (texto até 128 caracteres)." };

  let ref: string | null = null;
  if (body.ref !== undefined && body.ref !== null && body.ref !== "") {
    ref = normalizeWebchatRef(body.ref);
    if (!ref) return { ok: false, message: "ref inválido (texto até 128 caracteres)." };
  }
  const category = shortLabel(body.category, WEBCHAT_S2S_MAX_LABEL_CHARS);
  if (category === false) return { ok: false, message: "category inválida (texto até 64 caracteres)." };
  const priority = shortLabel(body.priority, WEBCHAT_S2S_MAX_LABEL_CHARS);
  if (priority === false) return { ok: false, message: "priority inválida (texto até 64 caracteres)." };
  const text = noteText(body.text);
  if (text === false) return { ok: false, message: `text inválido (até ${WEBCHAT_S2S_MAX_TEXT_CHARS} caracteres).` };

  let fields: Record<string, unknown> | null = null;
  if (body.fields !== undefined && body.fields !== null) {
    if (!isObj(body.fields)) return { ok: false, message: "fields deve ser um objeto." };
    fields = Object.keys(body.fields).length > 0 ? body.fields : null;
  }
  const links = parseLinks(body.links);
  if (links === false) {
    return {
      ok: false,
      message: `links inválido (até ${WEBCHAT_S2S_MAX_LINKS} itens { label, url https }).`,
    };
  }
  if (!text && !fields) return { ok: false, message: "Informe text ou fields." };
  return { ok: true, request: { externalId, ref, category, priority, text, fields, links } };
}

/** Texto da nota do S2S: o `text` e uma linha `label — url` por link. */
export function buildWebchatS2SNote(text: string | null, links: WebchatS2SLink[]): string | null {
  const lines: string[] = [];
  if (text) lines.push(text);
  if (links.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const l of links) lines.push(`${l.label} — ${l.url}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
