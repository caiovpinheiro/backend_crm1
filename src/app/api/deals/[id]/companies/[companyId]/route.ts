/**
 * /api/deals/[id]/companies/[companyId]
 *
 * PATCH  → `{ isPrimary: true }` torna a empresa a principal do negócio.
 * DELETE → desvincula (se era a principal, a mais antiga que sobrar assume).
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { createDealEvent, getDealById } from "@/services/deals";
import {
  DealCompanyError,
  listDealCompanies,
  setPrimaryDealCompany,
  unlinkDealCompany,
} from "@/services/deal-companies";

type Ctx = { params: Promise<{ id: string; companyId: string }> };

function errorResponse(err: DealCompanyError) {
  return NextResponse.json({ message: err.message, code: err.code }, { status: 404 });
}

export async function PATCH(req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id, companyId } = await ctx.params;
    const deal = await getDealById(id);
    if (!deal) return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    let body: { isPrimary?: unknown };
    try {
      body = (await req.json()) as { isPrimary?: unknown };
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    if (body.isPrimary !== true) {
      return NextResponse.json({ message: "Use { isPrimary: true } para escolher a principal." }, { status: 400 });
    }
    try {
      const r = await setPrimaryDealCompany(id, companyId);
      createDealEvent(id, session.user.id, "COMPANY_PRIMARY", { companyId, companyName: r.companyName }).catch(() => {});
    } catch (err) {
      if (err instanceof DealCompanyError) return errorResponse(err);
      throw err;
    }
    return NextResponse.json({ items: await listDealCompanies(id) });
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id, companyId } = await ctx.params;
    const deal = await getDealById(id);
    if (!deal) return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    try {
      const r = await unlinkDealCompany(id, companyId);
      createDealEvent(id, session.user.id, "COMPANY_UNLINKED", { companyId, companyName: r.companyName }).catch(() => {});
    } catch (err) {
      if (err instanceof DealCompanyError) return errorResponse(err);
      throw err;
    }
    return NextResponse.json({ items: await listDealCompanies(id) });
  });
}
