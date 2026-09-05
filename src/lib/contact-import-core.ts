/**
 * Núcleo de processamento de importação de contatos — compartilhado entre a
 * rota síncrona (legado) e o etl-worker (assíncrono).
 *
 * Todas as funções dependem de RequestContext ativo (getOrgIdOrThrow + prisma
 * scoped). Na rota isso vem de `enterRequestContext`; no worker, de
 * `withSystemContext(organizationId)`.
 */

import {
  attachTagToContact,
  findContactIdByEmailCI,
  findUserIdByEmailCI,
} from "@/lib/import-helpers";
// ETL: roda no pool dedicado de import (lock_timeout=3s, pool max=4) —
// ver src/lib/prisma-import.ts. O nome `prisma` é mantido para não
// reescrever o corpo do arquivo.
import { prismaImportScoped as prisma } from "@/lib/prisma-import";
import { getOrgIdOrThrow } from "@/lib/request-context";
import {
  createContact,
  findContactIdByPhone,
  isValidLifecycleStage,
  updateContact,
} from "@/services/contacts";
import { upsertContactCustomFieldValues } from "@/services/custom-fields";
import { pickTrackingFromImportRow } from "@/lib/contact-tracking-fields";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ContactRowResult =
  | { status: "created" | "updated" | "skipped" }
  | { status: "failed"; message: string };

export type ContactImportOptions = {
  updateExisting: boolean;
  importTagId: string | null;
  /**
   * Mapa cabeçalho-normalizado → id do CustomField (entity "contact").
   * Quando presente, colunas que casam com um campo personalizado existente
   * têm seus valores gravados via upsertContactCustomFieldValues. Construído
   * uma vez por importação com `buildCustomFieldHeaderMap`.
   */
  customFieldHeaderMap?: Map<string, string>;
};

/**
 * Normaliza um texto para o mesmo formato dos cabeçalhos do parser
 * (minúsculas, espaços/hífens → "_"). Usado para casar nome/label de
 * CustomField com a coluna do arquivo.
 */
export function normalizeHeaderKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
}

/**
 * Cabeçalhos reservados aos campos padrão do contato. Um CustomField com
 * o mesmo nome NÃO sombreia a coluna padrão (ex.: um campo "email").
 */
const RESERVED_HEADERS = new Set<string>([
  "id",
  "name",
  "email",
  "phone",
  "avatar_url",
  "avatarurl",
  "source",
  "lead_score",
  "leadscore",
  "score",
  "lifecycle_stage",
  "lifecyclestage",
  "lifecycle",
  "company",
  "company_id",
  "companyid",
  "assigned_to_id",
  "assignedtoid",
  "owner_id",
  "ownertoid",
  "assigned_to_email",
  "assignedtoemail",
  "owner_email",
  "owneremail",
  "external_id",
  "externalid",
  "kommo_contact_id",
  "contact_external_id",
  // Informação rastreada (UTM / click IDs)
  "utm_source",
  "ad_utm_source",
  "utm_medium",
  "ad_utm_medium",
  "utm_campaign",
  "ad_utm_campaign",
  "utm_content",
  "ad_utm_content",
  "utm_term",
  "ad_utm_term",
  "utm_id",
  "utm_referrer",
  "referrer",
  "gclid",
  "fbclid",
  "gclientid",
  "google_client_id",
  "ttad_id",
  "ttad_name",
]);

/**
 * Monta o mapa cabeçalho → id do CustomField a partir das definições de
 * campos personalizados (entity "contact") e dos cabeçalhos do arquivo.
 * Casa por `name` e por `label` (ambos normalizados). Ignora cabeçalhos
 * reservados a campos padrão.
 */
export function buildCustomFieldHeaderMap(
  headers: string[],
  defs: Array<{ id: string; name: string; label?: string | null }>,
  reserved: Set<string> = RESERVED_HEADERS,
): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const d of defs) {
    const nameKey = normalizeHeaderKey(d.name);
    if (nameKey) byKey.set(nameKey, d.id);
    if (d.label) {
      const labelKey = normalizeHeaderKey(d.label);
      // `name` tem prioridade — só usa label se ainda não mapeado.
      if (labelKey && !byKey.has(labelKey)) byKey.set(labelKey, d.id);
    }
  }

  const byId = new Set(defs.map((d) => d.id));

  const map = new Map<string, string>();
  for (const h of headers) {
    // Coluna mapeada explicitamente pelo frontend como `cf:<fieldId>`.
    const cfMatch = /^cf:(.+)$/.exec(h);
    if (cfMatch) {
      const id = cfMatch[1];
      if (byId.has(id)) map.set(h, id);
      continue;
    }
    if (reserved.has(h)) continue;
    // Casamento por nome/label normalizado (uploads diretos sem remapeamento).
    const fieldId = byKey.get(h);
    if (fieldId) map.set(h, fieldId);
  }
  return map;
}

