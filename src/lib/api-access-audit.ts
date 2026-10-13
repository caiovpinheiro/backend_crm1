/**
 * Auditoria operacional de rotas `/api/*` em produção.
 *
 * - Headers `x-crm-api-path`, `x-crm-http-method`, `x-crm-request-id` são
 *   injetados no middleware (Edge) para handlers Node lerem via `headers()`.
 * - Falhas de auth em `authenticateApiRequest` e `requireAuth` geram
 *   `warn` estruturado (baixo volume) — ajuda a diagnosticar “nada funciona”.
 * - Conclusão de handlers em `withApiAuthContext` / `withOrgContext` gera
 *   `info` para 4xx/5xx, requisições lentas (≥5s) ou tudo se `API_ACCESS_AUDIT=all`.
 *
 * Desligar: `API_ACCESS_AUDIT=0`. Nunca logar corpo, tokens ou cookies.
 *
 * @see .env.example
 */

import { headers } from "next/headers";
import { NextResponse } from "next/server";

import {
  CRM_API_PATH_HEADER,
  CRM_API_SEARCH_HEADER,
  CRM_HTTP_METHOD_HEADER,
  CRM_REQUEST_ID_HEADER,
} from "@/lib/api-access-audit-constants";
import { getLogger } from "@/lib/logger";

const log = getLogger("api.access");

export {
  CRM_API_PATH_HEADER,
  CRM_HTTP_METHOD_HEADER,
  CRM_REQUEST_ID_HEADER,
} from "@/lib/api-access-audit-constants";

export function isApiAccessAuditDisabled(): boolean {
  const v = process.env.API_ACCESS_AUDIT?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

export function isApiAccessAuditVerbose(): boolean {
  const v = process.env.API_ACCESS_AUDIT?.trim().toLowerCase();
  return v === "all" || v === "1" || v === "true";
}

export function shouldLogApiAccessSuccess(args: {
  status: number;
  durationMs: number;
}): boolean {
  if (isApiAccessAuditDisabled()) return false;
  if (isApiAccessAuditVerbose()) return true;
  if (process.env.NODE_ENV !== "production") return false;
  return args.status >= 400 || args.durationMs >= 5000;
}

export async function readApiAccessHeaders(): Promise<{
  path?: string;
  method?: string;
  requestId?: string;
  /** GET com `search`/`q` (classe de custo `heavy_read`). */
  hasSearch?: boolean;
  /** Objeto da requisição — identifica a requisição sem confiar em header. */
  requestToken?: object;
}> {
  try {
    const h = await headers();
    return {
      path: h.get(CRM_API_PATH_HEADER) ?? undefined,
      method: h.get(CRM_HTTP_METHOD_HEADER) ?? undefined,
      requestId: h.get(CRM_REQUEST_ID_HEADER) ?? undefined,
      hasSearch: h.get(CRM_API_SEARCH_HEADER) === "1",
      requestToken: h,
    };
  } catch {
    return {};
  }
}

function pathnameFromRequest(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
  }
}

/** Falha antes do handler (token/sessão/org). `request` quando disponível. */
export function logApiAccessAuthReject(request: Request | null, payload: {
  reason: string;
  status?: number;
  via?: "bearer" | "session" | "unknown";
}): void {
  if (isApiAccessAuditDisabled()) return;
  const path = request ? pathnameFromRequest(request) : undefined;
  log.warn(
    {
      scope: "api.access",
      phase: "auth_reject",
      reason: payload.reason,
      path: path || undefined,
      status: payload.status ?? 401,
      via: payload.via ?? "unknown",
    },
    "[api.access] auth_reject",
  );
}

/** Falha em `requireAuth` / sessão sem org — path vem dos headers do middleware. */
export async function logApiAccessRequireAuthFail(reason: string, status = 401): Promise<void> {
  if (isApiAccessAuditDisabled()) return;
  const { path, method, requestId } = await readApiAccessHeaders();
  log.warn(
    {
      scope: "api.access",
      phase: "require_auth_fail",
      reason,
      path,
      method,
      requestId,
      status,
    },
    "[api.access] require_auth_fail",
  );
}

export async function logApiAccessCompleted(payload: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string | null;
  organizationId?: string | null;
  requestId?: string | null;
}): Promise<void> {
  if (!shouldLogApiAccessSuccess({ status: payload.status, durationMs: payload.durationMs })) {
    return;
  }
  const fromHeaders = await readApiAccessHeaders();
  log.info(
    {
      scope: "api.access",
      phase: "complete",
      method: payload.method,
      path: payload.path || fromHeaders.path,
      status: payload.status,
      durationMs: payload.durationMs,
      userId: payload.userId,
      organizationId: payload.organizationId,
      requestId: payload.requestId ?? fromHeaders.requestId,
    },
    "[api.access] complete",
  );
}

export function resolveResponseStatus(result: unknown): number {
  if (result instanceof NextResponse) return result.status;
  return 200;
}
