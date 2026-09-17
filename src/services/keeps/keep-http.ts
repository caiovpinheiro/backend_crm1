import { NextResponse } from "next/server";

import { KeepError } from "@/services/keeps/keeps";

/** JSON de erro nas rotas /api/keeps — nunca HTML 500 do Next (o FE mascara como “servidor indisponível”). */
export function keepFail(err: unknown, fallback = "Erro no Bwipo Keeps.") {
  if (err instanceof KeepError) {
    return NextResponse.json({ message: err.message }, { status: err.status });
  }
  const prismaCode =
    typeof err === "object" && err && "code" in err ? String((err as { code?: string }).code) : "";
  if (prismaCode === "P2021" || prismaCode === "P2022") {
    return NextResponse.json(
      { message: "Tabelas do Bwipo Keeps ainda não existem neste banco. Rode a migration." },
      { status: 503 },
    );
  }
  const message = err instanceof Error ? err.message : fallback;
  return NextResponse.json({ message }, { status: 500 });
}