/** Grava os valores de campos personalizados do contato a partir da linha. */
async function applyContactCustomFields(
  contactId: string,
  row: Record<string, string>,
  map: Map<string, string> | undefined,
): Promise<void> {
  if (!map || map.size === 0) return;
  const values: { fieldId: string; value: string }[] = [];
  for (const [header, fieldId] of map) {
    const raw = row[header]?.trim();
    if (raw) values.push({ fieldId, value: raw });
  }
  if (values.length > 0) {
    await upsertContactCustomFieldValues(contactId, values);
  }
}

function hasColumn(headers: string[], ...names: string[]) {
  return names.some((n) => headers.includes(n));
}

/** Valida que o arquivo tem ao menos a coluna `name`. Retorna msg de erro ou null. */
export function validateContactImportHeaders(headers: string[]): string | null {
  if (headers.length === 0 || !headers.includes("name")) {
    return 'Arquivo inválido: é necessária uma coluna "name".';
  }
  return null;
}

function pickContactExternalId(
  headers: string[],
  row: Record<string, string>,
): string | null | undefined {
  if (
    !hasColumn(
      headers,
      "external_id",
      "externalid",
      "kommo_contact_id",
      "contact_external_id",
    )
  ) {
    return undefined;
  }
  const v =
    row.external_id?.trim() ||
    row.externalid?.trim() ||
    row.kommo_contact_id?.trim() ||
    row.contact_external_id?.trim() ||
    "";
  return v === "" ? null : v;
}

async function resolveCompanyId(
  row: Record<string, string>,
): Promise<string | undefined> {
  const direct = row.company_id?.trim() || row.companyid?.trim();
  if (direct) return direct;

  const name = row.company?.trim();
  if (!name) return undefined;

  const found = await prisma.company.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  return found?.id;
}

async function resolveAssignedToId(
  row: Record<string, string>,
): Promise<string | undefined> {
  const id =
    row.assigned_to_id?.trim() ||
    row.assignedtoid?.trim() ||
    row.owner_id?.trim() ||
    row.ownertoid?.trim();
  if (id) return id;

  const emailRaw =
    row.assigned_to_email?.trim() ||
    row.assignedtoemail?.trim() ||
    row.owner_email?.trim() ||
    row.owneremail?.trim();
  if (!emailRaw) return undefined;
  // Usa lower(email) via índice funcional (idx_users_lower_email).
  return (await findUserIdByEmailCI(emailRaw)) ?? undefined;
}

type UpsertTarget =
  | { mode: "update"; id: string }
  | { mode: "create"; id?: string; externalId?: string | null };

async function resolveContactUpsert(
  row: Record<string, string>,
): Promise<
  { ok: true; target: UpsertTarget } | { ok: false; message: string }
> {
  const id = row.id?.trim();
  const ext =
    row.external_id?.trim() ||
    row.externalid?.trim() ||
    row.kommo_contact_id?.trim() ||
    row.contact_external_id?.trim();

  if (id && ext) {
    const orgId = getOrgIdOrThrow();
    const [byId, byExt] = await Promise.all([
      prisma.contact.findUnique({ where: { id }, select: { id: true } }),
      prisma.contact.findUnique({
        where: {
          organizationId_externalId: { organizationId: orgId, externalId: ext },
        },
        select: { id: true },
      }),
    ]);
    if (byId && byExt && byId.id !== byExt.id) {
      return { ok: false, message: "id e external_id referem contatos diferentes." };
    }
    if (byId) return { ok: true, target: { mode: "update", id: byId.id } };
    if (byExt) return { ok: true, target: { mode: "update", id: byExt.id } };
    return { ok: true, target: { mode: "create", id, externalId: ext } };
  }

  if (id) {
    const c = await prisma.contact.findUnique({ where: { id }, select: { id: true } });
    if (c) return { ok: true, target: { mode: "update", id: c.id } };
    return { ok: true, target: { mode: "create", id, externalId: ext ?? undefined } };
  }

  if (ext) {
    const orgId = getOrgIdOrThrow();
    const c = await prisma.contact.findUnique({
      where: {
        organizationId_externalId: { organizationId: orgId, externalId: ext },
      },
      select: { id: true },
    });
    if (c) return { ok: true, target: { mode: "update", id: c.id } };
    return { ok: true, target: { mode: "create", externalId: ext } };
  }

  const email = row.email?.trim();
  if (email) {
    // Usa lower(email) via índice funcional (idx_contacts_org_lower_email).
    const foundId = await findContactIdByEmailCI(email);
    if (foundId) return { ok: true, target: { mode: "update", id: foundId } };
  }

  const phone = row.phone?.trim();
  if (phone) {
    const orgId = getOrgIdOrThrow();
    // Match por variantes E.164 (com/sem 9º dígito) em vez de igualdade
    // literal — deduplica contatos importados com formatos diferentes.
    const foundId = await findContactIdByPhone(orgId, phone);
    if (foundId) return { ok: true, target: { mode: "update", id: foundId } };
  }

  return { ok: true, target: { mode: "create" } };
}

