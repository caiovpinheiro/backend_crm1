import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { isCourseLevel, isProductKind, listMessageVariables } from "@/services/product-messages";

export async function GET(request: Request) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  return runWithApiUserContext(auth.user, async () => {
    const denied = await requirePermissionForUser(auth.user, "product:view");
    if (denied) return denied;

    const url = new URL(request.url);
    const kind = url.searchParams.get("kind")?.trim() ?? "PHYSICAL";
    if (!isProductKind(kind)) {
      return NextResponse.json({ message: "Tipo de produto inválido." }, { status: 400 });
    }
    const levelRaw = url.searchParams.get("level")?.trim() ?? "";
    const courseLevel = kind === "COURSE" && isCourseLevel(levelRaw) ? levelRaw : null;
    const variables = await listMessageVariables({ kind, courseLevel });
    return NextResponse.json({ variables });
  });
}
