import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { canEditFieldForUser, requirePermissionForUser, requirePipelineScope, requireStageScope } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import { getVisibilityFilter } from "@/lib/visibility";
import { fireTrigger } from "@/services/automation-triggers";
import { createDealEvent, deleteDeal, getDealById, isValidDealStatus, updateDeal } from "@/services/deals";
import { getDealPanelFieldsForDeal } from "@/services/contacts";
import { logEvent } from "@/services/activity-log";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "deal:view");
    if (denied) return denied;
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const deal = await getDealById(id);
    if (!deal) {
      return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    }
    const stageDenied = await requireStageScope(authResult.user, "view", deal.stage.id);
    if (stageDenied) return stageDenied;
    const pipelineDenied = await requirePipelineScope(
      authResult.user,
      "view",
      (deal.stage as { pipelineId?: string }).pipelineId ?? "",
    );
    if (pipelineDenied && (deal.stage as { pipelineId?: string }).pipelineId) return pipelineDenied;

    const user = authResult.user as { id: string; role: "ADMIN" | "MANAGER" | "MEMBER" };
    const visibility = await getVisibilityFilter(user);
    // Deal sem dono acompanha o eixo "sem responsável": quem enxerga o pool no
    // board precisa conseguir abrir o card, senão o clique devolve 403.
    const ownsOrCanClaim =
      deal.ownerId === user.id ||
      (deal.ownerId === null && visibility.includeUnassigned);
    if (!visibility.canSeeAll && !ownsOrCanClaim) {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }

    // Achata as relações N:N de tags para o formato { id, name, color }[]
    // que o frontend consome (key={t.id}). O include do Prisma devolve
    // { tag: {...} }[], e sem o flatten o painel renderizava chips vazios
    // e disparava o warning de "unique key" no React.
    type NestedTag = { tag: { id: string; name: string; color: string | null } };
    const flattenTags = (arr?: NestedTag[] | null) => (arr ?? []).map((t) => t.tag);
    // Campos do negócio visíveis no painel Deal Detail (filtrados por showInDealPanel)
    const dealPanelFields = await getDealPanelFieldsForDeal(id).catch(() => []);

    const responseDeal = {
      ...deal,
      tags: flattenTags(deal.tags as unknown as NestedTag[]),
      dealPanelFields,
      contact: deal.contact
        ? {
            ...deal.contact,
            tags: flattenTags(
              (deal.contact as { tags?: NestedTag[] }).tags,
            ),
          }
        : deal.contact,
    };

    return NextResponse.json(responseDeal);
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao buscar negócio." }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    // Gate base = leitura. Cada grupo de campo cobra a sua própria permission
    // mais abaixo (`deal:edit` p/ campos comuns, `deal:change_stage` p/ etapa,
    // `deal:transfer_owner` p/ responsável) — exigir `deal:edit` aqui barrava
    // quem só tinha a chave de transferência.
    const denied = await requirePermissionForUser(authResult.user, "deal:view");
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

    const existing = await getDealById(id);
    if (!existing) {
      return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    }
    const stageDenied = await requireStageScope(authResult.user, "view", existing.stage.id);
    if (stageDenied) return stageDenied;

    const dealId = existing.id;

    if (b.title !== undefined && (typeof b.title !== "string" || b.title.trim().length < 1)) {
      return NextResponse.json({ message: "Título inválido." }, { status: 400 });
    }
    if (b.status !== undefined && b.status !== null) {
      if (typeof b.status !== "string" || !isValidDealStatus(b.status)) {
        return NextResponse.json({ message: "Status inválido." }, { status: 400 });
      }
    }
    if (b.value !== undefined && b.value !== null) {
      if (typeof b.value !== "number" || !Number.isFinite(b.value)) {
        return NextResponse.json({ message: "value inválido." }, { status: 400 });
      }
    }
    if (b.position !== undefined && b.position !== null) {
      if (typeof b.position !== "number" || !Number.isInteger(b.position) || b.position < 0) {
        return NextResponse.json({ message: "position inválido." }, { status: 400 });
      }
    }
    if (b.stageId !== undefined && (typeof b.stageId !== "string" || !b.stageId)) {
      return NextResponse.json({ message: "stageId inválido." }, { status: 400 });
    }
    if (
      b.orgUnitId !== undefined &&
      b.orgUnitId !== null &&
      typeof b.orgUnitId !== "string"
    ) {
      return NextResponse.json({ message: "orgUnitId inválido." }, { status: 400 });
    }
    if (typeof b.orgUnitId === "string" && b.orgUnitId) {
      const unit = await prisma.orgUnit.findUnique({
        where: { id: b.orgUnitId },
        select: { id: true },
      });
      if (!unit) {
        return NextResponse.json(
          { message: "Unidade não encontrada." },
          { status: 400 },
        );
      }
    }

    let expectedClose: Date | string | null | undefined;
    if (b.expectedClose === null) {
      expectedClose = null;
    } else if (typeof b.expectedClose === "string") {
      const d = new Date(b.expectedClose);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ message: "expectedClose inválido." }, { status: 400 });
      }
      expectedClose = d;
    } else if (b.expectedClose !== undefined) {
      return NextResponse.json({ message: "expectedClose inválido." }, { status: 400 });
    }

    const data = {
      title: typeof b.title === "string" ? b.title : undefined,
      value:
        b.value === null ? null : typeof b.value === "number" ? b.value : undefined,
      status:
        typeof b.status === "string" && isValidDealStatus(b.status) ? b.status : undefined,
      expectedClose,
      lostReason:
        b.lostReason === null
          ? null
          : typeof b.lostReason === "string"
            ? b.lostReason
            : undefined,
      position: typeof b.position === "number" ? b.position : undefined,
      contactId:
        b.contactId === null
          ? null
          : typeof b.contactId === "string"
            ? b.contactId
            : undefined,
      stageId: typeof b.stageId === "string" ? b.stageId : undefined,
      ownerId:
        b.ownerId === null
          ? null
          : typeof b.ownerId === "string"
            ? b.ownerId
            : undefined,
      propagateToChat:
        typeof b.propagateToChat === "boolean" ? b.propagateToChat : undefined,
      orgUnitId:
        b.orgUnitId === null
          ? null
          : typeof b.orgUnitId === "string"
            ? b.orgUnitId
            : undefined,
    };

    const payload = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined)
    ) as Parameters<typeof updateDeal>[1];

    // Mover de etapa exige `deal:change_stage` — não basta `deal:edit`, senão
    // o PUT furava o gate do POST /move e um operador sem a permission
    // ainda mudava fase pelo painel.
    const stageChanging =
      typeof payload.stageId === "string" && payload.stageId !== existing.stage.id;
    if (stageChanging) {
      const moveDenied = await requirePermissionForUser(authResult.user, "deal:change_stage");
      if (moveDenied) return moveDenied;
    }

    const currentOwnerId = existing.owner?.id ?? null;
    const ownerChanging =
      "ownerId" in payload && (payload.ownerId ?? null) !== currentOwnerId;
    if (ownerChanging) {
      const transferDenied = await requirePermissionForUser(
        authResult.user,
        "deal:transfer_owner",
      );
      if (transferDenied) {
        // `deal:transfer_owner` cobre "mexer no responsável de qualquer
        // negócio". Sem ela, quem tem `deal:edit` ainda entrega um negócio
        // próprio (ou sem dono) — é o que o preset Operador sempre permitiu.
        const ownOrUnassigned = !currentOwnerId || currentOwnerId === authResult.user.id;
        const editDenied = await requirePermissionForUser(authResult.user, "deal:edit");
        if (!ownOrUnassigned || editDenied) return transferDenied;
      }
    }

    // Campos comuns (título, valor, contato…) seguem sob `deal:edit`.
    const scopedFields = new Set(["stageId", "ownerId", "propagateToChat"]);
    const touchesCommonFields = Object.keys(payload).some((k) => !scopedFields.has(k));
    if (touchesCommonFields) {
      const editDenied = await requirePermissionForUser(authResult.user, "deal:edit");
      if (editDenied) return editDenied;
    }

    const blockedFields: string[] = [];
    for (const key of Object.keys(payload)) {
      if (key === "propagateToChat") continue;
      if (!(await canEditFieldForUser(authResult.user, "deal", key))) blockedFields.push(key);
    }
    if (blockedFields.length > 0) {
      return NextResponse.json(
        { message: "Sem permissão para editar campos.", blockedFields },
        { status: 403 },
      );
    }

    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    try {
      if (payload.stageId) {
        const moveDenied = await requireStageScope(authResult.user, "move", payload.stageId);
        if (moveDenied) return moveDenied;
        // Cross-pipeline: quando o novo estágio pertence a outro funil,
        // exige acesso ao pipeline destino também.
        const targetStageMeta = await prisma.stage.findUnique({
          where: { id: payload.stageId },
          select: { pipelineId: true },
        });
        if (!targetStageMeta) {
          return NextResponse.json({ message: "Estágio não encontrado." }, { status: 400 });
        }
        const fromPipelineId = (existing.stage as { pipelineId?: string }).pipelineId ?? null;
        if (fromPipelineId && targetStageMeta.pipelineId !== fromPipelineId) {
          const pipeDenied = await requirePipelineScope(
            authResult.user,
            "view",
            targetStageMeta.pipelineId,
          );
          if (pipeDenied) return pipeDenied;
        }
      }
      const deal = await updateDeal(dealId, payload);

      const uid = authResult.user.id;
      if (payload.title !== undefined && payload.title !== existing.title) {
        createDealEvent(dealId, uid, "FIELD_UPDATED", { field: "title", from: existing.title, to: payload.title }).catch(() => {});
      }
      if (payload.value !== undefined && String(payload.value) !== String(existing.value)) {
        createDealEvent(dealId, uid, "FIELD_UPDATED", { field: "value", from: String(existing.value), to: String(payload.value) }).catch(() => {});
      }
      if (payload.expectedClose !== undefined) {
        createDealEvent(dealId, uid, "FIELD_UPDATED", { field: "expectedClose", from: existing.expectedClose, to: payload.expectedClose }).catch(() => {});
      }
      if (payload.stageId !== undefined && payload.stageId !== existing.stage.id) {
        const toStage = await prisma.stage.findUnique({
          where: { id: payload.stageId },
          select: {
            name: true,
            pipelineId: true,
            pipeline: { select: { id: true, name: true } },
          },
        });
        const fromPipelineId = (existing.stage as { pipelineId?: string }).pipelineId ?? null;
        const toPipelineId = toStage?.pipelineId ?? null;
        const pipelineChanged =
          !!fromPipelineId && !!toPipelineId && fromPipelineId !== toPipelineId;
        createDealEvent(dealId, uid, "STAGE_CHANGED", {
          from: {
            id: existing.stage.id,
            name: existing.stage.name,
            pipelineId: fromPipelineId,
            pipelineName:
              (existing.stage as { pipeline?: { name?: string } }).pipeline?.name ?? null,
          },
          to: {
            id: payload.stageId,
            name: toStage?.name ?? payload.stageId,
            pipelineId: toPipelineId,
            pipelineName: toStage?.pipeline?.name ?? null,
          },
          ...(pipelineChanged ? { pipelineChanged: true } : {}),
        }).catch(() => {});
        fireTrigger("stage_changed", {
          dealId,
          contactId: existing.contactId ?? undefined,
          data: {
            fromStageId: existing.stage.id,
            toStageId: payload.stageId,
            fromPipelineId,
            toPipelineId,
          },
        }).catch(() => {});
      }
      if (payload.ownerId !== undefined && payload.ownerId !== existing.owner?.id) {
        const toUser = payload.ownerId ? await prisma.user.findUnique({ where: { id: payload.ownerId }, select: { name: true } }) : null;
        createDealEvent(dealId, uid, "OWNER_CHANGED", { from: existing.owner ? { id: existing.owner.id, name: existing.owner.name } : null, to: payload.ownerId ? { id: payload.ownerId, name: toUser?.name ?? payload.ownerId } : null }).catch(() => {});
        fireTrigger("agent_changed", {
          dealId,
          contactId: existing.contactId ?? undefined,
          data: { fromOwnerId: existing.owner?.id ?? null, toOwnerId: payload.ownerId },
        }).catch(() => {});
      }
      if (payload.contactId !== undefined && payload.contactId !== (existing.contactId ?? null)) {
        const toContact = payload.contactId
          ? await prisma.contact.findUnique({ where: { id: payload.contactId }, select: { id: true, name: true } })
          : null;
        const fromContactData = existing.contact
          ? { id: existing.contact.id, name: existing.contact.name }
          : null;
        const wasLinked = !!existing.contactId;
        const isLinked = !!payload.contactId;
        if (isLinked && !wasLinked) {
          createDealEvent(dealId, uid, "CONTACT_LINKED", {
            to: toContact ? { id: toContact.id, name: toContact.name } : null,
          }).catch(() => {});
        } else if (!isLinked && wasLinked) {
          createDealEvent(dealId, uid, "CONTACT_UNLINKED", {
            from: fromContactData,
          }).catch(() => {});
        } else if (isLinked && wasLinked) {
          createDealEvent(dealId, uid, "CONTACT_LINKED", {
            from: fromContactData,
            to: toContact ? { id: toContact.id, name: toContact.name } : null,
          }).catch(() => {});
        }
      }

      return NextResponse.json(deal);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === "INVALID_TITLE") {
          return NextResponse.json({ message: "Título inválido." }, { status: 400 });
        }
        if (err.message === "EMPTY_UPDATE") {
          return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
        }
      }
      throw err;
    }
    });
  } catch (e: unknown) {
    console.error(e);
    if (typeof e === "object" && e !== null && "code" in e) {
      const code = (e as { code: string }).code;
      if (code === "P2025") {
        return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
      }
      if (code === "P2003") {
        return NextResponse.json({ message: "Referência inválida." }, { status: 400 });
      }
    }
    return NextResponse.json({ message: "Erro ao atualizar negócio." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "deal:delete");
    if (denied) return denied;
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const existing = await getDealById(id);
    if (!existing) {
      return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    }

    // Captura o ator antes de excluir (após o delete o ctx ainda vale,
    // mas garantimos o label do sujeito a partir do snapshot `existing`).
    const dealLabel =
      (existing as { title?: string | null }).title ??
      ((existing as { number?: number | null }).number != null
        ? `#${(existing as { number?: number | null }).number}`
        : null);
    const dealContactId =
      (existing as { contact?: { id?: string } | null }).contact?.id ??
      (existing as { contactId?: string | null }).contactId ??
      null;

    await deleteDeal(existing.id);

    // IMPORTANTE: NÃO preencher `dealId` aqui — a FK tem onDelete:Cascade
    // e o deal acabou de ser removido, então o próprio evento seria
    // apagado. O id vai em `entityId` (string livre, sem FK) e em meta,
    // preservando a auditoria da exclusão.
    void logEvent({
      type: "DEAL_DELETED",
      entityType: "DEAL",
      entityId: existing.id,
      entityLabel: dealLabel,
      dealId: null,
      contactId: dealContactId,
      meta: { dealId: existing.id, title: dealLabel },
    });

    return NextResponse.json({ ok: true });
    });
  } catch (e: unknown) {
    console.error(e);
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025") {
      return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    }
    return NextResponse.json({ message: "Erro ao excluir negócio." }, { status: 500 });
  }
}
