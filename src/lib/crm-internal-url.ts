/**
 * Parser de rotas internas do CRM — não regex no domínio.
 * Usado no unfurl do WiPO Chat (Fase 2).
 */

export type CrmAnchorType = "deal" | "conversation" | "contact";

export type CrmInternalRef = {
  type: CrmAnchorType;
  /** Número público ou CUID, como veio na URL. */
  id: string;
};

const APP_PATHS = new Set([
  "inbox",
  "pipeline",
  "contacts",
  "companies",
  "activities",
  "bwipo-chat",
  "team-chat",
  "dashboard",
  "settings",
  "automations",
  "campaigns",
  "fluxo",
]);

function tryParseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed);
    if (trimmed.startsWith("/")) return new URL(trimmed, "https://crm.local");
    return null;
  } catch {
    return null;
  }
}

function firstSegment(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0] ?? "";
}

/**
 * Interpreta uma URL absoluta ou path interno (`/inbox?c=1`).
 * Só aceita rotas conhecidas do app — o host é ignorado de propósito.
 */
export function parseCrmInternalUrl(raw: string): CrmInternalRef | null {
  const url = tryParseUrl(raw);
  if (!url) return null;
  const seg = firstSegment(url.pathname);
  if (!APP_PATHS.has(seg) && seg !== "pipeline") return null;

  const dealQ = url.searchParams.get("deal");
  if (dealQ && (seg === "pipeline" || url.pathname.startsWith("/pipeline"))) {
    return { type: "deal", id: dealQ.trim() };
  }

  if (seg === "inbox") {
    const c = url.searchParams.get("c") ?? url.searchParams.get("conversation");
    if (c?.trim()) return { type: "conversation", id: c.trim() };
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "contacts" && parts[1] && parts[1] !== "new") {
    return { type: "contact", id: parts[1] };
  }

  return null;
}

const URL_TOKEN = /https?:\/\/[^\s<>"']+|\/(?:inbox|pipeline|contacts)[^\s<>"']*/gi;

export function extractCrmRefsFromText(text: string): CrmInternalRef[] {
  const out: CrmInternalRef[] = [];
  const seen = new Set<string>();
  const matches = text.match(URL_TOKEN) ?? [];
  for (const raw of matches) {
    const ref = parseCrmInternalUrl(raw.replace(/[),.;]+$/, ""));
    if (!ref) continue;
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function stripCrmUrls(text: string): string {
  return text
    .replace(URL_TOKEN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function previewLabelForAnchor(
  type: CrmAnchorType | "work_item",
  number?: number | null,
  title?: string | null,
): string {
  const n = number != null ? `#${number}` : "";
  if (type === "conversation") return `Atendimento ${n}`.trim();
  if (type === "deal") return title?.trim() ? `Negócio ${n} · ${title}` : `Negócio ${n}`.trim();
  if (type === "contact") return title?.trim() ? `Contato ${n} · ${title}` : `Contato ${n}`.trim();
  return title?.trim() || "Checklist";
}

export function hrefForAnchor(type: CrmAnchorType, numberOrId: string | number): string {
  const id = String(numberOrId);
  if (type === "conversation") return `/inbox?c=${encodeURIComponent(id)}`;
  if (type === "deal") return `/pipeline?deal=${encodeURIComponent(id)}`;
  return `/contacts/${encodeURIComponent(id)}`;
}
