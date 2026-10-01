/**
 * GET  /api/cron/halt-inbound-burst              dry-run
 * POST /api/cron/halt-inbound-burst?apply=1      encerra tickets do burst
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` (`?secret=` ainda aceito, DEPRECADO — ver `requireCronSecret`).
 *
 * No container de prod:
 *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3000/api/cron/halt-inbound-burst?hours=6"
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3000/api/cron/halt-inbound-burst?hours=6&apply=1"
 */

import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth/cron-secret";

import {
  DEFAULT_BURST_PHONE_NUMBER_ID,
  haltInboundBurst,
} from "@/services/ai/halt-inbound-burst";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/cron/halt-inbound-burst");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorize(request: Request): NextResponse | null {
  return requireCronSecret(request);
}

function parseOpts(request: Request, applyDefault: boolean) {
  const url = new URL(request.url);
  const hours = Number.parseInt(url.searchParams.get("hours") ?? "6", 10);
  const apply =
    applyDefault ||
    url.searchParams.get("apply") === "1" ||
    url.searchParams.get("apply") === "true";
  const phoneNumberId =
    url.searchParams.get("phoneNumberId")?.trim() || DEFAULT_BURST_PHONE_NUMBER_ID;
  const organizationId = url.searchParams.get("org")?.trim() || null;
  const requireHandoffPreview = url.searchParams.get("allOpen") !== "1";
  return { apply, hours, phoneNumberId, organizationId, requireHandoffPreview };
}

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await haltInboundBurst(parseOpts(request, false));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    log.error({ err: e }, "[cron/halt-inbound-burst] falhou");
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro no halt." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await haltInboundBurst(parseOpts(request, true));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    log.error({ err: e }, "[cron/halt-inbound-burst] falhou");
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro no halt." },
      { status: 500 },
    );
  }
}
