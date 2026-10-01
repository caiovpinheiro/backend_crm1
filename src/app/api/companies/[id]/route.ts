import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import type { UpdateCompanyInput } from "@/services/companies";
import {
  deleteCompany,
  getCompanyById,
  updateCompany,
} from "@/services/companies";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/companies/[id]");

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const company = await getCompanyById(id);
    if (!company) {
      return NextResponse.json({ message: "Empresa não encontrada." }, { status: 404 });
    }

    return NextResponse.json(company);
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao buscar empresa." }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

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

    if (b.name !== undefined && (typeof b.name !== "string" || b.name.trim().length < 1)) {
      return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
    }

    const existing = await getCompanyById(id);
    if (!existing) {
      return NextResponse.json({ message: "Empresa não encontrada." }, { status: 404 });
    }

    const data: UpdateCompanyInput = {};

    if (b.name !== undefined) data.name = typeof b.name === "string" ? b.name.trim() : "";
    if (b.domain !== undefined) {
      data.domain = b.domain === null ? null : typeof b.domain === "string" ? b.domain.trim() : undefined;
    }
    if (b.industry !== undefined) {
      data.industry =
        b.industry === null ? null : typeof b.industry === "string" ? b.industry.trim() : undefined;
    }
    if (b.size !== undefined) {
      data.size = b.size === null ? null : typeof b.size === "string" ? b.size.trim() : undefined;
    }
    if (b.phone !== undefined) {
      data.phone = b.phone === null ? null : typeof b.phone === "string" ? b.phone.trim() : undefined;
    }
    if (b.address !== undefined) {
      data.address =
        b.address === null ? null : typeof b.address === "string" ? b.address.trim() : undefined;
    }
    if (b.cep !== undefined) {
      data.cep = b.cep === null ? null : typeof b.cep === "string" ? b.cep.trim() : undefined;
    }
    if (b.city !== undefined) {
      data.city = b.city === null ? null : typeof b.city === "string" ? b.city.trim() : undefined;
    }
    if (b.state !== undefined) {
      data.state = b.state === null ? null : typeof b.state === "string" ? b.state.trim() : undefined;
    }
    if (b.notes !== undefined) {
      data.notes = b.notes === null ? null : typeof b.notes === "string" ? b.notes.trim() : undefined;
    }

    const payload = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined)
    ) as UpdateCompanyInput;

    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    const company = await updateCompany(id, payload);
    return NextResponse.json(company);
  } catch (e: unknown) {
    log.error({ err: e }, "PUT falhou");
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025") {
      return NextResponse.json({ message: "Empresa não encontrada." }, { status: 404 });
    }
    return NextResponse.json({ message: "Erro ao atualizar empresa." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const existing = await getCompanyById(id);
    if (!existing) {
      return NextResponse.json({ message: "Empresa não encontrada." }, { status: 404 });
    }

    await deleteCompany(id);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    log.error({ err: e }, "DELETE falhou");
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025") {
      return NextResponse.json({ message: "Empresa não encontrada." }, { status: 404 });
    }
    return NextResponse.json({ message: "Erro ao excluir empresa." }, { status: 500 });
  }
}
