import type { LifecycleStage } from "@prisma/client";
import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  requirePermissionForUser,
  requireStageScope,
} from "@/lib/authz/resource-policy";
import { parseContactPhoneInput } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { fireTrigger } from "@/services/automation-triggers";
import {
  createContact,
  isValidLifecycleStage,
  updateContact,
} from "@/services/contacts";
import {
  upsertContactCustomFieldValues,
  upsertDealCustomFieldValues,
} from "@/services/custom-fields";
import {
  type CreateDealResult,
  createDealEventTx,
  createDealTx,
  findOpenDealForContactInPipeline,
  isValidDealStatus,
} from "@/services/deals";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CustomFieldInput = {
  fieldId?: string;
  /** Alternativa ao fieldId — resolve por `CustomField.name` na org. */
  name?: string;
  value: string;
};

/**
 * Resolve `[{ fieldId?, name?, value }]` em `[{ fieldId, value }]` consultando
 * `CustomField` por `(organizationId, name, entity)`. Itens sem fieldId nem
 * name reconhecível são silenciosamente descartados — o caller pode pré-checar
 * com `GET /api/custom-fields` se precisar erro estrito.
 */
async function resolveCustomFields(
  entity: "contact" | "deal",
  items: unknown,
): Promise<{ resolved: { fieldId: string; value: string }[]; missing: string[] }> {
  if (!Array.isArray(items) || items.length === 0) {
    return { resolved: [], missing: [] };
  }

  const cleaned: CustomFieldInput[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const value = typeof obj.value === "string" ? obj.value : null;
    if (value === null) continue;
    const fieldId = typeof obj.fieldId === "string" && obj.fieldId.length > 0 ? obj.fieldId : undefined;
    const name = typeof obj.name === "string" && obj.name.trim().length > 0 ? obj.name.trim() : undefined;
    if (!fieldId && !name) continue;
    cleaned.push({ fieldId, name, value });
  }

  if (cleaned.length === 0) return { resolved: [], missing: [] };

  const namesToResolve = cleaned.filter((c) => !c.fieldId && c.name).map((c) => c.name!);

  let byName = new Map<string, string>();
  if (namesToResolve.length > 0) {
    const defs = await prisma.customField.findMany({
      where: { entity, name: { in: namesToResolve } },
      select: { id: true, name: true },
    });
    byName = new Map(defs.map((d) => [d.name, d.id]));
  }

  const resolved: { fieldId: string; value: string }[] = [];
  const missing: string[] = [];
  for (const item of cleaned) {
    const id = item.fieldId ?? (item.name ? byName.get(item.name) : undefined);
    if (!id) {
      missing.push(item.name ?? "(sem nome)");
      continue;
    }
    resolved.push({ fieldId: id, value: item.value });
  }
  return { resolved, missing };
}

/**
 * Acha um contato pré-existente usando, nesta ordem:
 *   1. `id` explícito do payload.
 *   2. `phone` — match exato OU `endsWith` dos dígitos quando ≥ 8.
 *   3. `email` — equals case-insensitive.
 *
 * Retorna `null` se nenhum critério bater. A query roda dentro do
 * `RequestContext` ativo, então a Prisma extension já filtra por
 * `organizationId` — não há vazamento cross-tenant.
 */
