/**
 * Resposta JSON com `Server-Timing` (fases medidas por `ServerTiming`).
 *
 * `NextResponse.json` serializa por dentro e some com o custo da
 * serialização; aqui o `JSON.stringify` é medido como a fase `serialize` e
 * só então o cabeçalho é montado (o `total` já inclui a serialização).
 * Corpo, status e `Content-Type` ficam idênticos aos de `NextResponse.json`.
 */
import { NextResponse } from "next/server";

import type { ServerTiming } from "@/lib/server-timing";

export function timedJson(
  timing: ServerTiming,
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse {
  const body = timing.timeSync("serialize", () => JSON.stringify(data));
  const res = new NextResponse(body, {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  res.headers.set("Server-Timing", timing.header());
  return res;
}
