import { randomBytes } from "crypto";

import { prisma } from "@/lib/prisma";
import {
  buildWaFlowJsonString,
  WA_FLOW_JSON_VERSION,
  type CrmFlowScreenInput,
} from "@/lib/meta-whatsapp/build-static-wa-flow-json";
import { isMetaGraphError, type MetaWhatsAppClient } from "@/lib/meta-whatsapp/client";
import {
  cleanFlowFieldLabel,
  normalizeFlowMatchKey,
} from "@/lib/meta-whatsapp/parse-flow-response";
import { parseWaFlowJsonToCrmScreens } from "@/lib/meta-whatsapp/parse-wa-flow-json";

/** Gera 8 chars base64url (6 bytes de entropia = 48 bits). */
function generateShortId(): string {
  return randomBytes(6).toString("base64url");
}

export type FlowDefinitionInputScreen = {
  title: string;
  sortOrder?: number;
  fields: {
    fieldKey: string;
    label: string;
    fieldType?: string;
    options?: string[];
    required?: boolean;
    sortOrder?: number;
    mapping?: {
      targetKind: "CONTACT_NATIVE" | "DEAL_NATIVE" | "CUSTOM_FIELD";
      nativeKey?: string | null;
      customFieldId?: string | null;
    } | null;
  }[];
};

