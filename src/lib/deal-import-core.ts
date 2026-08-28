import { buildCustomFieldHeaderMap } from "@/lib/contact-import-core";
import {
  attachTagToDeal,
  findContactIdByEmailCI,
  findUserIdByEmailCI,
} from "@/lib/import-helpers";
// ETL: roda no pool dedicado de import (lock_timeout=3s, pool max=4) —
// ver src/lib/prisma-import.ts. O nome `prisma` é mantido para não
// reescrever o corpo do arquivo.
import { prismaImportScoped as prisma } from "@/lib/prisma-import";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { createContact, updateContact } from "@/services/contacts";
import { upsertDealCustomFieldValues } from "@/services/custom-fields";
import { createDeal, isValidDealStatus, updateDeal } from "@/services/deals";

/**
 * Núcleo de processamento do import de NEGÓCIOS — compartilhado entre a rota
 * (validação/enqueue) e o job assíncrono (etl-worker) que processa as linhas.
 *
 * Extraído de `app/api/deals/import/route.ts` (antes síncrono no request HTTP)
 * como parte do T3/M1. As funções de resolução (stage/owner/contact) são
 * "cache-aware" (T4): consultam primeiro os Maps pré-carregados por chunk e só
 * caem no banco em caso de miss/criação — reduzindo drasticamente o N+1 por
 * linha. O cache é apenas otimização: um miss preserva o comportamento original.
 */

/** Cabeçalhos padrão do negócio — não viram campo personalizado por nome. */
export const DEAL_RESERVED_HEADERS = new Set<string>([
  "id",
  "external_id",
  "externalid",
  "kommo_lead_id",
  "lead_external_id",
  // Kommo exporta o ID do lead como "id deal" (vira `id_deal` após normalização
  // do header). Tratamos como sinônimo de external_id para permitir o match
  // por chave técnica na atualização (sem esse alias, todo import Kommo caía
  // em criação, gerando duplicidades sem contactId — ver incidente 2026-07-29).
  "id_deal",
  "iddeal",
  "deal_number",
  "title",
  "value",
  "status",
  "pipeline",
  "pipeline_name",
  "stage",
  "stage_name",
  "stage_id",
  "stageid",
  "contact_id",
  "contactid",
  "contact_name",
  "contactname",
  "contact",
  "contact_email",
  "contactemail",
  "contact_phone",
  "contactphone",
  "contact_external_id",
  "contact_externalid",
  "kommo_contact_id",
  "owner_id",
  "ownertoid",
  "owner_email",
  "owneremail",
  "expected_close",
  "expectedclose",
  "lost_reason",
  "lostreason",
]);

export type DealImportOptions = {
  updateExisting: boolean;
  importTagId: string | null;
  dealCustomFieldMap?: Map<string, string>;
  /**
   * Permitir criar negócios novos quando a linha não casar com nenhum existente.
   * Ausente/`true` = comportamento histórico (upsert). `false` = modo "somente
   * atualizar": linhas sem match viram `skipped`. Ver `readImportModeFlag`.
   */
  allowCreate?: boolean;
  /**
   * Permitir atualizar negócios existentes quando a linha casar. Ausente cai
   * em `updateExisting` (compat retroativa). `false` = modo "somente criar".
   */
  allowUpdate?: boolean;
};

export type DealRowResult =
  | { status: "created" | "updated" | "skipped" }
  | { status: "failed"; message: string };

/**
 * Cache de lookups pré-carregado por chunk (T4). Reduz o N+1 por linha:
 *   - stages: carregados 1x para a org inteira (poucas linhas).
 *   - owners: resolvidos em lote por e-mail antes do loop.
 *   - contatos: pré-carregados por chunk (externalId/email/phone via IN).
 * Criações no meio do chunk são memoizadas para as linhas seguintes.
 */
