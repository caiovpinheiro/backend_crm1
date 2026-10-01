import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getSegments, createSegment } from "@/services/segments";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/segments");

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const segments = await getSegments();
    return NextResponse.json({ segments });
  } catch (e: unknown) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao listar segmentos." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
    }

    const filters = body.filters && typeof body.filters === "object" ? body.filters : {};
    const segment = await createSegment(name, filters as never);
    return NextResponse.json({ segment }, { status: 201 });
  } catch (e: unknown) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao criar segmento." },
      { status: 500 },
    );
  }
}
