import { NextResponse } from "next/server";

import { getClientIp, withRateLimit } from "@/lib/rate-limit";
import { slugFromRequestHost } from "@/lib/tenant-url";
import { confirmEmailVerification } from "@/services/email-verification";

export const runtime = "nodejs";

function hostOf(request: Request): string | null {
  const xf = request.headers.get("x-forwarded-host");
  if (xf) return xf.split(",")[0]?.trim() ?? null;
  return request.headers.get("host");
}

export async function POST(request: Request) {
  const rl = await withRateLimit({
    route: "auth.verify-email",
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
  const email = String(b.email ?? "").trim().toLowerCase();
  const code = String(b.code ?? "").trim();
  const fromBody = String(b.organizationSlug ?? "").trim().toLowerCase();
  const organizationSlug = fromBody || slugFromRequestHost(hostOf(request));

  try {
    const res = await confirmEmailVerification({ email, code, organizationSlug });
    return NextResponse.json(res, { headers: rl.headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Código inválido.";
    return NextResponse.json(
      { message: msg },
      { status: 400, headers: rl.headers },
    );
  }
}