export type DealImportCache = {
  stagesLoaded: boolean;
  stageById: Set<string>;
  /** key = `${lower(pipeline)}\u0000${lower(stage)}` → stageId */
  stageByKey: Map<string, string>;
  /** lower(email) → userId | null (null memoiza "não existe") */
  ownerByEmail: Map<string, string | null>;
  contactByExternalId: Map<string, string>;
  /** lower(email) → contactId */
  contactByEmail: Map<string, string>;
  contactByPhone: Map<string, string>;
  /**
   * stageId → próxima `position` a usar num deal CRIADO naquele estágio.
   * Resolvido 1× por estágio (MAX(position)) e incrementado em memória —
   * sem isso cada linha criada rodava um aggregate por linha (2.852 calls
   * num import de 5 mil linhas, stress sa221601). Posição é float de
   * ordenação (sem unique): dois imports concorrentes no mesmo estágio
   * podem empatar posição — empate de ordenação tolerável, sem violação.
   */
  nextPositionByStage: Map<string, number>;
};

export function newDealImportCache(): DealImportCache {
  return {
    stagesLoaded: false,
    stageById: new Set(),
    stageByKey: new Map(),
    ownerByEmail: new Map(),
    contactByExternalId: new Map(),
    contactByEmail: new Map(),
    contactByPhone: new Map(),
    nextPositionByStage: new Map(),
  };
}

/**
 * Próxima `position` livre do estágio para criação em lote. O MAX vai ao
 * banco 1× por estágio por import; as demais linhas incrementam em memória.
 */
async function takeNextStagePosition(
  stageId: string,
  cache: DealImportCache,
): Promise<number> {
  const cached = cache.nextPositionByStage.get(stageId);
  if (cached !== undefined) {
    cache.nextPositionByStage.set(stageId, cached + 1);
    return cached;
  }
  const agg = await prisma.deal.aggregate({
    where: { stageId },
    _max: { position: true },
  });
  const next = (agg._max.position ?? -1) + 1;
  cache.nextPositionByStage.set(stageId, next + 1);
  return next;
}

const stageKey = (pipeline: string, stage: string) =>
  `${pipeline.trim().toLowerCase()}\u0000${stage.trim().toLowerCase()}`;

/**
 * Pré-carrega TODAS as stages da org no cache (1 query). Chamar 1x antes de
 * processar as linhas — a org tem poucas stages, então cabe em memória e
 * elimina o lookup de stage por linha.
 */
export async function preloadStages(cache: DealImportCache): Promise<void> {
  if (cache.stagesLoaded) return;
  const stages = await prisma.stage.findMany({
    select: { id: true, name: true, pipeline: { select: { name: true } } },
  });
  for (const s of stages) {
    cache.stageById.add(s.id);
    const pn = s.pipeline?.name ?? "";
    if (pn && s.name) cache.stageByKey.set(stageKey(pn, s.name), s.id);
  }
  cache.stagesLoaded = true;
}

/** Pré-resolve owners por e-mail em lote (1 query) e memoiza no cache. */
export async function preloadOwnersByEmail(
  emails: string[],
  cache: DealImportCache,
): Promise<void> {
  const norm = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]
    .filter((e) => !cache.ownerByEmail.has(e));
  if (norm.length === 0) return;
  const rows = await prisma.$queryRaw<{ id: string; le: string }[]>`
    SELECT id, lower(email) AS le FROM users WHERE lower(email) = ANY(${norm})
  `;
  const found = new Map(rows.map((r) => [r.le, r.id]));
  for (const e of norm) cache.ownerByEmail.set(e, found.get(e) ?? null);
}

/**
 * Pré-carrega contatos de um chunk por externalId/email/phone (3 queries) e
 * memoiza no cache. Emails usam lower(email) via índice funcional.
 */
