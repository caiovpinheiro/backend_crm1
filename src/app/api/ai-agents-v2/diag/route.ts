import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-helpers";
import { getV2Agent } from "@/services/ai-v2/agents";

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const orgId = r.session.user.organizationId!;
  const id = "cmubdny9j0003zld46o065ees";
  const agent = await getV2Agent(id, orgId);
  return NextResponse.json({ orgId, id, found: Boolean(agent), agent });
}
