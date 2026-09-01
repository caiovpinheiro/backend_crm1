import { NextResponse } from "next/server";

import { getClientIp, withRateLimit } from "@/lib/rate-limit";
import { validateInviteToken } from "@/services/invites";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rl = await withRateLimit({
    route: "/api/invites/validate",
    profile: "auth.invite",
    scope: "ip",
    id: getClientIp(request),
  });
  if (!rl.ok) return rl.response;

  const token = new URL(request.url).searchParams.get("token") ?? "";
  try {
    const data = await validateInviteToken(token);
    return NextResponse.json(data, { headers: rl.headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Convite inválido.";
    return NextResponse.json(
      { message: msg },
      { status: 400, headers: rl.headers },
    );
  }
}
