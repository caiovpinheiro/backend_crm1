/**
 * Helpers HTTP das rotas públicas do webchat: corpo JSON com teto de
 * tamanho, contexto de org do canal e rate limit por visitante/IP.
 */
import { NextResponse } from "next/server";

import { getClientIp as rawClientIp } from "@/lib/client-ip";
import { withRateLimit, type RateLimitProfile } from "@/lib/rate-limit";
import { withSystemContext } from "@/lib/webhook-context";
import { webchatError } from "@/lib/webchat/session";

/** Ator das escritas feitas em nome do visitante (feed/auditoria). */
const WEBCHAT_ACTOR = { type: "INTEGRATION" as const, label: "Webchat" };

/**
 * Teto do corpo das rotas públicas. O maior corpo legítimo é o POST
 * /messages (4000 chars, até ~16 KB em UTF-8) — 32 KB sobra.
 */
export const WEBCHAT_MAX_BODY_BYTES = 32 * 1024;

export function inWebchatOrg<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  return withSystemContext(organizationId, fn, { userId: "webchat", actor: WEBCHAT_ACTOR });
}

function payloadTooLarge(): NextResponse {
  return webchatError(413, "PAYLOAD_TOO_LARGE", "Corpo da requisição grande demais.");
}

/**
 * Recusa pelo `Content-Length` declarado, antes de autenticar ou ler o
 * corpo (barato: só o cabeçalho). Corpo sem `Content-Length` (chunked) é
 * cortado na leitura por `readLimitedText`.
 */
export function rejectOversizedBody(
  request: Request,
  max: number = WEBCHAT_MAX_BODY_BYTES,
): NextResponse | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return webchatError(400, "INVALID_BODY", "Content-Length inválido.");
  }
  return n > max ? payloadTooLarge() : null;
}

/** Lê o corpo como texto, parando (413) ao passar de `max` bytes. */
export async function readLimitedText(
  request: Request,
  max: number = WEBCHAT_MAX_BODY_BYTES,
): Promise<{ ok: true; text: string } | { ok: false; response: NextResponse }> {
  const declared = rejectOversizedBody(request, max);
  if (declared) return { ok: false, response: declared };
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => {});
        return { ok: false, response: payloadTooLarge() };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: webchatError(400, "INVALID_BODY", "Corpo ilegível.") };
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buf) };
}

export async function readJsonObject(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const read = await readLimitedText(request);
  if (!read.ok) return read;
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return { ok: false, response: webchatError(400, "INVALID_JSON", "JSON inválido.") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: webchatError(400, "INVALID_BODY", "Corpo deve ser um objeto JSON.") };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/** "2001:db8:1:2:3:4:5:6" → 8 grupos de 16 bits; null se não for IPv6. */
function ipv6Groups(ip: string): number[] | null {
  if (!ip.includes(":")) return null;
  let v = ip.toLowerCase();
  const zone = v.indexOf("%");
  if (zone !== -1) v = v.slice(0, zone);
  // IPv4 embutido no fim (::ffff:1.2.3.4) — os 32 bits finais não entram no /64.
  const lastColon = v.lastIndexOf(":");
  if (v.slice(lastColon + 1).includes(".")) v = `${v.slice(0, lastColon + 1)}0:0`;
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parse(halves[1]!);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * Chave de IP para rate limit. IPv6 vira o prefixo /64: um único cliente
 * costuma ter o /64 inteiro e trocaria de endereço a cada requisição para
 * furar o limite. IPv4 (e o que não for IPv6 válido) segue como está.
 */
export function rateLimitIpKey(ip: string): string {
  const g = ipv6Groups(ip);
  if (!g) return ip;
  return `${g
    .slice(0, 4)
    .map((n) => n.toString(16))
    .join(":")}::/64`;
}

/** IP do cliente já como chave de rate limit (IPv6 → /64). */
export function getClientIp(request: Request): string {
  return rateLimitIpKey(rawClientIp(request));
}

/** Aplica os limites em sequência; o primeiro estourado responde 429. */
export async function webchatRateLimit(
  route: string,
  checks: { profile: RateLimitProfile; scope: "ip" | "visitor"; id: string | null }[],
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; response: Response }> {
  let headers: Record<string, string> = {};
  for (const c of checks) {
    const rl = await withRateLimit({ route, profile: c.profile, scope: c.scope, id: c.id });
    if (!rl.ok) return { ok: false, response: rl.response };
    headers = rl.headers;
  }
  return { ok: true, headers };
}
