/**
 * Helpers HTTP das rotas públicas do webchat: corpo JSON, contexto de org
 * do canal e rate limit por visitante/IP.
 */
import { NextResponse } from "next/server";

import { getClientIp, withRateLimit, type RateLimitProfile } from "@/lib/rate-limit";
import { withSystemContext } from "@/lib/webhook-context";
import { webchatError } from "@/lib/webchat/session";

/** Ator das escritas feitas em nome do visitante (feed/auditoria). */
const WEBCHAT_ACTOR = { type: "INTEGRATION" as const, label: "Webchat" };

export function inWebchatOrg<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  return withSystemContext(organizationId, fn, { userId: "webchat", actor: WEBCHAT_ACTOR });
}

export async function readJsonObject(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: webchatError(400, "INVALID_JSON", "JSON inválido.") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: webchatError(400, "INVALID_BODY", "Corpo deve ser um objeto JSON.") };
  }
  return { ok: true, body: body as Record<string, unknown> };
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

export { getClientIp };
