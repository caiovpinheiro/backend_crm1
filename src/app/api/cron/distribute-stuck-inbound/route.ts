/**
 * GET  /api/cron/distribute-stuck-inbound          dry-run (só lista)
 * POST /api/cron/distribute-stuck-inbound?apply=1  enfileira no worker
 *
 * Destrava aluno preso na IA: conversa OPEN, responsável do tipo AI, sem
 * resposta humana e sem nenhuma outbound depois do último inbound. NÃO
 * envia mensagem ao aluno — só reatribui / enfileira na Distribuição.
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` ou `?secret=`.
 *
 * POST aplica via `distribution-execute` / `stuck-inbound` (mesmo jobId
 * do tick de inatividade — não roda o SQL duas vezes).
 */

import { NextResponse } from "next/server";

import {
  allowInlineDistributionFallback,
} from "@/lib/distribution-drain-queue";
import {
  enqueueDistributionStuckInbound,
  stuckInboundEnqueueOpts,
} from "@/lib/distribution-execute-queue";
import { metrics } from "@/lib/metrics";
import {
  STUCK_INBOUND_MS,
  distributeStuckInbound,
  type StuckInboundOptions,
} from "@/services/ai/stuck-inbound-distribution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorize(request: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json(
      { ok: false, message: "CRON_SECRET nao configurado." },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const headerSecret = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const provided = headerSecret || (url.searchParams.get("secret")?.trim() ?? "");
  if (!provided || provided !== expected) {
    return NextResponse.json(
      { ok: false, message: "Cron secret invalido." },
      { status: 401 },
    );
  }
  return null;
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseOpts(
  request: Request,
  applyDefault: boolean,
): StuckInboundOptions {
  const url = new URL(request.url);
  const stuckMs = intParam(
    url,
    "stuckMs",
    intParam(url, "minMinutes", STUCK_INBOUND_MS / 60_000) * 60_000,
  );
  const apply =
    applyDefault ||
    url.searchParams.get("apply") === "1" ||
    url.searchParams.get("apply") === "true";
  return {
    apply,
    stuckMs,
    sinceMs: intParam(url, "sinceMinutes", 0) * 60_000,
    limit: intParam(url, "limit", 50),
    organizationId: url.searchParams.get("org")?.trim() || null,
  };
}

async function enqueueApply(opts: StuckInboundOptions) {
  const queued = await enqueueDistributionStuckInbound(
    stuckInboundEnqueueOpts(opts),
  );
  if (queued) {
    return NextResponse.json(
      { ok: true, queued: true, jobId: "dsi-stuck-inbound" },
      { status: 202 },
    );
  }

  if (allowInlineDistributionFallback()) {
    const result = await distributeStuckInbound(opts);
    return NextResponse.json({ ok: true, ...result });
  }

  metrics.errors.inc({
    scope: "distribution.stuck-inbound",
    kind: "queue_unavailable",
  });
  console.warn(
    "[cron/distribute-stuck-inbound] fila indisponível — skip sync fallback",
  );
  return NextResponse.json(
    { ok: false, message: "Fila de distribuição indisponível." },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const opts = parseOpts(request, false);
    if (opts.apply) return enqueueApply(opts);
    const result = await distributeStuckInbound(opts);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/distribute-stuck-inbound]", e);
    return NextResponse.json(
      {
        ok: false,
        message: e instanceof Error ? e.message : "Erro na distribuicao.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const opts = parseOpts(request, true);
    if (!opts.apply) {
      const result = await distributeStuckInbound(opts);
      return NextResponse.json({ ok: true, ...result });
    }
    return enqueueApply(opts);
  } catch (e) {
    console.error("[cron/distribute-stuck-inbound]", e);
    return NextResponse.json(
      {
        ok: false,
        message: e instanceof Error ? e.message : "Erro na distribuicao.",
      },
      { status: 500 },
    );
  }
}
