import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getContactTimeline } from "@/services/contacts";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/contacts/[id]/timeline");

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await context.params;
    const timeline = await getContactTimeline(id);
    return NextResponse.json(timeline);
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao carregar timeline." }, { status: 500 });
  }
}
