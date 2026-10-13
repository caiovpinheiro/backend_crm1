import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  bumpResponseFamilies,
  RESPONSE_FAMILIES,
  respondWithCachedJson,
} from "@/lib/cache/response-cache";
import type { SectionConfig } from "@/lib/field-layout";
import { prisma } from "@/lib/prisma";
import {
  fieldLayoutSpec,
  isMissingFieldLayoutTable,
  loadFieldLayout,
} from "@/services/startup-cache";

export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;
  return runWithApiUserContext(authResult.user, async () => {
    const { searchParams } = new URL(request.url);
    const context = searchParams.get("context");
    const forUser = searchParams.get("forUser") === "true";
    const user = authResult.user as { id: string; organizationId: string };
    if (!context) return NextResponse.json({ admin: null, agent: null });

    // Cache por org + contexto (+ usuário com `forUser`), com ETag/304.
    const spec = fieldLayoutSpec(authResult.user, context, forUser);
    if (spec) return respondWithCachedJson(request, spec);
    return NextResponse.json(
      await loadFieldLayout(user.organizationId, user.id, context, forUser),
    );
  });
}

export async function PUT(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;
  return runWithApiUserContext(authResult.user, async () => {
    const user = authResult.user as { id: string; role: string; organizationId: string };
    const body = (await request.json()) as {
      context: string;
      sections: SectionConfig[];
      scope: "admin" | "agent";
    };
    const { context, sections, scope } = body;

    if (scope === "admin" && user.role !== "ADMIN" && user.role !== "MANAGER") {
      return NextResponse.json({ message: "Sem permissão" }, { status: 403 });
    }

    try {
      if (scope === "agent" && sections.length === 0) {
        await prisma.fieldLayoutConfig.deleteMany({
          where: { organizationId: user.organizationId, context, userId: user.id },
        });
        await bumpResponseFamilies(user.organizationId, RESPONSE_FAMILIES.fieldLayout);
        return NextResponse.json({ ok: true });
      }

      const userId = scope === "admin" ? null : user.id;
      const existing = await prisma.fieldLayoutConfig.findFirst({
        where: { organizationId: user.organizationId, context, userId },
        select: { id: true },
      });

      if (existing) {
        await prisma.fieldLayoutConfig.update({
          where: { id: existing.id },
          data: { sections: sections as object },
        });
      } else {
        await prisma.fieldLayoutConfig.create({
          data: {
            organizationId: user.organizationId,
            userId,
            context,
            sections: sections as object,
          },
        });
      }

      await bumpResponseFamilies(user.organizationId, RESPONSE_FAMILIES.fieldLayout);
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (isMissingFieldLayoutTable(error)) {
        return NextResponse.json(
          { ok: false, message: "Layout indisponível até aplicar migration." },
          { status: 503 },
        );
      }
      throw error;
    }
  });
}
