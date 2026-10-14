import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import { auth } from "@/lib/auth";
import { respondWithCachedJson } from "@/lib/cache/response-cache";
import { createQuickReply, getQuickReplies, reorderQuickReplies } from "@/services/quick-replies";
import { quickRepliesSpec } from "@/services/startup-cache";

// Auth hibrida (Bearer OU sessao) no GET: alimenta o dropdown de resposta
// rapida do node do n8n. Alem de liberar o token, `withApiAuthContext`
// corrige um bug latente do `auth()` cru — sem RequestContext ativo a
// Prisma Extension nao tinha organizationId para escopar `getQuickReplies`.
export async function GET(request: Request) {
  return withApiAuthContext(request, async (user) => {
    try {
      // Cache por org + ETag/304 (`services/startup-cache.ts`).
      const spec = quickRepliesSpec(user);
      if (spec) return await respondWithCachedJson(request, spec);
      const replies = await getQuickReplies();
      return NextResponse.json(replies);
    } catch (e) {
      return NextResponse.json({ message: e instanceof Error ? e.message : "Erro." }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    const body = (await request.json()) as Record<string, unknown>;

    if (Array.isArray(body.orderedIds)) {
      const ids = body.orderedIds.filter((v): v is string => typeof v === "string");
      await reorderQuickReplies(ids);
      return NextResponse.json({ ok: true });
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!title || !content) {
      return NextResponse.json({ message: "title e content são obrigatórios." }, { status: 400 });
    }
    const reply = await createQuickReply({
      title,
      content,
      category: typeof body.category === "string" ? body.category.trim() || undefined : undefined,
    });
    return NextResponse.json(reply, { status: 201 });
  } catch (e) {
    return NextResponse.json({ message: e instanceof Error ? e.message : "Erro." }, { status: 500 });
  }
}
