import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import {
  cockpitCorsHeaders,
  tryCockpitAccessAuth,
  tryCockpitEmbedAuth,
} from "@/lib/cockpit-access";
import { getOrgIdOrThrow, runWithContext } from "@/lib/request-context";
import { getAcademicCockpitCases } from "@/services/ai/cockpit-academic-cases";

function jsonWithCors(request: Request, body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(cockpitCorsHeaders(request))) {
    headers.set(k, v);
  }
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

async function serveCases(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key")?.trim() ?? "";
  try {
    const organizationId = getOrgIdOrThrow();
    const data = await getAcademicCockpitCases({ organizationId, key });
    return jsonWithCors(request, data);
  } catch (e) {
    const status = (e as { status?: number }).status === 400 ? 400 : 500;
    const message =
      e instanceof Error ? e.message : "Erro ao carregar os casos.";
    console.error("[cockpit] falha ao listar casos", e);
    return jsonWithCors(request, { message }, { status });
  }
}

export async function OPTIONS(request: Request) {
  const cors = cockpitCorsHeaders(request);
  return new NextResponse(null, { status: 204, headers: cors });
}

export async function GET(request: Request) {
  const cockpitCtx = tryCockpitAccessAuth(request);
  if (cockpitCtx) {
    return runWithContext(cockpitCtx, () => serveCases(request));
  }

  const embed = await tryCockpitEmbedAuth(request);
  if (embed.kind === "ok") {
    return runWithContext(embed.context, () => serveCases(request));
  }
  if (embed.kind === "rejected") {
    return jsonWithCors(
      request,
      { message: "Token do cockpit inválido ou expirado.", reason: embed.reason },
      { status: 401 },
    );
  }

  return withApiAuthContext(request, async () => serveCases(request));
}
