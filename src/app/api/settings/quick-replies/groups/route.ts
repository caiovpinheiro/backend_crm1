import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { withOrgContext } from "@/lib/auth-helpers";
import { bumpResponseFamilies, RESPONSE_FAMILIES, respondWithCachedJson } from "@/lib/cache/response-cache";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";
import { ServerTiming } from "@/lib/server-timing";
import { loadQuickReplyGroups, quickReplyGroupsSpec } from "@/services/startup-cache";

const log = getLogger("api/settings/quick-replies/groups");

// GET passou de `auth()` cru para `withOrgContext` (requireAuth): o 304 só
// sai depois da autenticação completa (versão da sessão, rate limit).
export async function GET(request: Request) {
  const timing = new ServerTiming();
  return withOrgContext(async (session) => {
    timing.add("auth", timing.totalMs());
    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    try {
      // Cache por org + ETag/304 (`services/startup-cache.ts`).
      const spec = quickReplyGroupsSpec(session.user);
      if (spec) return await respondWithCachedJson(request, spec, timing);
      return NextResponse.json(await loadQuickReplyGroups(orgId));
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json({ message: "Erro ao listar grupos." }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    const user = session?.user as { id?: string; organizationId?: string | null } | undefined;
    if (!user?.id || !user.organizationId) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });

    const count = await prisma.quickReplyGroup.count({
      where: { organizationId: user.organizationId },
    });

    const group = await prisma.quickReplyGroup.create({
      data: { name, order: count, organizationId: user.organizationId },
      include: { _count: { select: { quickReplies: true } } },
    });
    await bumpResponseFamilies(user.organizationId, RESPONSE_FAMILIES.quickReplies);
    return NextResponse.json(group, { status: 201 });
  } catch (e) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao criar grupo." }, { status: 500 });
  }
}