async function findExistingContact(input: {
  id?: string;
  phone?: string;
  email?: string;
}): Promise<{ id: string } | null> {
  if (input.id) {
    const byId = await prisma.contact.findUnique({
      where: { id: input.id },
      select: { id: true },
    });
    if (byId) return byId;
  }

  const phoneRaw = input.phone?.trim();
  if (phoneRaw) {
    const digits = phoneRaw.replace(/\D/g, "");
    const conditions: Array<{ phone?: { equals?: string; endsWith?: string } }> = [
      { phone: { equals: phoneRaw } },
    ];
    if (digits.length >= 8) {
      conditions.push({ phone: { endsWith: digits } });
    }
    const byPhone = await prisma.contact.findFirst({
      where: { OR: conditions },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (byPhone) return byPhone;
  }

  const emailRaw = input.email?.trim().toLowerCase();
  if (emailRaw) {
    const byEmail = await prisma.contact.findFirst({
      where: { email: { equals: emailRaw, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (byEmail) return byEmail;
  }

  return null;
}

type ContactPayload = {
  id?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  leadScore?: number;
  lifecycleStage?: LifecycleStage;
  source?: string | null;
  companyId?: string | null;
  assignedToId?: string | null;
  customFields?: CustomFieldInput[];
};

/**
 * Modificadores de idempotência do lead.
 *
 * Ambos são opt-in: o comportamento padrão ("última escrita vence", deal
 * sempre novo) é o que integrações antigas já esperam, e mudá-lo no servidor
 * quebraria quem depende dele. Quem quer a proteção liga explicitamente — o
 * node do n8n liga as duas por padrão.
 */
type LeadOptions = {
  /**
   * Reaproveita o negócio aberto que o contato já tem **no mesmo pipeline**
   * do `stageId` informado, em vez de criar outro.
   *
   * Escopo é o pipeline e não a etapa porque um lead que avançou de
   * "Acolhimento" para "Matrícula" continua sendo o mesmo negócio: comparar
   * por etapa recriaria uma duplicata a cada avanço.
   */
  reuseOpenDeal?: boolean;
  /**
   * Em contato já existente, só grava nos campos que estão vazios. Impede que
   * uma segunda chamada com dado pior sobrescreva nome/telefone/e-mail bons.
   */
  fillEmptyContactFieldsOnly?: boolean;
};

function parseLeadOptions(input: unknown): LeadOptions {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  return {
    reuseOpenDeal: o.reuseOpenDeal === true,
    fillEmptyContactFieldsOnly: o.fillEmptyContactFieldsOnly === true,
  };
}

/** Vazio para efeito de "não sobrescrever": null, string em branco ou ausente. */
function isBlank(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

type DealPayload = {
  title?: string;
  stageId: string;
  value?: number;
  status?: string;
  expectedClose?: string | null;
  ownerId?: string | null;
  position?: number;
  customFields?: CustomFieldInput[];
};

function parseContactPayload(input: unknown): ContactPayload | { error: string } {
  if (!input || typeof input !== "object") return { error: "contact é obrigatório." };
  const b = input as Record<string, unknown>;
  const out: ContactPayload = {};

  if (b.id !== undefined) {
    if (typeof b.id !== "string" || b.id.trim() === "") return { error: "contact.id inválido." };
    out.id = b.id.trim();
  }
  if (b.name !== undefined) {
    if (typeof b.name !== "string" || b.name.trim() === "") return { error: "contact.name inválido." };
    out.name = b.name.trim();
  }
  if (b.email !== undefined) {
    if (b.email === null) {
      out.email = null;
    } else if (typeof b.email === "string") {
      const e = b.email.trim().toLowerCase();
      if (e !== "" && !EMAIL_RE.test(e)) return { error: "contact.email inválido." };
      out.email = e === "" ? null : e;
    } else {
      return { error: "contact.email inválido." };
    }
  }
  if (b.phone !== undefined) {
    if (b.phone === null) {
      out.phone = null;
    } else if (typeof b.phone === "string") {
      // Falha alto: um telefone que não normaliza torna o contato
      // inalcançável no WhatsApp sem nenhum sinal. Ver parseContactPhoneInput.
      const parsed = parseContactPhoneInput(b.phone);
      if (!parsed.ok) return { error: `contact.phone: ${parsed.reason}` };
      out.phone = parsed.value;
    } else {
      return { error: "contact.phone inválido." };
    }
  }
  if (b.avatarUrl !== undefined) {
    if (b.avatarUrl === null) out.avatarUrl = null;
    else if (typeof b.avatarUrl === "string") out.avatarUrl = b.avatarUrl.trim();
    else return { error: "contact.avatarUrl inválido." };
  }
  if (b.leadScore !== undefined) {
    if (typeof b.leadScore !== "number" || !Number.isFinite(b.leadScore))
      return { error: "contact.leadScore inválido." };
    out.leadScore = b.leadScore;
  }
  if (b.lifecycleStage !== undefined) {
    if (typeof b.lifecycleStage !== "string" || !isValidLifecycleStage(b.lifecycleStage))
      return { error: "contact.lifecycleStage inválido." };
    out.lifecycleStage = b.lifecycleStage;
  }
  if (b.source !== undefined) {
    if (b.source === null) out.source = null;
    else if (typeof b.source === "string") out.source = b.source.trim();
    else return { error: "contact.source inválido." };
  }
  if (b.companyId !== undefined) {
    if (b.companyId === null) out.companyId = null;
    else if (typeof b.companyId === "string") out.companyId = b.companyId;
    else return { error: "contact.companyId inválido." };
  }
  if (b.assignedToId !== undefined) {
    if (b.assignedToId === null) out.assignedToId = null;
    else if (typeof b.assignedToId === "string") out.assignedToId = b.assignedToId;
    else return { error: "contact.assignedToId inválido." };
  }
  if (b.customFields !== undefined) {
    if (!Array.isArray(b.customFields)) return { error: "contact.customFields deve ser array." };
    out.customFields = b.customFields as CustomFieldInput[];
  }
  return out;
}

function parseDealPayload(input: unknown): DealPayload | { error: string } | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object") return { error: "deal inválido." };
  const b = input as Record<string, unknown>;
  if (typeof b.stageId !== "string" || b.stageId.trim() === "") {
    return { error: "deal.stageId é obrigatório quando 'deal' está presente." };
  }
  const out: DealPayload = { stageId: b.stageId.trim() };
  if (b.title !== undefined) {
    if (typeof b.title !== "string") return { error: "deal.title inválido." };
    out.title = b.title.trim();
  }
  if (b.value !== undefined) {
    if (typeof b.value !== "number" || !Number.isFinite(b.value))
      return { error: "deal.value inválido." };
    out.value = b.value;
  }
  if (b.status !== undefined) {
    if (typeof b.status !== "string" || !isValidDealStatus(b.status))
      return { error: "deal.status inválido." };
    out.status = b.status;
  }
  if (b.expectedClose !== undefined) {
    if (b.expectedClose === null) out.expectedClose = null;
    else if (typeof b.expectedClose === "string") {
      const d = new Date(b.expectedClose);
      if (Number.isNaN(d.getTime())) return { error: "deal.expectedClose inválido." };
      out.expectedClose = b.expectedClose;
    } else return { error: "deal.expectedClose inválido." };
  }
  if (b.ownerId !== undefined) {
    if (b.ownerId === null) out.ownerId = null;
    else if (typeof b.ownerId === "string") out.ownerId = b.ownerId;
    else return { error: "deal.ownerId inválido." };
  }
  if (b.position !== undefined) {
    if (typeof b.position !== "number" || !Number.isInteger(b.position) || b.position < 0)
      return { error: "deal.position inválido." };
    out.position = b.position;
  }
  if (b.customFields !== undefined) {
    if (!Array.isArray(b.customFields)) return { error: "deal.customFields deve ser array." };
    out.customFields = b.customFields as CustomFieldInput[];
  }
  return out;
}

/**
 * POST /api/leads — entrada **atômica** de lead para integrações (n8n).
 *
 * Faz "lead-or-create" em uma única chamada:
 *   1. Lookup do contato (id → phone → email). Se existir, **reusa**; senão **cria**.
 *   2. Atualiza campos básicos do contato quando o payload trouxer valores novos.
 *   3. Upsert dos `contactCustomFields` (resolve por `fieldId` ou `name`).
 *   4. (opcional) Cria deal no `stageId` informado, encadeia `customFields` do deal
 *      e dispara o trigger `deal_created`.
 *
 * Idempotência por phone/email: a mesma requisição rodando duas vezes não cria
 * dois contatos para o mesmo telefone. Deal sempre é criado novo — se quiser
 * deduplicar, peça `GET /api/deals?contactPhone=...` antes.
 *
 * Permissões exigidas:
 *   - `contact:create` (sempre);
 *   - `deal:create` + scope da stage quando o bloco `deal` está presente.
 */
export async function POST(request: Request) {
  let authResult: Awaited<ReturnType<typeof authenticateApiRequest>>;
  try {
    authResult = await authenticateApiRequest(request);
  } catch (e) {
    console.error("[POST /api/leads] erro autenticando:", e);
    return NextResponse.json({ message: "Erro interno." }, { status: 500 });
  }
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
    const root = body as Record<string, unknown>;

    const contactRaw = root.contact ?? root;
    const contact = parseContactPayload(contactRaw);
    if ("error" in contact) {
      return NextResponse.json({ message: contact.error }, { status: 400 });
    }

    const dealRaw = root.deal;
    const deal = parseDealPayload(dealRaw);
    if (deal && "error" in deal) {
      return NextResponse.json({ message: deal.error }, { status: 400 });
    }

    const options = parseLeadOptions(root.options);

    const denied = await requirePermissionForUser(authResult.user, "contact:create");
    if (denied) return denied;
    let stagePipelineId: string | null = null;
    if (deal) {
      const dealDenied = await requirePermissionForUser(authResult.user, "deal:create");
      if (dealDenied) return dealDenied;
      const stageDenied = await requireStageScope(authResult.user, "move", deal.stageId);
      if (stageDenied) return stageDenied;

      const orgId = getOrgIdOrThrow();
      const stageExists = await prisma.stage.findFirst({
        where: { id: deal.stageId, pipeline: { organizationId: orgId } },
        select: { id: true, pipelineId: true },
      });
      if (!stageExists) {
        return NextResponse.json(
          { message: "deal.stageId não encontrado nesta organização." },
          { status: 400 },
        );
      }
      stagePipelineId = stageExists.pipelineId;
    }

    try {
      const existing = await findExistingContact({
        id: contact.id,
        phone: contact.phone ?? undefined,
        email: contact.email ?? undefined,
      });

      let contactId: string;
      let contactCreated: boolean;

      if (existing) {
        contactId = existing.id;
        contactCreated = false;
        const updates = {
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          avatarUrl: contact.avatarUrl,
          leadScore: contact.leadScore,
          lifecycleStage: contact.lifecycleStage,
          source: contact.source,
          companyId: contact.companyId,
          assignedToId: contact.assignedToId,
        };

        if (options.fillEmptyContactFieldsOnly) {
          const current = await prisma.contact.findUnique({
            where: { id: contactId },
            select: {
              name: true,
              email: true,
              phone: true,
              avatarUrl: true,
              lifecycleStage: true,
              source: true,
              companyId: true,
              assignedToId: true,
            },
          });
          if (current) {
            // `leadScore` fica de fora de propósito: é numérico e 0 é valor
            // legítimo, então "vazio" não significa nada — quem manda score
            // quer atualizá-lo.
            if (!isBlank(current.name)) updates.name = undefined;
            if (!isBlank(current.email)) updates.email = undefined;
            if (!isBlank(current.phone)) updates.phone = undefined;
            if (!isBlank(current.avatarUrl)) updates.avatarUrl = undefined;
            if (!isBlank(current.lifecycleStage)) updates.lifecycleStage = undefined;
            if (!isBlank(current.source)) updates.source = undefined;
            if (!isBlank(current.companyId)) updates.companyId = undefined;
            if (!isBlank(current.assignedToId)) updates.assignedToId = undefined;
          }
        }

        const hasUpdates = Object.values(updates).some((v) => v !== undefined);
        if (hasUpdates) {
          await updateContact(contactId, updates);
        }
      } else {
        if (!contact.name) {
          return NextResponse.json(
            { message: "contact.name é obrigatório ao criar novo contato." },
            { status: 400 },
          );
        }
        const created = await createContact({
          name: contact.name,
          email: contact.email ?? undefined,
          phone: contact.phone ?? undefined,
          avatarUrl: contact.avatarUrl ?? undefined,
          leadScore: contact.leadScore,
          lifecycleStage: contact.lifecycleStage,
          source: contact.source ?? undefined,
          companyId: contact.companyId ?? undefined,
          assignedToId: contact.assignedToId ?? undefined,
        });
        contactId = created.id;
        contactCreated = true;
      }

      const missingFields: { contact: string[]; deal: string[] } = { contact: [], deal: [] };
      if (contact.customFields && contact.customFields.length > 0) {
        const r = await resolveCustomFields("contact", contact.customFields);
        missingFields.contact = r.missing;
        if (r.resolved.length > 0) {
          await upsertContactCustomFieldValues(contactId, r.resolved);
        }
      }

      let dealResult: CreateDealResult | null = null;
      let dealCreated = false;
      let dealReused = false;
      if (deal) {
        // Reaproveitamento: a origem pode mandar o mesmo lead duas vezes
        // (lista com duplicata, retry, dois ramos do mesmo workflow). Sem
        // isso, cada chamada cria um negócio novo e o kanban duplica.
        if (options.reuseOpenDeal && stagePipelineId) {
          const openDeal = await findOpenDealForContactInPipeline(
            contactId,
            stagePipelineId,
          );
          if (openDeal) {
            dealResult = openDeal;
            dealReused = true;
          }
        }
      }

      if (deal && !dealReused) {
        const fallbackTitle =
          deal.title && deal.title.trim()
            ? deal.title.trim()
            : `Lead - ${contact.name ?? "novo contato"}`;
        dealResult = await prisma.$transaction(async (tx) => {
          const created = await createDealTx(tx, {
            title: fallbackTitle,
            stageId: deal.stageId,
            value: deal.value,
            status:
              deal.status && isValidDealStatus(deal.status) ? deal.status : undefined,
            expectedClose:
              deal.expectedClose === undefined ? undefined : deal.expectedClose,
            position: deal.position,
            contactId,
            ownerId: deal.ownerId === undefined ? undefined : deal.ownerId,
          });
          await createDealEventTx(
            tx,
            created.id,
            authResult.user.id,
            "CREATED",
            {
              stageId: deal.stageId,
              via: "api/leads",
              source: contact.source ?? null,
            },
          );
          return created;
        });
        dealCreated = true;

        fireTrigger("deal_created", {
          dealId: dealResult.id,
          contactId,
          data: { stageId: deal.stageId, toStageId: deal.stageId },
        }).catch(() => {});
      }

      // Campos personalizados valem para os dois casos: no negócio
      // reaproveitado eles atualizam o que a origem trouxe de novo, sem
      // recriar o registro.
      if (deal && dealResult && deal.customFields && deal.customFields.length > 0) {
        const r = await resolveCustomFields("deal", deal.customFields);
        missingFields.deal = r.missing;
        if (r.resolved.length > 0) {
          await upsertDealCustomFieldValues(dealResult.id, r.resolved);
        }
      }

      // NB (jul/26): NÃO criamos mais Conversation WhatsApp antecipadamente ao
      // nascer o lead. Isso poluía a fila com conversas OPEN sem nenhuma
      // mensagem. A conversa é criada sob demanda — com `channelId` resolvido
      // no momento — nos caminhos de envio: abrir chat (skipSend em
      // /api/conversations/create), inbound (webhook Meta) e automação
      // (resolveAutomationSendConv → ensureWhatsAppConversationForContact).

      const finalContact = await prisma.contact.findUnique({
        where: { id: contactId },
        include: {
          company: { select: { id: true, name: true, domain: true } },
          tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
          assignedTo: { select: { id: true, name: true, email: true, avatarUrl: true, role: true } },
        },
      });

      return NextResponse.json(
        {
          contact: finalContact,
          contactCreated,
          deal: dealResult,
          dealCreated,
          dealReused,
          missingCustomFields:
            missingFields.contact.length > 0 || missingFields.deal.length > 0
              ? missingFields
              : undefined,
        },
        { status: dealCreated || contactCreated ? 201 : 200 },
      );
    } catch (err: unknown) {
      console.error("[POST /api/leads] erro:", err);
      if (typeof err === "object" && err !== null && "code" in err) {
        const code = (err as { code: string }).code;
        if (code === "P2002") {
          return NextResponse.json(
            { message: "Violação de unicidade ao gravar lead." },
            { status: 409 },
          );
        }
        if (code === "P2003") {
          return NextResponse.json(
            { message: "Referência inválida (stage, contato ou responsável)." },
            { status: 400 },
          );
        }
      }
      if (err instanceof Error && err.message === "INVALID_TITLE") {
        return NextResponse.json({ message: "Título do deal inválido." }, { status: 400 });
      }
      return NextResponse.json({ message: "Erro ao criar lead." }, { status: 500 });
    }
  });
}
