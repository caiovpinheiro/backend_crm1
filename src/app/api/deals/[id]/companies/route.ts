/**
 * /api/deals/[id]/companies — empresas vinculadas ao negócio.
 *
 * GET  → lista (principal primeiro) com os dados da empresa.
 * POST → vincula `{ companyId, primary? }`. A primeira vira principal.
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { createDealEvent, getDealById } from "@/services/deals";
import { DealCompanyError, linkDealCompany, listDealCompanies } from "@/services/deal-companies";

type Ctx = { params: Promise<{ id: string }> };

function dealCompanyErrorResponse(err: DealCompanyError) {
  const status = err.code === "EMPRESA_JA_VINCULADA" ? 409 : 404;
  return NextResponse.json({ message: err.message, code: err.code }, { status });
}

export async function GET(_req: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    const { id } = await ctx.params;
    const deal = await getDealById(id);
    if (!deal) return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    return NextResponse.json({ items: await listDealCompanies(id) });
  });
}

export async function POST(req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id } = await ctx.params;
    const deal = await getDealById(id);
    if (!deal) return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });

    let body: { companyId?: unknown; primary?: unknown };
    try {
      body = (await req.json()) as { companyId?: unknown; primary?: unknown };
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
    if (!companyId) return NextResponse.json({ message: "Informe a empresa." }, { status: 400 });

    try {
      const r = await linkDealCompany(id, companyId, { primary: body.primary === true });
      createDealEvent(id, session.user.id, "COMPANY_LINKED", {
        companyId,
        companyName: r.companyName,
        isPrimary: r.isPrimary,
      }).catch(() => {});
    } catch (err) {
      if (err instanceof DealCompanyError) return dealCompanyErrorResponse(err);
      throw err;
    }
    return NextResponse.json({ items: await listDealCompanies(id) }, { status: 201 });
  });
}