/**
 * Processa uma única linha do arquivo de importação. Faz validação,
 * resolução de empresa/responsável e upsert do contato. Idempotente por
 * (id / external_id / email / phone). Nunca lança — devolve `failed` com a
 * mensagem para acumular em `BulkOperation.errors`.
 */
export async function processContactRow(
  headers: string[],
  row: Record<string, string>,
  opts: ContactImportOptions,
): Promise<ContactRowResult> {
  const name = row.name?.trim();
  if (!name) return { status: "failed", message: "Nome vazio." };

  const emailRaw = row.email?.trim();
  if (emailRaw && !EMAIL_RE.test(emailRaw.toLowerCase())) {
    return { status: "failed", message: "E-mail inválido." };
  }

  const lifecycleRaw =
    row.lifecycle_stage?.trim() ||
    row.lifecyclestage?.trim() ||
    row.lifecycle?.trim();
  if (lifecycleRaw && !isValidLifecycleStage(lifecycleRaw)) {
    return { status: "failed", message: "Estágio do ciclo inválido." };
  }

  let leadScore: number | undefined;
  const ls = row.lead_score?.trim() || row.leadscore?.trim() || row.score?.trim();
  if (ls) {
    const n = Number.parseInt(ls, 10);
    if (!Number.isFinite(n)) return { status: "failed", message: "leadScore inválido." };
    leadScore = n;
  }

  let companyId: string | undefined;
  try {
    companyId = await resolveCompanyId(row);
  } catch {
    return { status: "failed", message: "Erro ao resolver empresa." };
  }

  let assignedToId: string | undefined;
  try {
    assignedToId = await resolveAssignedToId(row);
  } catch {
    return { status: "failed", message: "Erro ao resolver responsável." };
  }

  const resolved = await resolveContactUpsert(row);
  if (!resolved.ok) return { status: "failed", message: resolved.message };

  const externalPatch = pickContactExternalId(headers, row);

  const basePayload = {
    name,
    email: emailRaw ? emailRaw.toLowerCase() : undefined,
    phone: row.phone?.trim() || undefined,
    avatarUrl: row.avatar_url?.trim() || row.avatarurl?.trim() || undefined,
    source: row.source?.trim() || undefined,
    leadScore,
    lifecycleStage:
      lifecycleRaw && isValidLifecycleStage(lifecycleRaw) ? lifecycleRaw : undefined,
    companyId: companyId ?? undefined,
    assignedToId,
    ...pickTrackingFromImportRow(row),
  };

  try {
    let contactId: string | null = null;
    if (resolved.target.mode === "update") {
      if (!opts.updateExisting) {
        if (opts.importTagId) await attachTagToContact(resolved.target.id, opts.importTagId);
        return { status: "skipped" };
      }
      await updateContact(resolved.target.id, {
        ...basePayload,
        ...(externalPatch !== undefined ? { externalId: externalPatch } : {}),
      });
      contactId = resolved.target.id;
      if (opts.importTagId && contactId) await attachTagToContact(contactId, opts.importTagId);
      await applyContactCustomFields(contactId, row, opts.customFieldHeaderMap);
      return { status: "updated" };
    }

    let externalForCreate: string | null | undefined = undefined;
    if (externalPatch !== undefined) {
      externalForCreate = externalPatch;
    } else if (
      resolved.target.mode === "create" &&
      resolved.target.externalId !== undefined
    ) {
      externalForCreate = resolved.target.externalId;
    }
    const c = await createContact({
      ...(resolved.target.id ? { id: resolved.target.id } : {}),
      externalId: externalForCreate === undefined ? undefined : externalForCreate,
      ...basePayload,
    });
    contactId = (c as { id?: string })?.id ?? null;
    if (opts.importTagId && contactId) await attachTagToContact(contactId, opts.importTagId);
    if (contactId) await applyContactCustomFields(contactId, row, opts.customFieldHeaderMap);
    return { status: "created" };
  } catch (e: unknown) {
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? String((e as { code: string }).code)
        : "";
    const msg =
      code === "P2002"
        ? "Violação de unicidade (e-mail/telefone/id externo duplicado)."
        : code === "P2003"
          ? "Referência inválida (empresa ou usuário)."
          : "Erro ao salvar contato.";
    return { status: "failed", message: msg };
  }
}
