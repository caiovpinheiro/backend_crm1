import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  canEditFieldForUser,
  loadScopedPolicy,
  requirePermissionForUser,
} from "@/lib/authz/resource-policy";
import { canAccessField } from "@/lib/authz/scope-grants";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { TenantIsolationError } from "@/lib/prisma-tenant-helpers";
import {
  getDealCustomFieldValues,
  prismaErrorCode,
  upsertDealCustomFieldValues,
} from "@/services/custom-fields";
import { createDealEvent, getDealById } from "@/services/deals";

type Ctx = { params: Promise<{ id: string }> };

const log = getLogger("api/deals/custom-fields");

// Bug 27/mai/26: usava `withOrgContext`, que só lê cookie do NextAuth.
// Bearer tokens (n8n, integrações server-to-server) recebiam 401 mesmo
// com token válido. Migrado para o par `authenticateApiRequest` +
// `runWithApiUserContext` — mesmo padrão de `/api/deals/route.ts`,
// aceita Bearer e sessão.
export async function GET(request: Request, ctx: Ctx) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const denied = await requirePermissionForUser(authResult.user, "deal:view");
      if (denied) return denied;
      const { id } = await ctx.params;
      const existing = await getDealById(id);
      if (!existing) return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
      const values = await getDealCustomFieldValues(existing.id);
      const policy = await loadScopedPolicy(authResult.user);
      const visible = values.filter((item) => {
        if (!policy.enabled) return true;
        return canAccessField({
          grants: policy.grants,
          role: authResult.user.role,
          entity: "deal",
          action: "view",
          fieldKey: item.fieldId,
        });
      });
      return NextResponse.json(visible);
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro." },
      { status: 500 },
    );
  }
}

type FieldValue = { fieldId: string; value: string };

/** Erro de cliente: 4xx com mensagem e `code` estáveis. */
function clientError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ message, code, ...extra }, { status });
}

/** Erros transitórios de banco (pool esgotado, transação vencida, conexão caída). */
const TRANSIENT_DB_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034"]);
const RETRY_AFTER_S = 5;

/**
 * Corpo: `{ values: [{ fieldId, value }] }`. Lê como texto e parseia — JSON
 * inválido ou corpo que não é objeto é erro do cliente (antes: 500).
 */
async function readValues(
  request: Request,
): Promise<{ ok: true; values: FieldValue[] } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    const text = await request.text();
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: clientError(400, "INVALID_JSON", "Corpo inválido: envie JSON { values: [{ fieldId, value }] }."),
    };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: clientError(400, "INVALID_BODY", "Corpo inválido: envie { values: [{ fieldId, value }] }."),
    };
  }
  const raw = (body as Record<string, unknown>).values;
  if (raw !== undefined && !Array.isArray(raw)) {
    return { ok: false, response: clientError(400, "INVALID_BODY", "`values` deve ser uma lista.") };
  }
  const byField = new Map<string, FieldValue>();
  for (const v of raw ?? []) {
    if (!v || typeof v !== "object") continue;
    const { fieldId, value } = v as Record<string, unknown>;
    if (typeof fieldId !== "string" || typeof value !== "string") continue;
    // NUL (\u0000) o Postgres recusa em texto (22021 → 500): nunca é intencional.
    byField.set(fieldId, { fieldId, value: value.includes("\u0000") ? value.replace(/\u0000/g, "") : value });
  }
  // Campo repetido: o último vence.
  return { ok: true, values: [...byField.values()] };
}

