import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  createCompany,
  getCompanies,
  type CompanySegment,
  type CompanySortField,
} from "@/services/companies";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/companies");

const SORT_FIELDS = new Set<CompanySortField>(["name", "createdAt", "updatedAt"]);

const SEGMENTS = new Set<CompanySegment>([
  "todos",
  "com-contatos",
  "sem-email",
  "sem-telefone",
]);

function parseIntParam(v: string | null, fallback: number) {
  if (v === null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") ?? undefined;
    const page = parseIntParam(searchParams.get("page"), 1);
    const perPage = parseIntParam(searchParams.get("perPage"), 20);
    const segmentRaw = searchParams.get("segment") ?? undefined;
    const segment =
      segmentRaw && SEGMENTS.has(segmentRaw as CompanySegment)
        ? (segmentRaw as CompanySegment)
        : undefined;

    const city = searchParams.get("city") ?? undefined;
    const state = searchParams.get("state") ?? undefined;
    const industry = searchParams.get("industry") ?? undefined;
    const createdFrom = searchParams.get("createdFrom") ?? undefined;
    const createdTo = searchParams.get("createdTo") ?? undefined;
    const sortByRaw = searchParams.get("sortBy") ?? undefined;
    const sortBy =
      sortByRaw && SORT_FIELDS.has(sortByRaw as CompanySortField)
        ? (sortByRaw as CompanySortField)
        : undefined;
    const sortOrder = searchParams.get("sortOrder") === "desc" ? "desc" : "asc";

    const result = await getCompanies({
      search,
      page,
      perPage,
      segment,
      city,
      state,
      industry,
      createdFrom,
      createdTo,
      sortBy,
      sortOrder,
    });
    return NextResponse.json(result);
    });
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao listar empresas." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
    }

    const b = body as Record<string, unknown>;

    if (typeof b.name !== "string" || b.name.trim().length < 1) {
      return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
    }

    const company = await createCompany({
      name: b.name.trim(),
      domain: b.domain === null ? null : typeof b.domain === "string" ? b.domain.trim() : undefined,
      industry:
        b.industry === null ? null : typeof b.industry === "string" ? b.industry.trim() : undefined,
      size: b.size === null ? null : typeof b.size === "string" ? b.size.trim() : undefined,
      phone: b.phone === null ? null : typeof b.phone === "string" ? b.phone.trim() : undefined,
      address:
        b.address === null ? null : typeof b.address === "string" ? b.address.trim() : undefined,
      cep: b.cep === null ? null : typeof b.cep === "string" ? b.cep.trim() : undefined,
      city: b.city === null ? null : typeof b.city === "string" ? b.city.trim() : undefined,
      state: b.state === null ? null : typeof b.state === "string" ? b.state.trim() : undefined,
      notes: b.notes === null ? null : typeof b.notes === "string" ? b.notes.trim() : undefined,
    });

    return NextResponse.json(company, { status: 201 });
    });
  } catch (e) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao criar empresa." }, { status: 500 });
  }
}
