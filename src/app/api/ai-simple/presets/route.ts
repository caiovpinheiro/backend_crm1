/**
 * GET /api/ai-simple/presets
 *
 * Retorna os presets de configuração do motor v2 simples.
 */

import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { withOrgContext } from "@/lib/auth-helpers";
import { simplePresets } from "@/lib/ai-simple/presets";

export async function GET() {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  const denied = await requirePermission(auth.session.user, "ai_agent:view");
  if (denied) return denied;

  return withOrgContext(async () => {
    return NextResponse.json({ presets: simplePresets });
  });
}
