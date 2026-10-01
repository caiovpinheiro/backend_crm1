/**
 * POST /api/csp-report — destino interno do `report-uri` da CSP em
 * modo Report-Only (SEC-15). Só registra em log; não persiste, não
 * responde conteúdo. Público (o browser envia sem credenciais).
 */
import { getLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = getLogger("csp-report");
const MAX_BODY_BYTES = 16 * 1024;

function pickReport(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  // Formato legado (`report-uri`): { "csp-report": {...} }.
  // Formato Reporting API (`report-to`): [{ body: {...} }].
  const body =
    (rec["csp-report"] as Record<string, unknown> | undefined) ??
    (rec.body as Record<string, unknown> | undefined) ??
    rec;
  const keys = [
    "document-uri",
    "documentURL",
    "violated-directive",
    "effectiveDirective",
    "effective-directive",
    "blocked-uri",
    "blockedURL",
    "source-file",
    "sourceFile",
    "line-number",
    "lineNumber",
    "disposition",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" || typeof v === "number") out[k] = String(v).slice(0, 512);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  let text = "";
  try {
    text = await request.text();
  } catch {
    return new Response(null, { status: 204 });
  }
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(null, { status: 204 });
  }
  const reports = Array.isArray(parsed) ? parsed.slice(0, 10) : [parsed];
  for (const r of reports) {
    const picked = pickReport(r);
    if (picked) log.warn({ cspReport: picked }, "violação CSP (report-only)");
  }
  return new Response(null, { status: 204 });
}