export async function preloadContactsForChunk(
  rows: Record<string, string>[],
  cache: DealImportCache,
): Promise<void> {
  const orgId = getOrgIdOrThrow();

  const exts = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const row of rows) {
    const ext =
      row.contact_external_id?.trim() ||
      row.contact_externalid?.trim() ||
      row.kommo_contact_id?.trim();
    if (ext && !cache.contactByExternalId.has(ext)) exts.add(ext);
    const email = (row.contact_email?.trim() || row.contactemail?.trim() || "").toLowerCase();
    if (email && !cache.contactByEmail.has(email)) emails.add(email);
    const phone = row.contact_phone?.trim() || row.contactphone?.trim() || "";
    if (phone && !cache.contactByPhone.has(phone)) phones.add(phone);
  }

  if (exts.size > 0) {
    const found = await prisma.contact.findMany({
      where: { externalId: { in: [...exts] } },
      select: { id: true, externalId: true },
    });
    for (const c of found) if (c.externalId) cache.contactByExternalId.set(c.externalId, c.id);
  }

  if (emails.size > 0) {
    const found = await prisma.$queryRaw<{ id: string; le: string }[]>`
      SELECT id, lower(email) AS le
      FROM contacts
      WHERE "organizationId" = ${orgId} AND lower(email) = ANY(${[...emails]})
    `;
    // Se houver mais de um contato com o mesmo e-mail, o primeiro vence
    // (mesma semântica conservadora do lookup original).
    for (const c of found) if (!cache.contactByEmail.has(c.le)) cache.contactByEmail.set(c.le, c.id);
  }

  if (phones.size > 0) {
    const found = await prisma.contact.findMany({
      where: { phone: { in: [...phones] } },
      select: { id: true, phone: true },
    });
    for (const c of found) if (c.phone && !cache.contactByPhone.has(c.phone)) {
      cache.contactByPhone.set(c.phone, c.id);
    }
  }
}

/** Colunas aceitas como identificador único do deal (para match no upsert). */
const DEAL_IDENTIFIER_HEADERS = [
  "id",
  "deal_number",
  "external_id",
  "externalid",
  "kommo_lead_id",
  "lead_external_id",
  "id_deal",
  "iddeal",
] as const;

export function validateDealImportHeaders(
  headers: string[],
  opts?: { allowCreate?: boolean },
): string | null {
  if (headers.length === 0) {
    return "CSV sem colunas de cabeçalho.";
  }

  // Modo "somente atualizar": não vamos criar nada, então `title`/`stage` são
  // supérfluos — basta uma coluna identificadora para achar o deal existente.
  // Cobre o caso Kommo: CSV enxuto `id deal;titulo` + tag em lote.
  const allowCreate = opts?.allowCreate ?? true;
  if (!allowCreate) {
    const hasIdentifier = DEAL_IDENTIFIER_HEADERS.some((h) => headers.includes(h));
    if (!hasIdentifier) {
      return 'Modo "somente atualizar": inclua ao menos uma coluna identificadora do negócio (id, deal_number, external_id, id_deal ou variantes).';
    }
    return null;
  }

  if (!headers.includes("title")) {
    return 'CSV inválido: coluna "title" obrigatória. Informe "stage_id" ou "pipeline_name" + "stage_name".';
  }
  const hasStage = headers.includes("stage_id") || headers.includes("stageid");
  const hasPipelineStage =
    (headers.includes("pipeline_name") || headers.includes("pipeline")) &&
    (headers.includes("stage_name") || headers.includes("stage"));
  if (!hasStage && !hasPipelineStage) {
    return 'Inclua "stage_id" (recomendado) ou o par "pipeline_name" + "stage_name" para localizar o estágio.';
  }
  return null;
}

/** Monta o mapa coluna→customFieldId de negócio (entity "deal"). */
export async function buildDealCustomFieldMap(
  headers: string[],
  defs: Array<{ id: string; name: string; label?: string | null }>,
): Promise<Map<string, string> | undefined> {
  const map = buildCustomFieldHeaderMap(headers, defs, DEAL_RESERVED_HEADERS);
  return map.size > 0 ? map : undefined;
}

