import { NextResponse } from "next/server";

import type { CallDirection, CallStatus } from "@prisma/client";
import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { listCalls } from "@/services/calls";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/calls");

/**
 * GET /api/calls
 * Lista chamadas da org com filtros opcionais.
 * RBAC: call:view
 *
 * Query params:
 *   extensionId  — filtrar por ramal
 *   direction    — INBOUND | OUTBOUND
 *   contactId    — filtrar por contato
 *   status       — RINGING | ANSWERED | COMPLETED | MISSED | BUSY | FAILED
 *   page         — página (default 1)
 *   perPage      — itens por página (default 20, max 100)
 */
export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "call:view");
    if (denied) return denied;

    const url = new URL(request.url);

    const VALID_DIRECTIONS = new Set<CallDirection>(["INBOUND", "OUTBOUND"]);
    const VALID_STATUSES = new Set<CallStatus>([
      "RINGING", "ANSWERED", "COMPLETED", "MISSED", "BUSY", "FAILED",
    ]);

    const rawDirection = url.searchParams.get("direction")?.toUpperCase();
    const rawStatus    = url.searchParams.get("status")?.toUpperCase();

    const VALID_SORT_FIELDS = new Set([
      "startedAt",
      "durationSeconds",
      "status",
      "direction",
    ] as const);
    const rawSortBy = url.searchParams.get("sortBy") ?? undefined;
    const rawSortDir = url.searchParams.get("sortDir") ?? undefined;

    const filters = {
      extensionId: url.searchParams.get("extensionId") ?? undefined,
      direction:   (rawDirection && VALID_DIRECTIONS.has(rawDirection as CallDirection)
        ? rawDirection as CallDirection
        : undefined),
      contactId:   url.searchParams.get("contactId")   ?? undefined,
      status:      (rawStatus && VALID_STATUSES.has(rawStatus as CallStatus)
        ? rawStatus as CallStatus
        : undefined),
      search:      url.searchParams.get("search")   ?? undefined,
      dateFrom:    url.searchParams.get("dateFrom") ?? undefined,
      dateTo:      url.searchParams.get("dateTo")   ?? undefined,
      sortBy:      (rawSortBy && VALID_SORT_FIELDS.has(rawSortBy as "startedAt")
        ? (rawSortBy as "startedAt" | "durationSeconds" | "status" | "direction")
        : undefined),
      sortDir:     (rawSortDir === "asc" || rawSortDir === "desc"
        ? rawSortDir
        : undefined),
      page:        Number(url.searchParams.get("page"))    || 1,
      perPage:     Number(url.searchParams.get("perPage")) || 20,
    };

    try {
      const result = await listCalls(filters);
      // Serializa para o shape `CallRecord` esperado pelo frontend
      // (phone = outra ponta, recordUrl, datas em ISO). Antes o front
      // recebia o row cru do Prisma (fromNumber/toNumber/recordingUrl) e
      // exibia "undefined"/datas inválidas.
      const calls = result.calls.map((c) => ({
        id: c.id,
        direction: c.direction,
        status: c.status,
        phone: c.direction === "INBOUND" ? c.fromNumber : c.toNumber,
        durationSeconds: c.durationSeconds ?? null,
        startedAt: (c.startedAt ?? c.createdAt)?.toISOString() ?? null,
        endedAt: c.endedAt ? c.endedAt.toISOString() : null,
        recordUrl: c.recordingUrl ?? null,
        contactId: c.contactId ?? null,
        dealId: c.dealId ?? null,
        extensionId: c.extensionId ?? null,
        contact: c.contact ?? null,
        agent: c.agent ?? null,
      }));
      return NextResponse.json({
        calls,
        total: result.total,
        page: result.page,
        perPage: result.perPage,
      });
    } catch (e) {
      log.error({ err: e }, "[calls] GET falhou");
      return NextResponse.json({ message: "Erro ao listar chamadas." }, { status: 500 });
    }
  });
}
