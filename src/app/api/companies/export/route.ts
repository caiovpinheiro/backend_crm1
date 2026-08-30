import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { csvDate, toCsv } from "@/lib/csv-stringify";
import { prisma } from "@/lib/prisma";

const MAX_ROWS = 100_000;

/**
 * GET /api/companies/export
 * CSV com as empresas da organização.
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
      const denied = await requirePermissionForUser(
        authResult.user,
        "company:view",
      );
      if (denied) return denied;

      const companies = await prisma.company.findMany({
        take: MAX_ROWS,
        orderBy: [{ name: "asc" }],
        include: { _count: { select: { contacts: true } } },
      });

      const headers = [
        "Número",
        "Nome",
        "Domínio",
        "Setor",
        "Porte",
        "Telefone",
        "Endereço",
        "CEP",
        "Cidade",
        "Estado",
        "Notas",
        "Contatos",
        "Criado em",
        "Atualizado em",
      ];

      const rows = companies.map((c) => ({
        Número: c.number,
        Nome: c.name,
        Domínio: c.domain ?? "",
        Setor: c.industry ?? "",
        Porte: c.size ?? "",
        Telefone: (c.phone ?? "").replace(/^\+/, ""),
        Endereço: c.address ?? "",
        CEP: c.cep ?? "",
        Cidade: c.city ?? "",
        Estado: c.state ?? "",
        Notas: c.notes ?? "",
        Contatos: c._count.contacts,
        "Criado em": csvDate(c.createdAt),
        "Atualizado em": csvDate(c.updatedAt),
      }));

      const csv = toCsv(headers, rows);
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `empresas-${stamp}.csv`;

      return new NextResponse("\ufeff" + csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Export-Total": String(rows.length),
          "Access-Control-Expose-Headers":
            "Content-Disposition, X-Export-Total",
        },
      });
    });
  } catch (e) {
    console.error("[companies/export]", e);
    return NextResponse.json(
      { message: "Erro ao exportar empresas." },
      { status: 500 },
    );
  }
}