export async function PUT(request: Request, ctx: Ctx) {
  let dealRef: string | null = null;
  let fieldIds: string[] = [];
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const denied = await requirePermissionForUser(authResult.user, "deal:edit");
      if (denied) return denied;
      const { id } = await ctx.params;
      dealRef = id;
      const existing = await getDealById(id);
      if (!existing) return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
      const dealId = existing.id;
      dealRef = dealId;
      const parsed = await readValues(request);
      if (!parsed.ok) return parsed.response;
      const cleaned = parsed.values;
      fieldIds = cleaned.map((c) => c.fieldId);

      // Campo apagado, de outra org (a consulta é escopada) ou de contato:
      // antes virava P2003 (FK) → 500, ou gravava valor de campo de contato
      // no negócio.
      const fieldDefs =
        fieldIds.length > 0
          ? await prisma.customField.findMany({
              where: { id: { in: fieldIds } },
              select: { id: true, label: true, entity: true },
            })
          : [];
      const defById = new Map(fieldDefs.map((f) => [f.id, f]));
      const missing = fieldIds.filter((fid) => !defById.has(fid));
      if (missing.length > 0) {
        return clientError(
          422,
          "CUSTOM_FIELD_NOT_FOUND",
          "Campo personalizado não existe mais. Recarregue a página.",
          { fieldIds: missing },
        );
      }
      const wrongEntity = fieldDefs.filter((f) => f.entity !== "deal").map((f) => f.id);
      if (wrongEntity.length > 0) {
        return clientError(
          422,
          "CUSTOM_FIELD_WRONG_ENTITY",
          "Campo personalizado não é de negócio.",
          { fieldIds: wrongEntity },
        );
      }

      const blocked = [];
      for (const item of cleaned) {
        const allowed = await canEditFieldForUser(authResult.user, "deal", item.fieldId);
        if (!allowed) blocked.push(item.fieldId);
      }
      if (blocked.length > 0) {
        return NextResponse.json(
          { message: "Sem permissão para editar alguns campos.", blockedFieldIds: blocked },
          { status: 403 },
        );
      }
      const oldValues = await getDealCustomFieldValues(dealId);
      const oldMap = new Map(
        (oldValues as { fieldId: string; value: string }[]).map((v) => [v.fieldId, v.value]),
      );
      // O editor manda value: "" para limpar. Esse PUT grava o vazio.
      // Importação, lead e automação seguem sem apagar texto já gravado.
      await upsertDealCustomFieldValues(dealId, cleaned, { allowBlank: true });
      const updated = await getDealCustomFieldValues(dealId);

      const uid = authResult.user.id;
      const labelMap = new Map(fieldDefs.map((f) => [f.id, f.label]));

      for (const item of cleaned) {
        const prev = oldMap.get(item.fieldId) ?? "";
        if (prev !== item.value) {
          createDealEvent(dealId, uid, "CUSTOM_FIELD_UPDATED", {
            fieldLabel: labelMap.get(item.fieldId) ?? item.fieldId,
            from: prev,
            to: item.value,
          }).catch(() => {});
        }
      }

      return NextResponse.json(updated);
    });
  } catch (e) {
    return putErrorResponse(e, { dealId: dealRef, fieldIds });
  }
}

/**
 * Exceção do PUT → resposta + log estruturado (`code` do Prisma, alvo da
 * constraint, ids do negócio e dos campos — nunca os valores).
 */
function putErrorResponse(err: unknown, ctx: { dealId: string | null; fieldIds: string[] }): NextResponse {
  const code = prismaErrorCode(err);
  const meta = (err as { meta?: { target?: unknown; field_name?: unknown; modelName?: unknown } } | null)?.meta;
  const logPayload = {
    route: "PUT /api/deals/:id/custom-fields",
    code: code ?? (err instanceof TenantIsolationError ? "TENANT_ISOLATION" : null),
    errName: err instanceof Error ? err.name : typeof err,
    target: meta?.target ?? meta?.field_name ?? null,
    model: meta?.modelName ?? null,
    dealId: ctx.dealId,
    fieldIds: ctx.fieldIds,
  };
  if (code === "P2002") {
    // Ainda em corrida depois da 2ª tentativa (rajada de salvamentos).
    log.warn(logPayload, "custom-fields: salvamento concorrente");
    return clientError(409, "CONCURRENT_UPDATE", "O campo foi salvo ao mesmo tempo em outro lugar. Tente de novo.");
  }
  if (code === "P2003" || code === "P2025") {
    // Negócio ou campo apagado no meio do salvamento.
    log.warn(logPayload, "custom-fields: negócio ou campo apagado durante o salvamento");
    return clientError(409, "DELETED_DURING_SAVE", "O negócio ou o campo foi apagado. Recarregue a página.");
  }
  if (code && TRANSIENT_DB_CODES.has(code)) {
    log.error(logPayload, "custom-fields: banco indisponível ou ocupado");
    return NextResponse.json(
      { message: "Banco ocupado. Tente de novo em instantes.", code: "DB_BUSY", retryAfterMs: RETRY_AFTER_S * 1_000 },
      { status: 503, headers: { "Retry-After": String(RETRY_AFTER_S) } },
    );
  }
  if (err instanceof TenantIsolationError) {
    log.error(logPayload, "custom-fields: isolamento de org");
    return clientError(403, "FORBIDDEN", "Sem acesso a este negócio.");
  }
  log.error(
    { ...logPayload, err: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) },
    "custom-fields: erro ao salvar",
  );
  return NextResponse.json({ message: "Erro ao salvar campos personalizados." }, { status: 500 });
}