function normalizeFieldOptions(options?: unknown): string[] {
  if (typeof options === "string") {
    return options.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(options)) return [];
  return options
    .flatMap((o) => (typeof o === "string" ? o.split(/\r?\n/) : []))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Campos do negócio (deal) disponíveis para mapeamento no editor de Flow. */
export async function listLeadMappingFields() {
  const customFields = await prisma.customField.findMany({
    where: { entity: "deal" },
    orderBy: { label: "asc" },
    select: { id: true, name: true, label: true, type: true },
  });
  return {
    nativeFields: [
      { key: "title", label: "Título do negócio" },
      { key: "value", label: "Valor do negócio" },
      { key: "expectedClose", label: "Previsão de fechamento" },
    ],
    customFields,
  };
}

function isAllowedMappingTarget(
  m: FlowDefinitionInputScreen["fields"][number]["mapping"],
): m is NonNullable<FlowDefinitionInputScreen["fields"][number]["mapping"]> {
  return (
    !!m &&
    (m.targetKind === "CONTACT_NATIVE" ||
      m.targetKind === "DEAL_NATIVE" ||
      m.targetKind === "CUSTOM_FIELD")
  );
}

export type FlowDefinitionUpsertInput = {
  name: string;
  flowCategory?: string;
  screens: FlowDefinitionInputScreen[];
};

export async function listFlowDefinitions() {
  return prisma.whatsappFlowDefinition.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      shortId: true,
      name: true,
      status: true,
      metaFlowId: true,
      flowCategory: true,
      publishedAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Resolve um flow pelo CUID (`id`) ou pelo `shortId` de 8 chars.
 * Aceita ambos para compatibilidade com registros legados sem shortId.
 */
export async function getFlowDefinitionById(idOrShortId: string) {
  return prisma.whatsappFlowDefinition.findFirst({
    where: { OR: [{ id: idOrShortId }, { shortId: idOrShortId }] },
    include: {
      screens: {
        orderBy: { sortOrder: "asc" },
        include: {
          fields: {
            orderBy: { sortOrder: "asc" },
            include: { mapping: true },
          },
        },
      },
    },
  });
}

export async function createFlowDefinitionDraft(
  orgId: string,
  input: FlowDefinitionUpsertInput,
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("Nome do flow é obrigatório.");
  const screensIn = input.screens?.length
    ? input.screens
    : [{ title: "Tela 1", fields: [] as FlowDefinitionInputScreen["fields"] }];

  const created = await prisma.$transaction(async (tx) => {
    const flow = await tx.whatsappFlowDefinition.create({
      data: {
        organizationId: orgId,
        name,
        shortId: generateShortId(),
        status: "DRAFT",
        flowCategory: (input.flowCategory ?? "LEAD_GENERATION").trim() || "LEAD_GENERATION",
      },
    });

    let order = 0;
    for (const sc of screensIn) {
      const screen = await tx.whatsappFlowScreen.create({
        data: {
          flowId: flow.id,
          sortOrder: sc.sortOrder ?? order,
          title: sc.title.trim() || `Tela ${order + 1}`,
        },
      });
      let fOrder = 0;
      for (const f of sc.fields ?? []) {
        const field = await tx.whatsappFlowField.create({
          data: {
            screenId: screen.id,
            fieldKey: f.fieldKey.trim(),
            label: f.label.trim(),
            fieldType: (f.fieldType ?? "TEXT").trim(),
            options: normalizeFieldOptions(f.options),
            required: Boolean(f.required),
            sortOrder: f.sortOrder ?? fOrder,
          },
        });
        const m = f.mapping;
        if (isAllowedMappingTarget(m)) {
          await tx.whatsappFlowFieldMapping.create({
            data: {
              fieldId: field.id,
              targetKind: m.targetKind,
              nativeKey: m.nativeKey?.trim() || null,
              customFieldId: m.customFieldId?.trim() || null,
            },
          });
        }
        fOrder += 1;
      }
      order += 1;
    }

    return flow;
  });

  return { id: created.shortId ?? created.id };
}

/**
 * Atualiza apenas os mappings de um flow já publicado na Meta.
 * Estrutura do formulário (telas/campos) não é alterada — não exige republicação.
 */
export async function updatePublishedFlowMappings(
  id: string,
  input: FlowDefinitionUpsertInput,
): Promise<void> {
  const existing = await prisma.whatsappFlowDefinition.findFirst({
    where: { id },
    include: {
      screens: {
        include: {
          fields: { include: { mapping: true } },
        },
      },
    },
  });
  if (!existing) throw new Error("Flow não encontrado.");
  if (existing.status !== "PUBLISHED") {
    throw new Error("Mapeamento editável só em flows publicados. Use o editor de rascunho.");
  }

  const fieldByKey = new Map<string, { fieldId: string }>();
  for (const sc of existing.screens) {
    for (const f of sc.fields) {
      fieldByKey.set(f.fieldKey.trim(), { fieldId: f.id });
    }
  }

  const incomingMappings = new Map<
    string,
    FlowDefinitionInputScreen["fields"][number]["mapping"]
  >();
  for (const sc of input.screens ?? []) {
    for (const f of sc.fields ?? []) {
      const key = f.fieldKey.trim();
      if (key) incomingMappings.set(key, f.mapping ?? null);
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const [fieldKey, mapping] of incomingMappings) {
      const row = fieldByKey.get(fieldKey);
      if (!row) continue;

      if (
        isAllowedMappingTarget(mapping)
      ) {
        await tx.whatsappFlowFieldMapping.upsert({
          where: { fieldId: row.fieldId },
          create: {
            fieldId: row.fieldId,
            targetKind: mapping.targetKind,
            nativeKey: mapping.nativeKey?.trim() || null,
            customFieldId: mapping.customFieldId?.trim() || null,
          },
          update: {
            targetKind: mapping.targetKind,
            nativeKey: mapping.nativeKey?.trim() || null,
            customFieldId: mapping.customFieldId?.trim() || null,
          },
        });
      } else {
        await tx.whatsappFlowFieldMapping.deleteMany({ where: { fieldId: row.fieldId } });
      }
    }
  });
}

export async function replaceFlowDefinitionDraft(
  id: string,
  input: FlowDefinitionUpsertInput,
): Promise<void> {
  const existing = await prisma.whatsappFlowDefinition.findFirst({ where: { id } });
  if (!existing) throw new Error("Flow não encontrado.");
  if (existing.status !== "DRAFT") {
    throw new Error("Só é possível editar a estrutura do flow em rascunho.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.whatsappFlowScreen.deleteMany({ where: { flowId: id } });
    await tx.whatsappFlowDefinition.update({
      where: { id },
      data: {
        name: input.name.trim(),
        flowCategory: (input.flowCategory ?? existing.flowCategory).trim() || "LEAD_GENERATION",
      },
    });

    const screensIn = input.screens?.length
      ? input.screens
      : [{ title: "Tela 1", fields: [] as FlowDefinitionInputScreen["fields"] }];
    let order = 0;
    for (const sc of screensIn) {
      const screen = await tx.whatsappFlowScreen.create({
        data: {
          flowId: id,
          sortOrder: sc.sortOrder ?? order,
          title: sc.title.trim() || `Tela ${order + 1}`,
        },
      });
      let fOrder = 0;
      for (const f of sc.fields ?? []) {
        const field = await tx.whatsappFlowField.create({
          data: {
            screenId: screen.id,
            fieldKey: f.fieldKey.trim(),
            label: f.label.trim(),
            fieldType: (f.fieldType ?? "TEXT").trim(),
            options: normalizeFieldOptions(f.options),
            required: Boolean(f.required),
            sortOrder: f.sortOrder ?? fOrder,
          },
        });
        const m = f.mapping;
        if (isAllowedMappingTarget(m)) {
          await tx.whatsappFlowFieldMapping.create({
            data: {
              fieldId: field.id,
              targetKind: m.targetKind,
              nativeKey: m.nativeKey?.trim() || null,
              customFieldId: m.customFieldId?.trim() || null,
            },
          });
        }
        fOrder += 1;
      }
      order += 1;
    }
  });
}

export async function deleteFlowDefinitionDraft(id: string, metaClient: MetaWhatsAppClient): Promise<void> {
  const existing = await prisma.whatsappFlowDefinition.findFirst({ where: { id } });
  if (!existing) throw new Error("Flow não encontrado.");
  if (existing.status !== "DRAFT") {
    throw new Error("Só é possível apagar flows em rascunho na Meta.");
  }
  if (existing.metaFlowId?.trim()) {
    try {
      await metaClient.deleteFlow(existing.metaFlowId.trim());
    } catch {
      /* best-effort */
    }
  }
  await prisma.whatsappFlowDefinition.delete({ where: { id } });
}

export type MetaCreateFlowResponse = {
  id?: string;
  success?: boolean;
  validation_errors?: unknown[];
};

export async function publishFlowDefinition(
  id: string,
  metaClient: MetaWhatsAppClient,
): Promise<{ metaFlowId: string; validationErrors: unknown[] }> {
  const full = await getFlowDefinitionById(id);
  if (!full) throw new Error("Flow não encontrado.");
  if (full.status !== "DRAFT") {
    throw new Error("Flow já publicado ou arquivado.");
  }

  const screens: CrmFlowScreenInput[] = full.screens.map((s) => ({
    title: s.title,
    fields: s.fields.map((f) => ({
      fieldKey: f.fieldKey,
      label: f.label,
      fieldType: f.fieldType,
      required: f.required,
      options: f.options ?? [],
    })),
  }));

  const flowJson = buildWaFlowJsonString({ screens });
  const categories = [full.flowCategory.trim().toUpperCase() || "LEAD_GENERATION"];
  const baseName = full.name.slice(0, 512);
  const uniqueName = `${baseName} ${full.shortId ?? full.id.slice(-6)}`.trim().slice(0, 512);

  async function createOnMeta(name: string) {
    return (await metaClient.createFlow({
      name,
      categories,
      flow_json: flowJson,
      publish: true,
    })) as MetaCreateFlowResponse;
  }

  let raw: MetaCreateFlowResponse;
  try {
    raw = await createOnMeta(baseName);
  } catch (e) {
    const duplicateName =
      isMetaGraphError(e) &&
      e.code === 100 &&
      /unique|already|exist|nome/i.test(`${e.message} ${e.details ?? ""} ${e.userMsg ?? ""}`);
    if (!duplicateName) throw e;
    raw = await createOnMeta(uniqueName);
  }

  const validationErrors = Array.isArray(raw.validation_errors) ? raw.validation_errors : [];
  const metaFlowId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;

  if (!metaFlowId) {
    const err = new Error(
      validationErrors.length
        ? "A Meta rejeitou o Flow JSON. Veja validation_errors."
        : "Resposta da Meta sem id do Flow.",
    );
    (err as Error & { validationErrors?: unknown[] }).validationErrors = validationErrors;
    throw err;
  }

  await prisma.whatsappFlowDefinition.update({
    where: { id },
    data: {
      status: "PUBLISHED",
      metaFlowId,
      publishedAt: new Date(),
      metaJsonVersion: WA_FLOW_JSON_VERSION,
    },
  });

  return { metaFlowId, validationErrors };
}

const flowDefinitionInclude = {
  screens: {
    orderBy: { sortOrder: "asc" as const },
    include: {
      fields: {
        orderBy: { sortOrder: "asc" as const },
        include: {
          mapping: {
            include: {
              customField: {
                select: { id: true, name: true, type: true, entity: true },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type ResolvedFlowDefinition = NonNullable<
  Awaited<ReturnType<typeof resolveFlowDefinitionForInbound>>
>;

/**
 * Correlaciona resposta inbound com definição publicada no CRM. Cascata em
 * ordem decrescente de precisão:
 *
 *   1. FK exata: `Message.templateConfigId` → `WhatsAppTemplateConfig.flowId`
 *      Caminho preferido — funciona corretamente quando a org tem múltiplos
 *      templates com Flow. Requer que o envio outbound persista o vínculo
 *      (ver `prisma.message.create(... templateConfigId)` nos call sites de
 *      envio de template).
 *
 *   2. `flowMetaName` (nome do Flow na Meta) → casa com `metaFlowId` ou
 *      `name` do `WhatsappFlowDefinition`. Útil quando a Meta envia o
 *      `nfm_reply.name` (nem sempre vem preenchido).
 *
 *   3. Best-match por field keys — fallback histórico para mensagens
 *      outbound antigas sem `templateConfigId` (pré-migration). Funciona
 *      bem se as `fieldKey` forem distintas entre flows da org.
 *
 * IMPORTANTE: a cascata é "primeiro positivo retorna". Não dá fallback se o
 * passo 1 encontra outbound mas o template não tem `flowId` (cenário
 * configurado errado pelo operador) — registra alerta no log para o
 * applier reportar à UI.
 */
export async function resolveFlowDefinitionForInbound(params: {
  organizationId: string;
  conversationId: string;
  flowMetaName?: string | null;
  flowToken?: string | null;
  responseKeys: string[];
}) {
  const published = await prisma.whatsappFlowDefinition.findMany({
    where: { organizationId: params.organizationId, status: "PUBLISHED" },
    include: flowDefinitionInclude,
  });

  if (published.length === 0) return null;

  // O `flowId` do template guarda o METAFLOWID (id da Meta), não o id interno
  // do CRM. Bug histórico: a resolução comparava com `f.id` (cuid) e nunca
  // casava → mesmo com token, tudo caía no match por rótulo (ambíguo quando a
  // org tem flows publicados com rótulos parecidos).
  const byMetaFlowId = (metaFlowId: string | null | undefined) =>
    metaFlowId ? published.find((f) => f.metaFlowId === metaFlowId) ?? null : null;

  // (1) Resolução exata via flow_token persistido no envio outbound.
  const token = params.flowToken?.trim();
  if (token) {
    const outbound = await prisma.message.findFirst({
      where: {
        conversationId: params.conversationId,
        flowToken: token,
        direction: "out",
      },
      orderBy: { createdAt: "desc" },
      select: { templateConfig: { select: { flowId: true } } },
    });
    const linked = byMetaFlowId(outbound?.templateConfig?.flowId);
    if (linked) return linked;
  }

  // (1b) Resolução pelos templates de Flow disparados NESTA conversa. A Meta
  // frequentemente omite o `flow_token` no nfm_reply, mas os templates
  // outbound carregam `templateConfig.flowId` (= metaFlowId). Restringir os
  // candidatos aos flows efetivamente enviados na conversa elimina a
  // ambiguidade entre flows publicados com rótulos parecidos — principal
  // causa de respostas gravadas no flow errado (ou não gravadas).
  const sentOutbound = await prisma.message.findMany({
    where: {
      conversationId: params.conversationId,
      direction: "out",
      templateConfig: { is: { flowId: { not: null } } },
    },
    orderBy: { createdAt: "desc" },
    select: { templateConfig: { select: { flowId: true } } },
  });
  const sentPublished: typeof published = [];
  for (const m of sentOutbound) {
    const f = byMetaFlowId(m.templateConfig?.flowId);
    if (f && !sentPublished.some((x) => x.id === f.id)) sentPublished.push(f);
  }

  // Candidatos: prioriza flows enviados na conversa; senão, todos os publicados.
  const pool = sentPublished.length > 0 ? sentPublished : published;

  // Um único flow com Flow enviado na conversa → resolução determinística.
  if (sentPublished.length === 1) return sentPublished[0];

  // (2) Match por nome enviado pela Meta no payload do nfm_reply.
  const metaName = params.flowMetaName?.trim();
  if (metaName) {
    const byMeta = pool.find(
      (f) => f.metaFlowId === metaName || f.name === metaName,
    );
    if (byMeta) return byMeta;
  }

  // (3) Best-match por campo, restrito ao pool de candidatos. Compara tanto a
  // chave crua quanto o RÓTULO normalizado — as respostas da Meta normalmente
  // vêm com a chave derivada do label, não do `fieldKey` salvo (que tem
  // sufixo hash). Sem normalizar por label, o score dava 0 e caía no
  // primeiro candidato (flow errado), fazendo os campos não casarem.
  const respNorms = params.responseKeys
    .map((k) => normalizeFlowMatchKey(cleanFlowFieldLabel(k)))
    .filter((s) => s.length >= 3);
  if (respNorms.length === 0) return pool[0] ?? null;

  let best: (typeof published)[number] | null = null;
  let bestScore = 0;
  for (const flow of pool) {
    const fieldNorms = flow.screens.flatMap((s) =>
      s.fields.flatMap((f) => [
        normalizeFlowMatchKey(f.label),
        normalizeFlowMatchKey(f.fieldKey),
      ]),
    );
    const score = respNorms.filter((r) =>
      fieldNorms.some((fn) => fn === r || (r.length >= 3 && fn.startsWith(r))),
    ).length;
    if (score > bestScore) {
      bestScore = score;
      best = flow;
    }
  }

  return bestScore > 0 ? best : pool[0] ?? null;
}

export type MetaFlowListItem = {
  id: string;
  name: string;
  status: string;
  categories: string[];
  alreadyImported: boolean;
  crmFlowDefinitionId: string | null;
};

function parseMetaFlowList(raw: unknown): MetaFlowListItem[] {
  const envelope = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const data = Array.isArray(envelope.data) ? envelope.data : [];
  return data
    .map((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const name = typeof row.name === "string" ? row.name.trim() : id;
      const status = typeof row.status === "string" ? row.status.trim() : "UNKNOWN";
      const categories = Array.isArray(row.categories)
        ? row.categories.filter((c): c is string => typeof c === "string")
        : [];
      if (!id) return null;
      return { id, name, status, categories };
    })
    .filter((x): x is Omit<MetaFlowListItem, "alreadyImported" | "crmFlowDefinitionId"> => x !== null);
}

/** Flows existentes na WABA (Meta) com flag se já foram importados no CRM. */
export async function listMetaFlowsForImport(
  organizationId: string,
  metaClient: MetaWhatsAppClient,
): Promise<MetaFlowListItem[]> {
  if (!metaClient.configured) {
    throw new Error("Meta WhatsApp API não configurada para esta organização.");
  }

  const raw = await metaClient.listFlows();
  const parsed = parseMetaFlowList(raw);

  const imported = await prisma.whatsappFlowDefinition.findMany({
    where: { organizationId },
    select: { id: true, metaFlowId: true },
  });
  const byMetaId = new Map(
    imported
      .filter((f) => f.metaFlowId?.trim())
      .map((f) => [f.metaFlowId!.trim(), f.id] as const),
  );

  return parsed.map((f) => ({
    ...f,
    alreadyImported: byMetaId.has(f.id),
    crmFlowDefinitionId: byMetaId.get(f.id) ?? null,
  }));
}

/**
 * Importa um flow já publicado na Meta para o CRM (status PUBLISHED + metaFlowId).
 * Permite configurar mapeamento de respostas sem republicar o formulário.
 */
export async function importFlowFromMeta(
  organizationId: string,
  metaFlowId: string,
  metaClient: MetaWhatsAppClient,
): Promise<{ id: string; created: boolean }> {
  const flowId = metaFlowId.trim();
  if (!flowId) throw new Error("metaFlowId é obrigatório.");

  const existing = await prisma.whatsappFlowDefinition.findFirst({
    where: { organizationId, metaFlowId: flowId },
    select: { id: true, shortId: true },
  });
  if (existing) {
    return { id: existing.shortId ?? existing.id, created: false };
  }

  const detail = (await metaClient.getFlowById(flowId)) as Record<string, unknown>;
  const flowName =
    typeof detail.name === "string" && detail.name.trim()
      ? detail.name.trim()
      : `Flow ${flowId}`;
  const categories = Array.isArray(detail.categories)
    ? detail.categories.filter((c): c is string => typeof c === "string")
    : [];
  const flowCategory = categories[0]?.trim().toUpperCase() || "LEAD_GENERATION";
  const metaStatus =
    typeof detail.status === "string" ? detail.status.trim().toUpperCase() : "PUBLISHED";

  const flowJson = await metaClient.downloadFlowJson(flowId);
  const screens = parseWaFlowJsonToCrmScreens(flowJson);

  const created = await prisma.$transaction(async (tx) => {
    const flow = await tx.whatsappFlowDefinition.create({
      data: {
        organizationId,
        name: flowName.slice(0, 512),
        shortId: generateShortId(),
        status: metaStatus === "DRAFT" ? "DRAFT" : "PUBLISHED",
        flowCategory,
        metaFlowId: flowId,
        publishedAt: metaStatus === "DRAFT" ? null : new Date(),
        metaJsonVersion: WA_FLOW_JSON_VERSION,
      },
    });

    let order = 0;
    for (const sc of screens) {
      const screen = await tx.whatsappFlowScreen.create({
        data: {
          flowId: flow.id,
          sortOrder: order,
          title: sc.title.trim() || `Tela ${order + 1}`,
        },
      });
      let fOrder = 0;
      for (const f of sc.fields) {
        await tx.whatsappFlowField.create({
          data: {
            screenId: screen.id,
            fieldKey: f.fieldKey.trim(),
            label: f.label.trim(),
            fieldType: (f.fieldType ?? "TEXT").trim(),
            options: normalizeFieldOptions(f.options),
            required: Boolean(f.required),
            sortOrder: fOrder,
          },
        });
        fOrder += 1;
      }
      order += 1;
    }

    return flow;
  });

  return { id: created.shortId ?? created.id, created: true };
}

/**
 * Rebaixa campos do flow a partir do JSON atual na Meta, preservando mappings por fieldKey.
 */
export async function syncFlowFieldsFromMeta(
  flowDefinitionId: string,
  metaClient: MetaWhatsAppClient,
): Promise<void> {
  const existing = await prisma.whatsappFlowDefinition.findFirst({
    where: { id: flowDefinitionId },
    include: {
      screens: {
        include: {
          fields: { include: { mapping: true } },
        },
      },
    },
  });
  if (!existing) throw new Error("Flow não encontrado.");
  const metaFlowId = existing.metaFlowId?.trim();
  if (!metaFlowId) {
    throw new Error("Este flow não tem metaFlowId — importe da Meta primeiro.");
  }

  const flowJson = await metaClient.downloadFlowJson(metaFlowId);
  const parsedScreens = parseWaFlowJsonToCrmScreens(flowJson);

  const mappingByKey = new Map<
    string,
    FlowDefinitionInputScreen["fields"][number]["mapping"]
  >();
  for (const sc of existing.screens) {
    for (const f of sc.fields) {
      if (!f.mapping) continue;
      mappingByKey.set(f.fieldKey.trim(), {
        targetKind: f.mapping.targetKind,
        nativeKey: f.mapping.nativeKey,
        customFieldId: f.mapping.customFieldId,
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.whatsappFlowScreen.deleteMany({ where: { flowId: flowDefinitionId } });

    let order = 0;
    for (const sc of parsedScreens) {
      const screen = await tx.whatsappFlowScreen.create({
        data: {
          flowId: flowDefinitionId,
          sortOrder: order,
          title: sc.title.trim() || `Tela ${order + 1}`,
        },
      });
      let fOrder = 0;
      for (const f of sc.fields) {
        const fieldKey = f.fieldKey.trim();
        const field = await tx.whatsappFlowField.create({
          data: {
            screenId: screen.id,
            fieldKey,
            label: f.label.trim(),
            fieldType: (f.fieldType ?? "TEXT").trim(),
            options: normalizeFieldOptions(f.options),
            required: Boolean(f.required),
            sortOrder: fOrder,
          },
        });
        const m = mappingByKey.get(fieldKey);
        if (isAllowedMappingTarget(m)) {
          await tx.whatsappFlowFieldMapping.create({
            data: {
              fieldId: field.id,
              targetKind: m.targetKind,
              nativeKey: m.nativeKey?.trim() || null,
              customFieldId: m.customFieldId?.trim() || null,
            },
          });
        }
        fOrder += 1;
      }
      order += 1;
    }

    await tx.whatsappFlowDefinition.update({
      where: { id: flowDefinitionId },
      data: { updatedAt: new Date() },
    });
  });
}
