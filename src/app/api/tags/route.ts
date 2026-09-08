import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import type { AppUserRole } from "@/lib/auth-types";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";

export async function GET(request: Request) {
  return withApiAuthContext(request, async (user) => {
    try {
      const orgId = user.organizationId;
      if (!orgId) {
        return NextResponse.json({ message: "Sem organização." }, { status: 400 });
      }

      const url = new URL(request.url);
      const withCounts = url.searchParams.get("counts") === "1";

      if (withCounts) {
        // $queryRaw NAO passa pela Prisma Extension; filtragem por
        // organization_id tem que ser explicita. Usamos prismaBase pra
        // deixar claro que isso e uma query crua e nao tenta aplicar scope.
        const tags = await prismaBase.$queryRaw<
          {
            id: string;
            name: string;
            color: string;
            dealCount: number;
            contactCount: number;
          }[]
        >`
          SELECT t.id, t.name, t.color,
            COALESCE(dc.n, 0)::int AS "dealCount",
            COALESCE(cc.n, 0)::int AS "contactCount"
          FROM tags t
          LEFT JOIN (
            SELECT tod."tagId" AS tid, COUNT(*) AS n
            FROM tags_on_deals tod
            JOIN deals d ON d.id = tod."dealId"
            WHERE d."organizationId" = ${orgId}
            GROUP BY tod."tagId"
          ) dc ON dc.tid = t.id
          LEFT JOIN (
            SELECT toc."tagId" AS tid, COUNT(*) AS n
            FROM tags_on_contacts toc
            JOIN contacts c ON c.id = toc."contactId"
            WHERE c."organizationId" = ${orgId}
            GROUP BY toc."tagId"
          ) cc ON cc.tid = t.id
          WHERE t."organizationId" = ${orgId}
          ORDER BY t.name
        `;
        return NextResponse.json(tags);
      }

      const tags = await prisma.tag.findMany({ orderBy: { name: "asc" } });
      return NextResponse.json(tags);
    } catch (e) {
      console.error(e);
      return NextResponse.json({ message: "Erro ao listar tags." }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return withApiAuthContext(request, async (user) => {
    try {
      const role = user.role as AppUserRole;
      if (role !== "ADMIN" && role !== "MANAGER") {
        return NextResponse.json(
          { message: "Sem permissão para criar tags." },
          { status: 403 },
        );
      }

      const body = (await request.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!body)
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });

      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name)
        return NextResponse.json(
          { message: "Nome da tag é obrigatório." },
          { status: 400 },
        );

      const color = typeof body.color === "string" ? body.color.trim() : undefined;

      // organizationId eh injetado pela Prisma Extension (org-scope), mas
      // TypeScript exige o campo estaticamente. Passamos explicit aqui.
      const tag = await prisma.tag.create({
        data: { name, color, organizationId: user.organizationId! },
      });
      return NextResponse.json(tag, { status: 201 });
    } catch (e: unknown) {
      console.error(e);
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code: string }).code === "P2002"
      ) {
        return NextResponse.json(
          { message: "Já existe uma tag com este nome." },
          { status: 409 },
        );
      }
      return NextResponse.json({ message: "Erro ao criar tag." }, { status: 500 });
    }
  });
}
