import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import { withOrgContext } from "@/lib/auth-helpers";
import { resolveMetaTemplatesClient } from "@/lib/meta-whatsapp/resolve-templates-client";
import {
  deleteFlowDefinitionDraft,
  getFlowDefinitionById,
  replaceFlowDefinitionDraft,
  setFlowDefinitionHidden,
  updatePublishedFlowMappings,
  type FlowDefinitionUpsertInput,
} from "@/services/whatsapp-flow-definitions";

function requireAdminOrManager(session: { user?: { role?: string } }): NextResponse | null {
  const r = session.user?.role;
  if (r !== "ADMIN" && r !== "MANAGER") {
    return NextResponse.json({ message: "Apenas administrador ou gestor." }, { status: 403 });
  }
  return null;
}

type RouteContext = { params: Promise<{ id: string }> };

// Auth hibrida (Bearer OU sessao) no GET: o node do n8n le as telas/campos do
// flow para o operador montar o `flow_action_data` por selecao, em vez de
// digitar as chaves na mao. Escrita (PUT/DELETE) continua so por sessao.
export async function GET(request: Request, context: RouteContext) {
  return withApiAuthContext(request, async (user) => {
    const denied = requireAdminOrManager({ user: { role: user.role } });
    if (denied) return denied;
    const { id } = await context.params;
    if (!id) return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    const row = await getFlowDefinitionById(id);
    if (!row) return NextResponse.json({ message: "Não encontrado." }, { status: 404 });
    return NextResponse.json(row);
  });
}

export async function PUT(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = requireAdminOrManager(session);
    if (denied) return denied;
    const { id } = await context.params;
    if (!id) return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    try {
      const body = (await request.json()) as FlowDefinitionUpsertInput;
      const existing = await getFlowDefinitionById(id);
      if (!existing) return NextResponse.json({ message: "Não encontrado." }, { status: 404 });
      // Usa o CUID real para as funções internas (param pode ser shortId)
      const cuid = existing.id;
      if (existing.status === "PUBLISHED" || existing.metaFlowId?.trim()) {
        await updatePublishedFlowMappings(cuid, body);
      } else if (existing.status === "DRAFT") {
        await replaceFlowDefinitionDraft(cuid, body);
      } else {
        return NextResponse.json(
          { message: "Flow arquivado não pode ser editado." },
          { status: 400 },
        );
      }
      const row = await getFlowDefinitionById(cuid);
      return NextResponse.json(row);
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 400 },
      );
    }
  });
}

/** PATCH { hidden: boolean } — tira ou devolve o flow na seleção. A lista da aba Flows não muda. */
export async function PATCH(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = requireAdminOrManager(session);
    if (denied) return denied;
    const { id } = await context.params;
    if (!id) return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    const body = (await request.json().catch(() => null)) as { hidden?: unknown } | null;
    if (!body || typeof body.hidden !== "boolean") {
      return NextResponse.json({ message: "Campo hidden (boolean) obrigatório." }, { status: 400 });
    }
    const existing = await getFlowDefinitionById(id);
    if (!existing) return NextResponse.json({ message: "Não encontrado." }, { status: 404 });
    try {
      await setFlowDefinitionHidden(existing.id, body.hidden);
      return NextResponse.json({ id: existing.id, hidden: body.hidden });
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 400 },
      );
    }
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = requireAdminOrManager(session);
    if (denied) return denied;
    const { id } = await context.params;
    if (!id) return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    const resolved = await resolveMetaTemplatesClient({
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!resolved.ok) return resolved.response;
    try {
      // Resolve shortId → CUID antes de deletar
      const existing = await getFlowDefinitionById(id);
      if (!existing) return NextResponse.json({ message: "Não encontrado." }, { status: 404 });
      await deleteFlowDefinitionDraft(existing.id, resolved.client);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 400 },
      );
    }
  });
}
