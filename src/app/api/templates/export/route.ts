import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { csvDate, toCsv } from "@/lib/csv-stringify";
import { prisma } from "@/lib/prisma";

const MAX_ROWS = 20_000;

/**
 * GET /api/templates/export
 * CSV dos modelos internos (MessageTemplate).
 */
export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const role = (authResult.user as { role?: string }).role;
      if (role !== "ADMIN" && role !== "MANAGER") {
        return NextResponse.json(
          { message: "Apenas administradores e gerentes podem exportar dados." },
          { status: 403 },
        );
      }

      const rows = await prisma.messageTemplate.findMany({
        take: MAX_ROWS,
        orderBy: [{ name: "asc" }],
      });

      const headers = [
        "Número",
        "Nome",
        "Conteúdo",
        "Categoria",
        "Idioma",
        "Status",
        "Canal",
        "URL da mídia",
        "Tipo da mídia",
        "Nome da mídia",
        "Criado em",
        "Atualizado em",
      ];

      const csv = toCsv(
        headers,
        rows.map((t) => ({
          Número: t.number,
          Nome: t.name,
          Conteúdo: t.content,
          Categoria: t.category ?? "",
          Idioma: t.language,
          Status: t.status,
          Canal: t.channelType ?? "",
          "URL da mídia": t.mediaUrl ?? "",
          "Tipo da mídia": t.mediaType ?? "",
          "Nome da mídia": t.mediaName ?? "",
          "Criado em": csvDate(t.createdAt),
          "Atualizado em": csvDate(t.updatedAt),
        })),
      );

      const stamp = new Date().toISOString().slice(0, 10);
      return new NextResponse("\ufeff" + csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="modelos-internos-${stamp}.csv"`,
          "Cache-Control": "no-store",
          "X-Export-Total": String(rows.length),
          "Access-Control-Expose-Headers":
            "Content-Disposition, X-Export-Total",
        },
      });
    });
  } catch (e) {
    console.error("[templates/export]", e);
    return NextResponse.json(
      { message: "Erro ao exportar modelos internos." },
      { status: 500 },
    );
  }
}