async function applyDealCustomFields(
  dealId: string,
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
    await upsertDealCustomFieldValues(dealId, values);
  }
}

function hasColumn(headers: string[], ...names: string[]) {
  return names.some((n) => headers.includes(n));
}

function pickDealExternalId(
  headers: string[],
  row: Record<string, string>,
): string | null | undefined {
  if (
    !hasColumn(
      headers,
      "external_id",
      "externalid",
      "kommo_lead_id",
      "lead_external_id",
      "id_deal",
      "iddeal",
    )
  ) {
    return undefined;
  }
  const v =
    row.external_id?.trim() ||
    row.externalid?.trim() ||
    row.kommo_lead_id?.trim() ||
    row.lead_external_id?.trim() ||
    row.id_deal?.trim() ||
    row.iddeal?.trim() ||
    "";
  return v === "" ? null : v;
}

async function resolveOwnerId(
  row: Record<string, string>,
  cache: DealImportCache,
): Promise<string | undefined> {
  const id = row.owner_id?.trim() || row.ownertoid?.trim();
  if (id) return id;

  const emailRaw = row.owner_email?.trim() || row.owneremail?.trim();
  if (!emailRaw) return undefined;
  const le = emailRaw.trim().toLowerCase();
  if (cache.ownerByEmail.has(le)) return cache.ownerByEmail.get(le) ?? undefined;
  // Miss no cache: resolve via índice funcional e memoiza.
  const found = (await findUserIdByEmailCI(emailRaw)) ?? null;
  cache.ownerByEmail.set(le, found);
  return found ?? undefined;
}

async function resolveStageId(
  row: Record<string, string>,
  cache: DealImportCache,
): Promise<string | null> {
  const sid = row.stage_id?.trim() || row.stageid?.trim();
  if (sid) {
    if (cache.stageById.has(sid)) return sid;
    const s = await prisma.stage.findUnique({ where: { id: sid }, select: { id: true } });
    if (s) cache.stageById.add(s.id);
    return s?.id ?? null;
  }

  const pn = row.pipeline_name?.trim() || row.pipeline?.trim();
  const sn = row.stage_name?.trim() || row.stage?.trim();
  if (pn && sn) {
    const key = stageKey(pn, sn);
    if (cache.stageByKey.has(key)) return cache.stageByKey.get(key)!;
    const stage = await prisma.stage.findFirst({
      where: {
        name: { equals: sn, mode: "insensitive" },
        pipeline: { name: { equals: pn, mode: "insensitive" } },
      },
      select: { id: true },
    });
    if (stage) cache.stageByKey.set(key, stage.id);
    return stage?.id ?? null;
  }

  return null;
}

