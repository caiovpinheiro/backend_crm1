import { NextResponse } from "next/server";

import { getClientIp, withRateLimit } from "@/lib/rate-limit";
import { slugFromRequestHost } from "@/lib/tenant-url";
import { resendEmailVerification } from "@/services/email-verification";

export const runtime = "nodejs";

function hostOf(request: Request): string | null {
  const xf = request.headers.get("x-forwarded-host");
  if (xf) return xf.split(",")[0]?.trim() ?? null;
  return request.headers.get("host");
}

export async function POST(request: Request) {
  const rl = await withRateLimit({
    route: "auth.resend-verification",
    profile: "auth.public",
    scope: "ip",
    id: getClientIp(request),
  });
  if (!rl.ok) return rl.response;

  let email = "";
  let organizationSlug: string | null = null;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    email = String(body.email ?? "").trim().toLowerCase();
    const fromBody = String(body.organizationSlug ?? "").trim().toLowerCase();
    organizationSlug = fromBody || slugFromRequestHost(hostOf(request));
  } catch {
    email = "";
  }

  await resendEmailVerification({ email, organizationSlug });
  return NextResponse.json(
    {
      ok: true,
      message: "Se a conta existir e ainda não estiver confirmada, enviamos um novo código.",
    },
    { headers: rl.headers },
  );
}
