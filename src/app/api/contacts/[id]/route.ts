import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { getLogger } from "@/lib/logger";
import { parseContactPhoneInput } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { logEvent } from "@/services/activity-log";
import {
  type UpdateContactInput,
  contactExists,
  deleteContact,
  getContactById,
  updateContact,
  isValidLifecycleStage,
} from "@/services/contacts";

const log = getLogger("api.contacts.[id]");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "contact:view");
    if (denied) return denied;

    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const contact = await getContactById(id, {
      view: new URL(request.url).searchParams.get("view") === "inbox" ? "inbox" : "full",
    });
    if (!contact) {
      const exists = await contactExists(id).catch(() => false);
      if (!exists) {
        log.debug(`GET: contato ${id} não existe no banco`);
        return NextResponse.json({ message: "Contato não encontrado." }, { status: 404 });
      }
      log.warn(`GET: contato ${id} existe mas getContactById retornou null (relações falharam)`);
      return NextResponse.json(
        { message: "Erro ao montar detalhes do contato." },
        { status: 500 },
      );
    }

    return NextResponse.json(contact);
    });
  } catch (e) {
    log.error(`GET /api/contacts/${id} falhou:`, e);
    const errMsg =
      process.env.NODE_ENV !== "production" && e instanceof Error ? ` Detalhe: ${e.message}` : "";
    return NextResponse.json(
      { message: `Erro ao buscar contato.${errMsg}` },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "contact:edit");
    if (denied) return denied;

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

    if (b.email !== undefined && b.email !== null) {
      if (typeof b.email !== "string" || !EMAIL_RE.test(b.email.trim().toLowerCase())) {
        return NextResponse.json({ message: "E-mail inválido." }, { status: 400 });
      }
    }

    if (
      b.lifecycleStage !== undefined &&
      b.lifecycleStage !== null &&
      (typeof b.lifecycleStage !== "string" || !isValidLifecycleStage(b.lifecycleStage))
    ) {
      return NextResponse.json({ message: "Estágio do ciclo inválido." }, { status: 400 });
    }

    if (b.leadScore !== undefined && b.leadScore !== null) {
      if (typeof b.leadScore !== "number" || !Number.isFinite(b.leadScore)) {
        return NextResponse.json({ message: "leadScore inválido." }, { status: 400 });
      }
    }

    const exists = await contactExists(id);
    if (!exists) {
      return NextResponse.json({ message: "Contato não encontrado." }, { status: 404 });
    }

    const data: UpdateContactInput = {};

    if (b.name !== undefined) {
      data.name = typeof b.name === "string" ? b.name.trim() : "";
    }
    if (b.email !== undefined) {
      data.email = b.email === null ? null : typeof b.email === "string" ? b.email.trim().toLowerCase() : undefined;
    }
    if (b.phone !== undefined) {
      if (typeof b.phone === "string") {
        const parsed = parseContactPhoneInput(b.phone);
        if (!parsed.ok) return NextResponse.json({ message: parsed.reason }, { status: 400 });
        data.phone = parsed.value;
      } else if (b.phone === null) {
        data.phone = null;
      }
    }
    if (b.avatarUrl !== undefined) {
      data.avatarUrl =
        b.avatarUrl === null ? null : typeof b.avatarUrl === "string" ? b.avatarUrl.trim() : undefined;
    }
    if (b.leadScore !== undefined) {
      data.leadScore = typeof b.leadScore === "number" ? b.leadScore : undefined;
    }
    if (b.lifecycleStage !== undefined) {
      data.lifecycleStage =
        typeof b.lifecycleStage === "string" && isValidLifecycleStage(b.lifecycleStage)
          ? b.lifecycleStage
          : undefined;
    }
    if (b.source !== undefined) {
      data.source = b.source === null ? null : typeof b.source === "string" ? b.source.trim() : undefined;
    }
    if (b.companyId !== undefined) {
      data.companyId = b.companyId === null ? null : typeof b.companyId === "string" ? b.companyId : undefined;
    }
    if (b.assignedToId !== undefined) {
      data.assignedToId =
        b.assignedToId === null ? null : typeof b.assignedToId === "string" ? b.assignedToId : undefined;
    }

    const optionalTrim = (v: unknown): string | null | undefined => {
      if (v === null) return null;
      if (typeof v === "string") {
        const t = v.trim();
        return t.length ? t : null;
      }
      return undefined;
    };
    const trackingKeys = [
      "adUtmSource",
      "adUtmMedium",
      "adUtmCampaign",
      "adUtmContent",
      "adUtmTerm",
      "utmId",
      "utmReferrer",
      "referrer",
      "gclid",
      "fbclid",
      "googleClientId",
      "ttadId",
      "ttadName",
    ] as const;
    for (const key of trackingKeys) {
      if (b[key] !== undefined) {
        data[key] = optionalTrim(b[key]);
      }
    }

    const payload = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined)
    ) as UpdateContactInput;

    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    const contact = await updateContact(id, payload);

    return NextResponse.json(contact);
    });
  } catch (e: unknown) {
    log.error(`PUT /api/contacts falhou:`, e);
    if (typeof e === "object" && e !== null && "code" in e) {
      const code = (e as { code: string }).code;
      if (code === "P2025") {
        return NextResponse.json({ message: "Contato não encontrado." }, { status: 404 });
      }
      if (code === "P2002") {
        return NextResponse.json({ message: "Violação de unicidade." }, { status: 409 });
      }
      if (code === "P2003") {
        return NextResponse.json({ message: "Referência inválida (empresa ou responsável)." }, { status: 400 });
      }
    }
    const errMsg =
      process.env.NODE_ENV !== "production" && e instanceof Error ? ` Detalhe: ${e.message}` : "";
    return NextResponse.json({ message: `Erro ao atualizar contato.${errMsg}` }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "contact:delete");
    if (denied) return denied;

    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const exists = await contactExists(id);
    if (!exists) {
      return NextResponse.json({ message: "Contato não encontrado." }, { status: 404 });
    }

    // Snapshot do rótulo ANTES de excluir — deleteContact remove os
    // logs do contato e a FK contactId é cascade.
    const snap = await prisma.contact.findUnique({
      where: { id },
      select: { name: true, phone: true, email: true },
    });

    // 27/mai/26 — Bloqueio por `dealCount > 0` removido. `deleteContact`
    // ja nulifica `contactId` nos deals (preserva historico no kanban) e
    // remove conversas, mensagens, notas, atividades e logs.
    await deleteContact(id);
    log.info(`contato ${id} excluído com sucesso`);

    // IMPORTANTE: contactId=null (FK cascade já removeu o contato; setar
    // a FK apagaria este próprio evento). id preservado em entityId/meta.
    void logEvent({
      type: "CONTACT_DELETED",
      entityType: "CONTACT",
      entityId: id,
      entityLabel: snap?.name ?? snap?.phone ?? snap?.email ?? null,
      contactId: null,
      meta: { contactId: id, name: snap?.name ?? null, phone: snap?.phone ?? null },
    });

    return NextResponse.json({ ok: true });
    });
  } catch (e: unknown) {
    log.error(`falha ao excluir contato ${id}:`, e);

    if (typeof e === "object" && e !== null && "code" in e) {
      const code = (e as { code: string }).code;
      const meta = (e as { meta?: Record<string, unknown> }).meta ?? {};
      const detail = typeof meta.field_name === "string"
        ? ` (campo: ${meta.field_name})`
        : typeof meta.modelName === "string"
          ? ` (modelo: ${meta.modelName})`
          : "";

      if (code === "P2003") {
        return NextResponse.json(
          {
            message:
              `Não é possível excluir: existem registros vinculados${detail}. Remova-os primeiro ou contate o administrador.`,
          },
          { status: 409 },
        );
      }
      if (code === "P2025") {
        return NextResponse.json({ message: "Contato não encontrado." }, { status: 404 });
      }
    }

    const errMsg =
      process.env.NODE_ENV !== "production" && e instanceof Error
        ? ` Detalhe: ${e.message}`
        : "";
    return NextResponse.json(
      { message: `Erro ao excluir contato.${errMsg}` },
      { status: 500 },
    );
  }
}