async function resolveContactIdForDeal(
  row: Record<string, string>,
  updateExisting: boolean,
  cache: DealImportCache,
): Promise<string | undefined> {
  const contactName =
    row.contact_name?.trim() || row.contactname?.trim() || row.contact?.trim() || "";
  const contactEmail = row.contact_email?.trim() || row.contactemail?.trim() || "";
  const contactPhone = row.contact_phone?.trim() || row.contactphone?.trim() || "";

  const memoize = (id: string) => {
    if (contactEmail) cache.contactByEmail.set(contactEmail.toLowerCase(), id);
    if (contactPhone) cache.contactByPhone.set(contactPhone, id);
  };

  const syncContactFields = async (id: string) => {
    if (!updateExisting) return;
    const patch: Record<string, string> = {};
    if (contactName) patch.name = contactName;
    if (contactEmail) patch.email = contactEmail;
    if (contactPhone) patch.phone = contactPhone;
    if (Object.keys(patch).length === 0) return;
    try {
      await updateContact(id, patch);
    } catch {
      // Ignora P2002 (email/phone duplicado em outro contato): o link do deal
      // não deve falhar por uma atualização opcional do contato.
    }
  };

  const cid = row.contact_id?.trim() || row.contactid?.trim();
  if (cid) {
    const c = await prisma.contact.findUnique({ where: { id: cid }, select: { id: true } });
    if (c) {
      await syncContactFields(c.id);
      return c.id;
    }
  }

  const ext =
    row.contact_external_id?.trim() ||
    row.contact_externalid?.trim() ||
    row.kommo_contact_id?.trim();

  if (ext) {
    const cached = cache.contactByExternalId.get(ext);
    if (cached) {
      await syncContactFields(cached);
      return cached;
    }
    const orgId = getOrgIdOrThrow();
    const found = await prisma.contact.findUnique({
      where: { organizationId_externalId: { organizationId: orgId, externalId: ext } },
      select: { id: true },
    });
    if (found) {
      cache.contactByExternalId.set(ext, found.id);
      await syncContactFields(found.id);
      return found.id;
    }

    const created = await createContact({
      name: contactName || `Contato ${ext}`,
      ...(contactEmail ? { email: contactEmail } : {}),
      ...(contactPhone ? { phone: contactPhone } : {}),
      externalId: ext,
    });
    const createdId = (created as { id?: string })?.id;
    if (createdId) {
      cache.contactByExternalId.set(ext, createdId);
      memoize(createdId);
    }
    return createdId;
  }

  if (contactEmail) {
    const le = contactEmail.toLowerCase();
    const cached = cache.contactByEmail.get(le);
    if (cached) {
      await syncContactFields(cached);
      return cached;
    }
    const foundId = await findContactIdByEmailCI(contactEmail);
    if (foundId) {
      cache.contactByEmail.set(le, foundId);
      await syncContactFields(foundId);
      return foundId;
    }
  }
  if (contactPhone) {
    const cached = cache.contactByPhone.get(contactPhone);
    if (cached) {
      await syncContactFields(cached);
      return cached;
    }
    const orgId = getOrgIdOrThrow();
    const c = await prisma.contact.findFirst({
      where: { organizationId: orgId, phone: contactPhone },
      select: { id: true },
    });
    if (c) {
      cache.contactByPhone.set(contactPhone, c.id);
      await syncContactFields(c.id);
      return c.id;
    }
  }

  if (contactName || contactEmail || contactPhone) {
    const created = await createContact({
      name: contactName || contactEmail || contactPhone || "Contato sem nome",
      ...(contactEmail ? { email: contactEmail } : {}),
      ...(contactPhone ? { phone: contactPhone } : {}),
    });
    const createdId = (created as { id?: string })?.id;
    if (createdId) memoize(createdId);
    return createdId;
  }

  return undefined;
}

type DealUpsert =
  | { mode: "update"; id: string }
  | { mode: "create"; id?: string; externalId?: string | null };

