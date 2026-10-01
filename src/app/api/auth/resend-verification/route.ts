import { NextResponse } from "next/server";

import { waitForMinResponseTime } from "@/lib/auth/uniform-response";
import { runInBackground } from "@/lib/background";
import { getClientIp, withRateLimit } from "@/lib/rate-limit";
import { slugFromRequestHost } from "@/lib/tenant-url";
import { resendEmailVerification } from "@/services/email-verification";

export const runtime = "nodejs";

function hostOf(request: Request): string | null {
  const xf = request.headers.get("x-forwarded-host");
  if (xf) return xf.split(",")[0]?.trim() ?? null;
  return request.headers.get("host");
}

/**
 * Mesmo desenho do forgot-password: corpo genérico e tempo uniforme. O
 * código e o e-mail saem em segundo plano; a resposta não depende de a
 * conta existir ou de estar pendente de confirmação.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
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

  runInBackground("auth.resend-verification", () =>
    resendEmailVerification({ email, organizationSlug }),
  );

  await waitForMinResponseTime(startedAt);
  return NextResponse.json(
    {
      ok: true,
      message: "Se a conta existir e ainda não estiver confirmada, enviamos um novo código.",
    },
    { headers: rl.headers },
  );
}
