import { Prisma, type CustomFieldType } from "@prisma/client";
import { randomUUID } from "crypto";

import { parseHighlightRules, resolveHighlight } from "@/lib/highlight";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { getRequestContext } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

/**
 * Auto-cura da migração 20260711000000_add_show_in_deal_panel quando o
 * `prisma migrate deploy` do container ainda não rodou/aplicou nesse banco.
 * `ADD COLUMN IF NOT EXISTS` é idempotente e barato — tentamos uma vez por
 * cold start; se funcionar, os fallbacks raw abaixo passam a ser inertes
 * (o Prisma normal volta a funcionar). Sem isso, showInDealPanel nunca é
 * persistido de fato (o fallback raw explicitamente não escreve essa
 * coluna, por não poder referenciá-la), e o toggle de exibir/ocultar no
 * painel do negócio parece "não fazer nada".
 */
let showInDealPanelColumnEnsured = false;
async function ensureShowInDealPanelColumn(): Promise<boolean> {
  if (showInDealPanelColumnEnsured) return true;
  try {
    await prismaBase.$executeRawUnsafe(
      `ALTER TABLE "custom_fields" ADD COLUMN IF NOT EXISTS "showInDealPanel" BOOLEAN NOT NULL DEFAULT false`,
    );
    showInDealPanelColumnEnsured = true;
    return true;
  } catch {
    // Sem permissão de DDL (ou outro erro) — segue usando os fallbacks raw.
    return false;
  }
}

export async function getCustomFields(entity = "contact"): Promise<
  (Awaited<ReturnType<typeof prisma.customField.findMany>> extends (infer T)[] ? T : never)[]
> {
  // Resolve organizationId a partir do contexto da request para filtrar explicitamente,
  // evitando dependência da extensão de org-scope do prisma scoped.
  const ctx = getRequestContext();
  const orgId = ctx?.organizationId ?? null;

  try {
    // Usa prismaBase com filtro explícito quando temos orgId (mais robusto).
    // Fallback para o cliente scoped nos raros casos sem orgId (ex: scripts).
    if (orgId) {
      return await prismaBase.customField.findMany({
        where: { entity, organizationId: orgId },
        orderBy: { name: "asc" },
      });
    }
    return await prisma.customField.findMany({
      where: { entity },
      orderBy: { name: "asc" },
    });
  } catch {
    // Fallback para quando a coluna showInDealPanel ainda não existe na DB
    // (migração pendente). Retorna os campos sem ela usando SQL raw.
    if (orgId) {
      const rows = await prismaBase.$queryRaw<Record<string, unknown>[]>`
        SELECT id, name, label, "type", options, required, entity,
               "showInInboxLeadPanel", "inboxLeadPanelOrder",
               "highlightRules", "organizationId"
        FROM custom_fields
        WHERE entity = ${entity} AND "organizationId" = ${orgId}
        ORDER BY name ASC
      `;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r) => ({ ...r, showInDealPanel: false })) as any;
    }
    const rows = await prismaBase.$queryRaw<Record<string, unknown>[]>`
      SELECT id, name, label, "type", options, required, entity,
             "showInInboxLeadPanel", "inboxLeadPanelOrder",
             "highlightRules", "organizationId"
      FROM custom_fields
      WHERE entity = ${entity}
      ORDER BY name ASC
    `;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r) => ({ ...r, showInDealPanel: false })) as any;
  }
}

