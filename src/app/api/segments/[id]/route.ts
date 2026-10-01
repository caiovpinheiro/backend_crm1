import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getSegmentById, updateSegment, deleteSegment } from "@/services/segments";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/segments/[id]");

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await params;
    const segment = await getSegmentById(id);
    if (!segment) {
      return NextResponse.json({ message: "Segmento não encontrado." }, { status: 404 });
    }
    return NextResponse.json({ segment });
  } catch (e: unknown) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao buscar segmento." },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const data: { name?: string; filters?: never } = {};
    if (typeof body.name === "string") data.name = body.name.trim();
    if (body.filters && typeof body.filters === "object") data.filters = body.filters as never;

    const segment = await updateSegment(id, data);
    return NextResponse.json({ segment });
  } catch (e: unknown) {
    log.error({ err: e }, "PUT falhou");
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao atualizar segmento." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await params;
    await deleteSegment(id);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    log.error({ err: e }, "DELETE falhou");
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao excluir segmento." },
      { status: 500 },
    );
  }
}
