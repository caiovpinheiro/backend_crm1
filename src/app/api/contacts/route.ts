import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { parseContactPhoneInput } from "@/lib/phone";
import {
  createContact,
  getContacts,
  isValidLifecycleStage,
} from "@/services/contacts";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const denied = await requirePermissionForUser(authResult.user, "contact:view");
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") ?? undefined;
    const lifecycleStageRaw = searchParams.get("lifecycleStage");
    const lifecycleStage =
      lifecycleStageRaw && isValidLifecycleStage(lifecycleStageRaw) ? lifecycleStageRaw : undefined;
    const companyId = searchParams.get("companyId") ?? undefined;
    const unassigned = searchParams.get("unassigned") === "1";
    const tagIdsParam = searchParams.get("tagIds");
    const tagIds = tagIdsParam
      ? tagIdsParam.split(",").map((id) => id.trim()).filter(Boolean)
      : undefined;
    // Filtros exatos pensados para "lead-or-create" em integrações (n8n).
    // Diferente do `search` (contains em vários campos), aqui o match é
    // 1:1 — total=0 significa "não existe", total>=1 significa "existe e
    // a resposta já traz o(s) item(ns)".
    const emailExact = searchParams.get("email") ?? undefined;
    const phoneExact = searchParams.get("phone") ?? undefined;
    // Match exato pelo id do post/anúncio Meta que originou o contato
    // (Contact.adSourceId, gravado pelo webhook Meta em referral.source_id).
    // Uso principal: integrações (n8n) enumerando leads por anúncio.
    const adSourceId = searchParams.get("adSourceId") ?? undefined;
    // Opt-in para integrações: inclui UTM/gclid/fbclid/referrer no payload
    // (13 colunas a mais por contato — a UI não usa, por isso não é padrão).
    const includeTracking = searchParams.get("includeTracking") === "1";
    const page = parseIntParam(searchParams.get("page"), 1);
    const perPage = parseIntParam(searchParams.get("perPage"), 20);
    const sortByRaw = searchParams.get("sortBy");
    const sortOrderRaw = searchParams.get("sortOrder");
    const sortBy =
      sortByRaw === "name" ||
      sortByRaw === "email" ||
      sortByRaw === "createdAt" ||
      sortByRaw === "updatedAt" ||
      sortByRaw === "leadScore" ||
      sortByRaw === "lifecycleStage"
        ? sortByRaw
        : undefined;
    const sortOrder = sortOrderRaw === "asc" || sortOrderRaw === "desc" ? sortOrderRaw : undefined;

    const parseDate = (v: string | null, endOfDay = false): Date | undefined => {
      if (!v) return undefined;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return undefined;
      if (endOfDay) d.setHours(23, 59, 59, 999);
      return d;
    };
    const createdFrom = parseDate(searchParams.get("createdFrom"));
    const createdTo = parseDate(searchParams.get("createdTo"), true);
    const updatedFrom = parseDate(searchParams.get("updatedFrom"));
    const updatedTo = parseDate(searchParams.get("updatedTo"), true);

    const customFieldFilters: { name: string; operator?: "eq" | "contains" | "filled"; value?: string }[] =
      [];
    const cfRaw = searchParams.get("customFieldFilters");
    if (cfRaw) {
      try {
        const parsed = JSON.parse(cfRaw) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (!item || typeof item !== "object") continue;
            const o = item as Record<string, unknown>;
            const name = typeof o.name === "string" ? o.name.trim() : "";
            if (!name) continue;
            const operator =
              o.operator === "eq" || o.operator === "contains" || o.operator === "filled"
                ? o.operator
                : undefined;
            const value = typeof o.value === "string" ? o.value : undefined;
            customFieldFilters.push({ name, operator, value });
          }
        }
      } catch {
        /* ignore malformed JSON */
      }
    }

    const result = await getContacts({
      search,
      lifecycleStage,
      tagIds,
      companyId,
      unassigned,
      customFieldFilters: customFieldFilters.length > 0 ? customFieldFilters : undefined,
      emailExact,
      phoneExact,
      adSourceId,
      includeTracking,
      createdFrom,
      createdTo,
      updatedFrom,
      updatedTo,
      page,
      perPage,
      sortBy,
      sortOrder,
    });

    return NextResponse.json(result);
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { message: "Erro ao listar contatos." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "contact:create");
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

    if (typeof b.name !== "string" || b.name.trim().length < 1) {
      return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
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

    let phone: string | null | undefined;
    if (typeof b.phone === "string") {
      const parsed = parseContactPhoneInput(b.phone);
      if (!parsed.ok) return NextResponse.json({ message: parsed.reason }, { status: 400 });
      phone = parsed.value;
    } else if (b.phone === null) {
      phone = null;
    }

    const contact = await createContact({
      name: b.name.trim(),
      email:
        b.email === null
          ? null
          : typeof b.email === "string"
            ? b.email.trim().toLowerCase()
            : undefined,
      phone,
      avatarUrl:
        b.avatarUrl === null
          ? null
          : typeof b.avatarUrl === "string"
            ? b.avatarUrl.trim()
            : undefined,
      leadScore: typeof b.leadScore === "number" ? b.leadScore : undefined,
      lifecycleStage:
        typeof b.lifecycleStage === "string" && isValidLifecycleStage(b.lifecycleStage)
          ? b.lifecycleStage
          : undefined,
      source:
        b.source === null ? null : typeof b.source === "string" ? b.source.trim() : undefined,
      companyId:
        b.companyId === null
          ? null
          : typeof b.companyId === "string"
            ? b.companyId
            : undefined,
      assignedToId:
        b.assignedToId === null
          ? null
          : typeof b.assignedToId === "string"
            ? b.assignedToId
            : undefined,
    });

    return NextResponse.json(contact, { status: 201 });
    });
  } catch (e: unknown) {
    console.error(e);
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
      return NextResponse.json(
        { message: "Violação de unicidade." },
        { status: 409 }
      );
    }
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2003") {
      return NextResponse.json(
        { message: "Referência inválida (empresa ou usuário não encontrado)." },
        { status: 400 }
      );
    }
    return NextResponse.json({ message: "Erro ao criar contato." }, { status: 500 });
  }
}