export async function getCustomFieldById(id: string) {
  try {
    return await prisma.customField.findUnique({ where: { id } });
  } catch {
    // Mesmo fallback de coluna ausente (showInDealPanel) usado no resto do
    // arquivo. Chamado antes de update/delete no route.ts — sem esse
    // fallback, qualquer PUT/DELETE em /api/custom-fields/[id] falharia
    // aqui mesmo, antes de chegar no updateCustomField.
    const ctx = getRequestContext();
    const orgId = ctx?.organizationId ?? null;
    const rows = orgId
      ? await prismaBase.$queryRaw<Record<string, unknown>[]>`
          SELECT id, name, label, "type", options, required, entity,
                 "showInInboxLeadPanel", "inboxLeadPanelOrder",
                 "highlightRules", "organizationId"
          FROM custom_fields WHERE id = ${id} AND "organizationId" = ${orgId}
        `
      : await prismaBase.$queryRaw<Record<string, unknown>[]>`
          SELECT id, name, label, "type", options, required, entity,
                 "showInInboxLeadPanel", "inboxLeadPanelOrder",
                 "highlightRules", "organizationId"
          FROM custom_fields WHERE id = ${id}
        `;
    const row = rows[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return row ? ({ ...row, showInDealPanel: false } as any) : null;
  }
}

export async function createCustomField(data: {
  name: string;
  label: string;
  type: CustomFieldType;
  options?: string[];
  required?: boolean;
  entity?: string;
  showInInboxLeadPanel?: boolean;
  inboxLeadPanelOrder?: number | null;
  showInDealPanel?: boolean;
  highlightRules?: unknown;
}) {
  try {
    return await prisma.customField.create({
      data: withOrgFromCtx({
        name: data.name,
        label: data.label,
        type: data.type,
        options: data.options ?? [],
        required: data.required ?? false,
        entity: data.entity ?? "contact",
        showInInboxLeadPanel: data.showInInboxLeadPanel ?? false,
        inboxLeadPanelOrder: data.inboxLeadPanelOrder ?? null,
        showInDealPanel: data.showInDealPanel ?? false,
        ...(data.highlightRules !== undefined
          ? { highlightRules: parseHighlightRules(data.highlightRules) as unknown as Prisma.InputJsonValue }
          : {}),
      }),
    });
  } catch {
    // Fallback: coluna showInDealPanel ainda não migrada na DB. Repetir com o
    // mesmo client Prisma (mesmo sem showInDealPanel no `data`) falha de novo,
    // pois o RETURNING implícito do create() ainda seleciona a coluna
    // ausente — ver mesmo raciocínio em updateCustomFieldRaw. Tenta se
    // auto-curar antes (ver ensureShowInDealPanelColumn) para não perder o
    // valor de showInDealPanel no fallback raw.
    if (await ensureShowInDealPanelColumn()) {
      try {
        return await prisma.customField.create({
          data: withOrgFromCtx({
            name: data.name,
            label: data.label,
            type: data.type,
            options: data.options ?? [],
            required: data.required ?? false,
            entity: data.entity ?? "contact",
            showInInboxLeadPanel: data.showInInboxLeadPanel ?? false,
            inboxLeadPanelOrder: data.inboxLeadPanelOrder ?? null,
            showInDealPanel: data.showInDealPanel ?? false,
            ...(data.highlightRules !== undefined
              ? { highlightRules: parseHighlightRules(data.highlightRules) as unknown as Prisma.InputJsonValue }
              : {}),
          }),
        });
      } catch {
        // segue para o fallback raw abaixo
      }
    }
    return createCustomFieldRaw(data);
  }
}

async function createCustomFieldRaw(data: {
  name: string;
  label: string;
  type: CustomFieldType;
  options?: string[];
  required?: boolean;
  entity?: string;
  showInInboxLeadPanel?: boolean;
  inboxLeadPanelOrder?: number | null;
  highlightRules?: unknown;
}) {
  const ctx = getRequestContext();
  const orgId = ctx?.organizationId ?? null;
  if (!orgId) throw new Error("createCustomField: organizationId ausente no contexto.");

  const id = randomUUID();
  const options = data.options ?? [];
  const required = data.required ?? false;
  const entity = data.entity ?? "contact";
  const showInInboxLeadPanel = data.showInInboxLeadPanel ?? false;
  const inboxLeadPanelOrder = data.inboxLeadPanelOrder ?? null;
  const highlightRules =
    data.highlightRules !== undefined ? parseHighlightRules(data.highlightRules) : [];

  await prismaBase.$executeRaw`
    INSERT INTO custom_fields
      (id, name, label, "type", options, required, entity,
       "showInInboxLeadPanel", "inboxLeadPanelOrder", "highlightRules", "organizationId")
    VALUES
      (${id}, ${data.name}, ${data.label}, ${data.type}::"CustomFieldType", ${options},
       ${required}, ${entity}, ${showInInboxLeadPanel}, ${inboxLeadPanelOrder},
       ${JSON.stringify(highlightRules)}::jsonb, ${orgId})
  `;

  const rows = await prismaBase.$queryRaw<Record<string, unknown>[]>`
    SELECT id, name, label, "type", options, required, entity,
           "showInInboxLeadPanel", "inboxLeadPanelOrder",
           "highlightRules", "organizationId"
    FROM custom_fields WHERE id = ${id}
  `;
  const row = rows[0];
  return row ? { ...row, showInDealPanel: false } : null;
}

export async function updateCustomField(
  id: string,
  data: {
    label?: string;
    type?: CustomFieldType;
    options?: string[];
    required?: boolean;
    showInInboxLeadPanel?: boolean;
    inboxLeadPanelOrder?: number | null;
    showInDealPanel?: boolean;
    highlightRules?: unknown;
  }
) {
  const { highlightRules, showInDealPanel, ...rest } = data;
  const baseData = {
    ...rest,
    ...(highlightRules !== undefined
      ? { highlightRules: parseHighlightRules(highlightRules) as unknown as Prisma.InputJsonValue }
      : {}),
  };
  try {
    // Nada para persistir (ex.: PUT tentando setar showInDealPanel num campo
    // entity=contact, que o route.ts ignora): Prisma rejeita `data: {}` com erro
    // de validação. Retorna o registro atual sem chamar update.
    if (Object.keys(baseData).length === 0 && showInDealPanel === undefined) {
      return (await prisma.customField.findUnique({ where: { id } })) ?? undefined;
    }
    return await prisma.customField.update({
      where: { id },
      data: {
        ...baseData,
        ...(showInDealPanel !== undefined ? { showInDealPanel } : {}),
      },
    });
  } catch {
    // Fallback: coluna showInDealPanel ainda não migrada na DB (mesmo cenário
    // de getCustomFields/getDealPanelFieldsForDeal/getInboxLeadPanelFieldsForDeal).
    // O client Prisma padrão sempre seleciona TODAS as colunas do model no
    // retorno — mesmo um update()/findUnique() que não referencia
    // showInDealPanel no `data` falha, pois a SELECT/RETURNING implícita
    // ainda tenta ler a coluna ausente.
    //
    // Antes de cair no fallback raw (que NÃO consegue persistir
    // showInDealPanel, já que não pode referenciar uma coluna ausente),
    // tenta se auto-curar criando a coluna e repete a chamada Prisma normal.
    if (await ensureShowInDealPanelColumn()) {
      try {
        return await prisma.customField.update({
          where: { id },
          data: {
            ...baseData,
            ...(showInDealPanel !== undefined ? { showInDealPanel } : {}),
          },
        });
      } catch {
        // segue para o fallback raw abaixo
      }
    }
    return updateCustomFieldRaw(id, baseData);
  }
}

async function updateCustomFieldRaw(id: string, baseData: Record<string, unknown>) {
  const ctx = getRequestContext();
  const orgId = ctx?.organizationId ?? null;
  const orgFilter = orgId ? Prisma.sql`AND "organizationId" = ${orgId}` : Prisma.empty;

  if (typeof baseData.label === "string") {
    await prismaBase.$executeRaw`UPDATE custom_fields SET label = ${baseData.label} WHERE id = ${id} ${orgFilter}`;
  }
  if (typeof baseData.type === "string") {
    await prismaBase.$executeRaw`UPDATE custom_fields SET "type" = ${baseData.type}::"CustomFieldType" WHERE id = ${id} ${orgFilter}`;
  }
  if (Array.isArray(baseData.options)) {
    await prismaBase.$executeRaw`UPDATE custom_fields SET options = ${baseData.options} WHERE id = ${id} ${orgFilter}`;
  }
  if (typeof baseData.required === "boolean") {
    await prismaBase.$executeRaw`UPDATE custom_fields SET required = ${baseData.required} WHERE id = ${id} ${orgFilter}`;
  }
  if (typeof baseData.showInInboxLeadPanel === "boolean") {
    await prismaBase.$executeRaw`UPDATE custom_fields SET "showInInboxLeadPanel" = ${baseData.showInInboxLeadPanel} WHERE id = ${id} ${orgFilter}`;
  }
  if ("inboxLeadPanelOrder" in baseData) {
    const order = (baseData.inboxLeadPanelOrder ?? null) as number | null;
    await prismaBase.$executeRaw`UPDATE custom_fields SET "inboxLeadPanelOrder" = ${order} WHERE id = ${id} ${orgFilter}`;
  }
  if (baseData.highlightRules !== undefined) {
    await prismaBase.$executeRaw`UPDATE custom_fields SET "highlightRules" = ${JSON.stringify(baseData.highlightRules)}::jsonb WHERE id = ${id} ${orgFilter}`;
  }
  // showInDealPanel é deliberadamente ignorado aqui: é o motivo de estarmos
  // neste fallback (coluna ausente na DB atual).

  const rows = orgId
    ? await prismaBase.$queryRaw<Record<string, unknown>[]>`
        SELECT id, name, label, "type", options, required, entity,
               "showInInboxLeadPanel", "inboxLeadPanelOrder",
               "highlightRules", "organizationId"
        FROM custom_fields WHERE id = ${id} AND "organizationId" = ${orgId}
      `
    : await prismaBase.$queryRaw<Record<string, unknown>[]>`
        SELECT id, name, label, "type", options, required, entity,
               "showInInboxLeadPanel", "inboxLeadPanelOrder",
               "highlightRules", "organizationId"
        FROM custom_fields WHERE id = ${id}
      `;
  const row = rows[0];
  return row ? { ...row, showInDealPanel: false } : null;
}

export async function deleteCustomField(id: string) {
  try {
    return await prisma.customField.delete({ where: { id } });
  } catch {
    // Mesmo fallback de coluna showInDealPanel ausente: o delete() também
    // retorna o registro apagado por padrão (RETURNING implícito).
    const ctx = getRequestContext();
    const orgId = ctx?.organizationId ?? null;
    const orgFilter = orgId ? Prisma.sql`AND "organizationId" = ${orgId}` : Prisma.empty;
    await prismaBase.$executeRaw`DELETE FROM custom_fields WHERE id = ${id} ${orgFilter}`;
    return { id };
  }
}

export async function getContactCustomFieldValues(contactId: string) {
  try {
    const fields = await prisma.customField.findMany({
      where: { entity: "contact" },
      orderBy: { name: "asc" },
      include: {
        values: { where: { contactId } },
      },
    });

    return fields.map((f) => {
      const value = f.values[0]?.value ?? null;
      return {
        fieldId: f.id,
        name: f.name,
        label: f.label,
        type: f.type,
        options: f.options,
        required: f.required,
        value,
        highlight: resolveHighlight(value, f.highlightRules),
      };
    });
  } catch {
    // Mesmo fallback de coluna showInDealPanel ausente (ver topo do arquivo):
    // esse findMany não referencia a coluna, mas o Prisma seleciona todas as
    // colunas do model por padrão e falha do mesmo jeito.
    return getContactCustomFieldValuesRaw(contactId);
  }
}

async function getContactCustomFieldValuesRaw(contactId: string) {
  const ctx = getRequestContext();
  const orgId = ctx?.organizationId ?? null;
  const rows = orgId
    ? await prismaBase.$queryRaw<Record<string, unknown>[]>`
        SELECT id, name, label, "type", options, required, "highlightRules"
        FROM custom_fields
        WHERE entity = 'contact' AND "organizationId" = ${orgId}
        ORDER BY name ASC
      `
    : await prismaBase.$queryRaw<Record<string, unknown>[]>`
        SELECT id, name, label, "type", options, required, "highlightRules"
        FROM custom_fields
        WHERE entity = 'contact'
        ORDER BY name ASC
      `;
  if (rows.length === 0) return [];

  const fieldIds = rows.map((r) => r.id as string);
  const values = await prisma.contactCustomFieldValue.findMany({
    where: { contactId, customFieldId: { in: fieldIds } },
    select: { customFieldId: true, value: true },
  });
  const valueByField = new Map(values.map((v) => [v.customFieldId, v.value]));

  return rows.map((f) => {
    const value = valueByField.get(f.id as string) ?? null;
    return {
      fieldId: f.id as string,
      name: f.name as string,
      label: f.label as string,
      type: f.type as string,
      options: (f.options as string[]) ?? [],
      required: Boolean(f.required),
      value,
      highlight: resolveHighlight(value, f.highlightRules as unknown[]),
    };
  });
}

export async function upsertContactCustomFieldValues(
  contactId: string,
  values: { fieldId: string; value: string }[]
) {
  const ops = values.map((v) =>
    prisma.contactCustomFieldValue.upsert({
      where: {
        contactId_customFieldId: {
          contactId,
          customFieldId: v.fieldId,
        },
      },
      update: { value: v.value },
      create: withOrgFromCtx({
        contactId,
        customFieldId: v.fieldId,
        value: v.value,
      }),
    })
  );

  return prisma.$transaction(ops);
}

export async function getDealCustomFieldValues(dealId: string) {
  try {
    const fields = await prisma.customField.findMany({
      where: { entity: "deal" },
      orderBy: { name: "asc" },
      include: {
        dealValues: { where: { dealId } },
      },
    });

    return fields.map((f) => {
      const value = f.dealValues[0]?.value ?? null;
      return {
        fieldId: f.id,
        name: f.name,
        label: f.label,
        type: f.type,
        options: f.options,
        required: f.required,
        value,
        highlight: resolveHighlight(value, f.highlightRules),
      };
    });
  } catch {
    // Mesmo fallback de coluna showInDealPanel ausente (ver topo do arquivo).
    return getDealCustomFieldValuesRaw(dealId);
  }
}

async function getDealCustomFieldValuesRaw(dealId: string) {
  const ctx = getRequestContext();
  const orgId = ctx?.organizationId ?? null;
  const rows = orgId
    ? await prismaBase.$queryRaw<Record<string, unknown>[]>`
        SELECT id, name, label, "type", options, required, "highlightRules"
        FROM custom_fields
        WHERE entity = 'deal' AND "organizationId" = ${orgId}
        ORDER BY name ASC
      `
    : await prismaBase.$queryRaw<Record<string, unknown>[]>`
        SELECT id, name, label, "type", options, required, "highlightRules"
        FROM custom_fields
        WHERE entity = 'deal'
        ORDER BY name ASC
      `;
  if (rows.length === 0) return [];

  const fieldIds = rows.map((r) => r.id as string);
  const values = await prisma.dealCustomFieldValue.findMany({
    where: { dealId, customFieldId: { in: fieldIds } },
    select: { customFieldId: true, value: true },
  });
  const valueByField = new Map(values.map((v) => [v.customFieldId, v.value]));

  return rows.map((f) => {
    const value = valueByField.get(f.id as string) ?? null;
    return {
      fieldId: f.id as string,
      name: f.name as string,
      label: f.label as string,
      type: f.type as string,
      options: (f.options as string[]) ?? [],
      required: Boolean(f.required),
      value,
      highlight: resolveHighlight(value, f.highlightRules as unknown[]),
    };
  });
}

export async function upsertDealCustomFieldValues(
  dealId: string,
  values: { fieldId: string; value: string }[]
) {
  const ops = values.map((v) =>
    prisma.dealCustomFieldValue.upsert({
      where: {
        dealId_customFieldId: {
          dealId,
          customFieldId: v.fieldId,
        },
      },
      update: { value: v.value },
      create: withOrgFromCtx({
        dealId,
        customFieldId: v.fieldId,
        value: v.value,
      }),
    })
  );

  return prisma.$transaction(ops);
}

/**
 * Aplica o MESMO conjunto de valores a vários deals em `values.length + 1`
 * round-trips, em vez de uma `$transaction` de upserts por deal (que em
 * lote de 1.000 deals × 3 campos vira ~3.000 statements).
 *
 * Estratégia equivalente ao upsert e idempotente:
 *   1. `createMany(..., skipDuplicates)` insere só os pares que faltam;
 *   2. um `updateMany` por campo corrige os pares que já existiam com
 *      valor diferente (`value: { not }` evita escrever à toa).
 *
 * A ordem create→update também cobre a corrida em que outra escrita cria
 * a linha entre as duas etapas: o update posterior fixa o valor final.
 */
export async function setDealCustomFieldValuesBulk(
  dealIds: string[],
  values: { fieldId: string; value: string }[],
) {
  if (dealIds.length === 0 || values.length === 0) return;
  // Campo repetido no payload: o último vence, igual ao laço de upserts.
  const valueByField = new Map(values.map((v) => [v.fieldId, v.value]));

  const rows: { dealId: string; customFieldId: string; value: string }[] = [];
  for (const [customFieldId, value] of valueByField) {
    for (const dealId of dealIds) rows.push({ dealId, customFieldId, value });
  }

  await prisma.dealCustomFieldValue.createMany({
    data: rows.map((r) => withOrgFromCtx(r)),
    skipDuplicates: true,
  });

  for (const [customFieldId, value] of valueByField) {
    await prisma.dealCustomFieldValue.updateMany({
      where: { dealId: { in: dealIds }, customFieldId, value: { not: value } },
      data: { value },
    });
  }
}

/** Contraparte de `setDealCustomFieldValuesBulk` para contatos. */
export async function setContactCustomFieldValuesBulk(
  contactIds: string[],
  values: { fieldId: string; value: string }[],
) {
  if (contactIds.length === 0 || values.length === 0) return;
  const valueByField = new Map(values.map((v) => [v.fieldId, v.value]));

  const rows: { contactId: string; customFieldId: string; value: string }[] = [];
  for (const [customFieldId, value] of valueByField) {
    for (const contactId of contactIds) rows.push({ contactId, customFieldId, value });
  }

  await prisma.contactCustomFieldValue.createMany({
    data: rows.map((r) => withOrgFromCtx(r)),
    skipDuplicates: true,
  });

  for (const [customFieldId, value] of valueByField) {
    await prisma.contactCustomFieldValue.updateMany({
      where: { contactId: { in: contactIds }, customFieldId, value: { not: value } },
      data: { value },
    });
  }
}

/**
 * Grava valores de campos personalizados de um deal RECÉM-CRIADO em um único
 * round-trip (`createMany`). Otimização para importação em massa: como o deal
 * acabou de ser criado, não há valores pré-existentes, então não precisamos do
 * upsert (que faz N round-trips numa transação). `skipDuplicates` protege
 * contra corrida improvável. Para deals existentes, use
 * `upsertDealCustomFieldValues`.
 */
export async function createDealCustomFieldValues(
  dealId: string,
  values: { fieldId: string; value: string }[]
) {
  if (values.length === 0) return;
  await prisma.dealCustomFieldValue.createMany({
    data: values.map((v) =>
      withOrgFromCtx({
        dealId,
        customFieldId: v.fieldId,
        value: v.value,
      }),
    ),
    skipDuplicates: true,
  });
}
