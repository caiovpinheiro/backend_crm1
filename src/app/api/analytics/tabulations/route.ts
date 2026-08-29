import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getTabulationAnalytics } from "@/services/tabulation-analytics";

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** CSV, chave repetida, ou singular (`actorUserId` / `departmentId`). */
function parseIdList(sp: URLSearchParams, ...keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    for (const raw of sp.getAll(key)) {
      for (const part of raw.split(",")) {
        const id = part.trim();
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
  }
  return out;
}

/**
 * `withOrgContext` (runWithContext) e nao `requireManager` (enterWith): o
 * servico chama `getOrgIdOrThrow()`, e o contexto ativado por enterWith nao
 * sobrevive ate lá em producao — as outras rotas de analytics ja haviam
 * migrado pelo mesmo motivo. Role checada na session, como em
 * /api/analytics/system-usage.
 */
export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json(
        { message: "Acesso restrito a administradores/gestores." },
        { status: 403 },
      );
    }

    try {
      const { searchParams } = new URL(request.url);
      const now = new Date();
      const from =
        parseDate(searchParams.get("from")) ??
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const to = parseDate(searchParams.get("to")) ?? now;
      const actorUserIds = parseIdList(searchParams, "actorUserIds", "actorUserId");
      const departmentIds = parseIdList(searchParams, "departmentIds", "departmentId");
      const tabulationId = searchParams.get("tabulationId");
      const page = Number(searchParams.get("page") ?? "1");
      const perPage = Number(searchParams.get("perPage") ?? "25");

      const data = await getTabulationAnalytics({
        from,
        to,
        actorUserIds,
        departmentIds,
        actorUserId: actorUserIds[0] ?? null,
        departmentId: departmentIds[0] ?? null,
        tabulationId: tabulationId || null,
        page: Number.isFinite(page) ? page : 1,
        perPage: Number.isFinite(perPage) ? perPage : 25,
      });
      return NextResponse.json(data);
    } catch (e) {
      console.error("[analytics/tabulations]", e);
      // Rota restrita a gestor/admin: devolve a causa junto. Sem isso, a única
      // pista fica no log do container, e o painel some sem dizer por quê.
      return NextResponse.json(
        {
          message: "Erro ao carregar analytics de tabulações.",
          detail: e instanceof Error ? e.message : String(e),
        },
        { status: 500 },
      );
    }
  });
}