async function resolveDealUpsert(
  row: Record<string, string>,
  ctx: { contactId?: string; stageId?: string | null; title?: string } = {},
): Promise<{ ok: true; target: DealUpsert } | { ok: false; message: string }> {
  const id = row.id?.trim();
  // `id_deal` (Kommo) é ambíguo: em orgs migradas do Kommo o valor foi copiado
  // para `deal.number` (identificador nativo do CRM); em orgs mais novas pode
  // ter sido gravado em `external_id`. Testamos AMBOS abaixo — number primeiro
  // (mais provável no legado Kommo, ver Cruzeiro EaD 2026-07-29) e external_id
  // como fallback. Ver DEAL_IDENTIFIER_HEADERS.
  const kommoIdRaw = row.id_deal?.trim() || row.iddeal?.trim() || "";
  const explicitExt =
    row.external_id?.trim() ||
    row.externalid?.trim() ||
    row.kommo_lead_id?.trim() ||
    row.lead_external_id?.trim() ||
    "";
  const ext = explicitExt || kommoIdRaw;
  const numRaw = row.deal_number?.trim() || (/^\d+$/.test(kommoIdRaw) ? kommoIdRaw : "");

  const orgId = getOrgIdOrThrow();

  // Precedência: id interno > deal_number (inclui id_deal numérico) > external_id.
  if (id) {
    const d = await prisma.deal.findUnique({ where: { id }, select: { id: true } });
    if (d) return { ok: true, target: { mode: "update", id: d.id } };
  }

  if (numRaw && /^\d+$/.test(numRaw)) {
    const d = await prisma.deal.findUnique({
      where: { organizationId_number: { organizationId: orgId, number: parseInt(numRaw, 10) } },
      select: { id: true },
    });
    if (d) return { ok: true, target: { mode: "update", id: d.id } };
  }

  if (ext) {
    const d = await prisma.deal.findUnique({
      where: { organizationId_externalId: { organizationId: orgId, externalId: ext } },
      select: { id: true },
    });
    if (d) return { ok: true, target: { mode: "update", id: d.id } };
  }

  if (ctx.contactId && ctx.title) {
    const d = await prisma.deal.findFirst({
      where: { organizationId: orgId, contactId: ctx.contactId, title: ctx.title },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (d) return { ok: true, target: { mode: "update", id: d.id } };
  }

  return {
    ok: true,
    target: {
      mode: "create",
      ...(id ? { id } : {}),
      ...(ext ? { externalId: ext } : {}),
    },
  };
}

function parseExpectedClose(raw: string | undefined): Date | null | undefined {
  if (!raw?.trim()) return undefined;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Processa UMA linha do CSV de negócios. Idempotente por precedência
 * id > deal_number > external_id (mantida). Retorna o resultado granular
 * (created/updated/skipped/failed) para o agregador de progresso.
 */
export async function processDealRow(
  headers: string[],
  row: Record<string, string>,
  opts: DealImportOptions,
  cache: DealImportCache,
): Promise<DealRowResult> {
  // Modo alvo (novo `importMode`) com fallback para `updateExisting` (compat).
  const allowUpdate = opts.allowUpdate ?? opts.updateExisting;
  const allowCreate = opts.allowCreate ?? true;

  // Título e estágio são obrigatórios APENAS para criar. Em update-only o CSV
  // pode trazer só o identificador do deal (ex.: Kommo `id deal` + tag). Se
  // vierem, são propagados para o update; se não, o deal existente mantém o
  // valor atual.
  const title = row.title?.trim() ?? "";
  const stageId = await resolveStageId(row, cache);

  const statusRaw = row.status?.trim()?.toUpperCase();
  if (statusRaw && !isValidDealStatus(statusRaw)) {
    return { status: "failed", message: "status inválido (OPEN, WON, LOST)." };
  }

  let value: number | undefined;
  const valRaw = row.value?.trim();
  if (valRaw) {
    const n = Number.parseFloat(valRaw.replace(",", "."));
    if (!Number.isFinite(n)) return { status: "failed", message: "value inválido." };
    value = n;
  }

  const expectedClose = parseExpectedClose(row.expected_close?.trim() || row.expectedclose?.trim());
  if (expectedClose === null) {
    return { status: "failed", message: "expected_close inválido." };
  }

  let ownerId: string | undefined;
  try {
    ownerId = await resolveOwnerId(row, cache);
  } catch {
    return { status: "failed", message: "Erro ao resolver proprietário." };
  }

  let contactId: string | undefined;
  try {
    contactId = await resolveContactIdForDeal(row, opts.updateExisting, cache);
  } catch {
    return { status: "failed", message: "Erro ao resolver contato." };
  }

  const resolved = await resolveDealUpsert(row, {
    ...(contactId ? { contactId } : {}),
    ...(stageId ? { stageId } : {}),
    ...(title ? { title } : {}),
  });
  if (!resolved.ok) return { status: "failed", message: resolved.message };

  const externalPatch = pickDealExternalId(headers, row);
  const lostReason = row.lost_reason?.trim() || row.lostreason?.trim() || undefined;

  try {
    let dealId: string | null = null;
    let outcome: "created" | "updated" | "skipped" = "created";

    if (resolved.target.mode === "update") {
      if (!allowUpdate) {
        // Modo "somente criar": achou match, então não mexemos no deal.
        // Aplicamos apenas a tag (idempotente).
        if (opts.importTagId) await attachTagToDeal(resolved.target.id, opts.importTagId);
        return { status: "skipped" };
      }
      // Update parcial: só inclui o que veio no CSV. Em CSV mínimo (só
      // identificador + tag) o payload de campos fica vazio e pulamos o
      // `updateDeal` — o efeito da linha é apenas a tag/custom fields.
      const updatePayload = {
        ...(title ? { title } : {}),
        ...(stageId ? { stageId } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(statusRaw && isValidDealStatus(statusRaw) ? { status: statusRaw } : {}),
        ...(expectedClose !== undefined ? { expectedClose } : {}),
        ...(lostReason !== undefined ? { lostReason } : {}),
        ...(contactId !== undefined ? { contactId } : {}),
        ...(ownerId !== undefined ? { ownerId } : {}),
        ...(externalPatch !== undefined ? { externalId: externalPatch } : {}),
      };
      if (Object.keys(updatePayload).length > 0) {
        await updateDeal(resolved.target.id, updatePayload);
        outcome = "updated";
      } else {
        outcome = "skipped";
      }
      dealId = resolved.target.id;
    } else {
      // Modo "somente atualizar": não achou match → NÃO CRIA. Era exatamente
      // isso que gerava deals órfãos (sem contactId) na importação Kommo do
      // Cruzeiro EaD (2026-07-29) — o CSV não trazia colunas de contato e o
      // header `id deal` não era reconhecido, então toda linha caía aqui.
      if (!allowCreate) {
        return { status: "skipped" };
      }
      // Para CRIAR o deal precisamos de stage (title tem fallback no service).
      if (!stageId) {
        return {
          status: "failed",
          message: "Estágio não encontrado (stage_id ou pipeline+estágio).",
        };
      }
      let externalForCreate: string | null | undefined = undefined;
      if (externalPatch !== undefined) externalForCreate = externalPatch;
      else if (resolved.target.externalId !== undefined) externalForCreate = resolved.target.externalId;
      // Posição explícita do contador por estágio em memória — evita o
      // MAX(position) por linha dentro do createDeal.
      const position = await takeNextStagePosition(stageId, cache);
      const d = await createDeal({
        ...(resolved.target.id ? { id: resolved.target.id } : {}),
        externalId: externalForCreate === undefined ? undefined : externalForCreate,
        title,
        stageId,
        position,
        value,
        status: statusRaw && isValidDealStatus(statusRaw) ? statusRaw : undefined,
        expectedClose,
        lostReason,
        contactId: contactId ?? undefined,
        ownerId,
      });
      dealId = (d as { id?: string })?.id ?? null;
      outcome = "created";
    }

    if (opts.importTagId && dealId) {
      await attachTagToDeal(dealId, opts.importTagId);
      // Linha "só pra pintar tag" (update-only sem campos) conta como update
      // efetivo: a tag foi o trabalho realizado, não é um skip vazio.
      if (outcome === "skipped") outcome = "updated";
    }
    if (dealId) await applyDealCustomFields(dealId, row, opts.dealCustomFieldMap);

    return { status: outcome };
  } catch (e: unknown) {
    const code =
      typeof e === "object" && e !== null && "code" in e ? String((e as { code: string }).code) : "";
    const msg =
      e instanceof Error && e.message === "INVALID_TITLE"
        ? "Título inválido."
        : code === "P2002"
          ? "Violação de unicidade (id externo ou número duplicado)."
          : code === "P2003"
            ? "Referência inválida (contato, estágio ou usuário)."
            : "Erro ao salvar negócio.";
    return { status: "failed", message: msg };
  }
}
