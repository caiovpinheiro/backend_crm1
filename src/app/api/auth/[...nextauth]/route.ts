import type { NextRequest } from "next/server";

import { handlers } from "@/lib/auth";
import { sanitizeRevokedSessionResponse } from "@/lib/auth/revoked-session";

/**
 * Token revogado em `GET/POST /api/auth/session` (`useSession` / `update()`):
 * corpo `null` e cookie de sessão apagado, como antes da marcação do token
 * (ver `sanitizeRevokedSessionResponse`). Demais ações do Auth.js passam
 * intactas.
 */
export async function GET(req: NextRequest): Promise<Response> {
  return sanitizeRevokedSessionResponse(await handlers.GET(req));
}

export async function POST(req: NextRequest): Promise<Response> {
  return sanitizeRevokedSessionResponse(await handlers.POST(req));
}
