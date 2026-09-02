import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { denyUnless } from "../_guard";
import { listAssignableUsers } from "@/services/demands";

export async function GET() {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:view");
    if (denied) return denied;
    const users = await listAssignableUsers();
    return NextResponse.json({ users });
  });
}
