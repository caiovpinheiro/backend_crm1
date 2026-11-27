import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { getLogger } from "@/lib/logger";
import {
  desdeValido,
  getPainelPortalAluno,
  PORTAL_MAX_AUTOMACOES,
  PORTAL_MAX_PASSOS_ALCANCE,
  PORTAL_MAX_PASSOS_COORTE,
} from "@/services/painel-portal-aluno";

const log = getLogger("api/painel/portal-aluno");

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function lista(raw: string | null, max: number): string[] {
  const itens = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s));
  return [...new Set(itens)].slice(0, max);
}

/**
 * GET /api/painel/portal-aluno?automacoes=a,b&desde=AAAA-MM-DD&alcance=passo1,passo2&coorte=passo3,passo4
 *
 * Só leitura, para a aba "Ao vivo" do portal do aluno. Aceita token de API de usuário
 * ADMIN ou MANAGER (e a sessão, para conferência). Devolve só agregados: ver o serviço.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateApiRequest(request);
    if (!auth.ok) return auth.response;
    const { user, viaToken } = auth;

    if (!user.organizationId) {
      return NextResponse.json({ message: "Sem organização no contexto." }, { status: 403 });
    }
    if (user.role !== "ADMIN" && user.role !== "MANAGER") {
      return NextResponse.json(
        { message: "Acesso restrito a administradores e gestores." },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(request.url);
    const automacoes = lista(searchParams.get("automacoes"), PORTAL_MAX_AUTOMACOES);
    const desde = desdeValido(searchParams.get("desde"));
    if (!automacoes.length || !desde) {
      return NextResponse.json(
        { message: "Informe automacoes e desde (AAAA-MM-DD)." },
        { status: 400 },
      );
    }

    // A chave do alcance é o próprio token: só quem o tem compara com os telefones dele.
    const header = request.headers.get("authorization") ?? "";
    const chaveAlcance = viaToken ? header.replace(/^Bearer\s+/i, "").trim() : null;
    const organizationId = user.organizationId;

    return await runWithApiUserContext(user, async () => {
      const denied = await requirePermissionForUser(user, "automation:view");
      if (denied) return denied;
      const data = await getPainelPortalAluno({
        organizationId,
        automacoes,
        passosAlcance: lista(searchParams.get("alcance"), PORTAL_MAX_PASSOS_ALCANCE),
        passosCoorte: lista(searchParams.get("coorte"), PORTAL_MAX_PASSOS_COORTE),
        desde,
        chaveAlcance,
      });
      return NextResponse.json(data, { headers: { "Cache-Control": "no-store, max-age=0" } });
    });
  } catch (e) {
    log.error({ err: e }, "[api/painel/portal-aluno] falhou");
    return NextResponse.json({ message: "Erro ao carregar os números do portal." }, { status: 500 });
  }
}
