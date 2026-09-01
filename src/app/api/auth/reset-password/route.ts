import { NextResponse } from "next/server";

import { getClientIp, withRateLimit } from "@/lib/rate-limit";
import { consumePasswordReset } from "@/services/password-reset";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rl = await withRateLimit({
    route: "auth.reset-password",
    profile: "auth.public",
    scope: "ip",
    id: getClientIp(request),
  });
  if (!rl.ok) return rl.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { message: "JSON inválido." },
      { status: 400, headers: rl.headers },
    );
  }
  const b = body as Record<string, unknown>;
  const token = typeof b.token === "string" ? b.token : "";
  const password = typeof b.password === "string" ? b.password : "";

  try {
    await consumePasswordReset({ token, password });
    return NextResponse.json(
      { ok: true },
      { status: 200, headers: rl.headers },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Não foi possível redefinir a senha.";
    return NextResponse.json(
      { message: msg },
      { status: 400, headers: rl.headers },
    );
  }
}
