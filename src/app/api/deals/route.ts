import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { listAllowedPipelineIds, requirePermissionForUser, requireStageScope } from "@/lib/authz/resource-policy";
import { getVisibilityFilter } from "@/lib/visibility";
import { fireTrigger } from "@/services/automation-triggers";
import {
  createDeal,
  createDealEvent,
  flattenDealListItem,
  getDeals,
  isValidDealStatus,
} from "@/services/deals";
import { parseAdvancedDealFilters } from "@/services/kanban-filters";

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
    const denied = await requirePermissionForUser(authResult.user, "deal:view");
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const pipelineId = searchParams.get("pipelineId") ?? undefined;
    const stageId = searchParams.get("stageId") ?? undefined;
    const statusRaw = searchParams.get("status");
    const status =
      statusRaw && isValidDealStatus(statusRaw) ? statusRaw : undefined;
    const ownerId = searchParams.get("ownerId") ?? undefined;
    const search = searchParams.get("search") ?? undefined;
    // Filtros exatos por contato dono do deal — pareados com `?email`/`?phone`
    // em `/api/contacts`. Permitem responder "este contato tem deal nesse
    // pipeline/stage?" em uma chamada só (sem GET de contacts antes).
    const contactId = searchParams.get("contactId") ?? undefined;
    const contactEmail = searchParams.get("contactEmail") ?? undefined;
    const contactPhone = searchParams.get("contactPhone") ?? undefined;
    const page = parseIntParam(searchParams.get("page"), 1);
    const perPage = parseIntParam(searchParams.get("perPage"), 20);
    const updatedSinceRaw = searchParams.get("updatedSince")?.trim();
    let updatedSince: Date | undefined;
    if (updatedSinceRaw) {
      const parsed = new Date(updatedSinceRaw);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { message: "updatedSince inválido. Use ISO-8601." },
          { status: 400 },
        );
      }
      updatedSince = parsed;
    }
    // Filtros avançados (mesmo shape do kanban) — JSON em `filters` ou base64url em `f`.
    let advancedFilters = parseAdvancedDealFilters(
      (() => {
        const raw = searchParams.get("filters");
        if (!raw) return undefined;
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      })(),
    );
    if (Object.keys(advancedFilters).length === 0) {
      const f = searchParams.get("f");
      if (f) {
        try {
          const b64 = f.replace(/-/g, "+").replace(/_/g, "/");
          const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
          const json = Buffer.from(b64 + pad, "base64").toString("utf8");
          advancedFilters = parseAdvancedDealFilters(JSON.parse(json));
        } catch {
          /* ignora f inválido */
        }
      }
    }

    const user = authResult.user as { id: string; role: "ADMIN" | "MANAGER" | "MEMBER" };
    const visibility = await getVisibilityFilter(user);

    // Escopo de funis por usuário aplicado no WHERE (eficiente e correto
    // com paginação). Escopo de etapa segue como pós-filtro por item.
    const allowedPipelineIds = await listAllowedPipelineIds(authResult.user);

    const result = await getDeals({
      pipelineId,
      stageId,
      status,
      ownerId,
      search,
      contactId,
      contactEmail,
      contactPhone,
      page,
      perPage,
      visibilityWhere: visibility.dealWhere,
      allowedPipelineIds,
      advancedFilters: Object.keys(advancedFilters).length > 0 ? advancedFilters : undefined,
      updatedSince,
    });

    const items = await Promise.all(
      result.items.map(async (deal) => {
        const stageDenied = await requireStageScope(authResult.user, "view", deal.stageId);
        if (stageDenied) return null;
        return flattenDealListItem(deal);
      }),
    );
    return NextResponse.json({ ...result, items: items.filter(Boolean) });
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao listar negócios." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "deal:create");
    if (denied) return denied;
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

    // Título opcional: negócio sem nome é batizado automaticamente como
    // "Negócio - #<number>" em createDeal. Só validamos o tipo quando vem.
    if (b.title !== undefined && b.title !== null && typeof b.title !== "string") {
      return NextResponse.json({ message: "Título inválido." }, { status: 400 });
    }
    if (typeof b.stageId !== "string" || !b.stageId) {
      return NextResponse.json({ message: "stageId é obrigatório." }, { status: 400 });
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

    try {
      const stageScope = await requireStageScope(authResult.user, "move", b.stageId);
      if (stageScope) return stageScope;
      const deal = await createDeal({
        title: typeof b.title === "string" ? b.title : undefined,
        stageId: b.stageId,
        value: typeof b.value === "number" ? b.value : undefined,
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
        ownerId:
          b.ownerId === null
            ? null
            : typeof b.ownerId === "string"
              ? b.ownerId
              : undefined,
      });

      const uid = authResult.user.id;
      createDealEvent(deal.id, uid, "CREATED", {
        stageId: b.stageId,
        createdAt: deal.createdAt instanceof Date ? deal.createdAt.toISOString() : deal.createdAt,
      }).catch(() => {});
      fireTrigger("deal_created", {
        dealId: deal.id,
        contactId: deal.contactId ?? undefined,
        data: { stageId: b.stageId, toStageId: b.stageId },
      }).catch(() => {});

      // NB (jul/26): NÃO criamos mais Conversation WhatsApp antecipadamente ao
      // nascer o deal. Isso poluía a fila com conversas OPEN sem nenhuma
      // mensagem. A conversa passa a ser criada sob demanda — com `channelId`
      // resolvido no momento — em cada caminho de envio: abrir chat (skipSend
      // em /api/conversations/create), inbound (webhook Meta) e automação
      // (resolveAutomationSendConv → ensureWhatsAppConversationForContact).
      // A proteção contra leak entre orgs vive nesses caminhos, não aqui.

      return NextResponse.json(deal, { status: 201 });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "INVALID_TITLE") {
        return NextResponse.json({ message: "Título inválido." }, { status: 400 });
      }
      throw err;
    }
    });
  } catch (e: unknown) {
    console.error(e);
    if (typeof e === "object" && e !== null && "code" in e) {
      const code = (e as { code: string }).code;
      if (code === "P2003") {
        return NextResponse.json({ message: "Referência inválida (estágio, contato ou responsável)." }, { status: 400 });
      }
    }
    return NextResponse.json({ message: "Erro ao criar negócio." }, { status: 500 });
  }
}
