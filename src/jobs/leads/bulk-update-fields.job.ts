import type { Job } from "bullmq";
import type { Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  setContactCustomFieldValuesBulk,
  setDealCustomFieldValuesBulk,
  upsertContactCustomFieldValues,
  upsertDealCustomFieldValues,
} from "@/services/custom-fields";
import type { BulkUpdateFieldsPayload } from "@/lib/queue";

import {
  type BulkOperationErrorEntry,
  incrementOperationProgress,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  truncateErrorMessage,
} from "./_update-progress";

const log = getLogger("jobs.leads.bulk-update-fields");

/**
 * Tamanho do chunk: número de deals processados por iteração antes de
 * reportar progresso. 50 é um equilíbrio prático:
 *   - chunk muito pequeno → spam de updates em BulkOperation (overhead);
 *   - chunk muito grande  → frontend espera segundos sem ver progresso;
 *   - 50 com `succeeded++` por chunk dá granularidade de 2% em operações
 *     típicas (~2500 deals = 50 chunks).
 *
 * Custom: cada deal nesse handler dispara `upsertDealCustomFieldValues`
 * que abre seu próprio `prisma.$transaction(ops)`. Em N deals = N
 * transações pequenas — mais resiliente a contention do que uma trans-
 * action gigante (cuidado 7 do usuário: chunks + erros por-item).
 */
const CHUNK_SIZE = 50;

/**
 * Handler do job `bulk-update-fields` da fila `leads-bulk`.
 *
 * Pré-condições:
 *   - chamado dentro de `withSystemContext(organizationId, ...)` pelo worker;
 *   - `BulkOperation` correspondente existe no DB com status PENDING/PROCESSING.
 *
 * Fluxo:
 *   1. Valida que dealIds e customFieldIds pertencem à org (defesa em
 *      profundidade — o request handler já validou, mas o worker roda em
 *      processo separado e o estado pode ter mudado entre enqueue e
 *      processamento).
 *   2. Marca PROCESSING.
 *   3. Itera deals em chunks de 50, upsertando cada custom field via
 *      `upsertDealCustomFieldValues` (reusa a lógica do service).
 *   4. Reporta progresso a cada chunk.
 *   5. Erros por-deal são acumulados em `errors[]` e não param o worker.
 *   6. Marca operação como COMPLETED/PARTIAL/FAILED com base nos contadores.
 *
 * Idempotência:
 *   - `upsert` é naturalmente idempotente (update se existe, create senão).
 *   - Se o job re-rodar (retry/duplicate), reaplica o mesmo valor — sem
 *     side effect (custom fields não disparam triggers de automação hoje).
 */
export async function processBulkUpdateFields(
  payload: BulkUpdateFieldsPayload,
  job: Job<BulkUpdateFieldsPayload>,
): Promise<void> {
  const {
    operationId,
    organizationId,
    dealIds,
    updates,
    contactCustom = [],
    dealNative,
    contactNative,
    tagIds = [],
  } = payload;

  // Normaliza os patches de campos nativos (somente chaves presentes).
  const dealNativePatch = buildDealNativePatch(dealNative);
  const contactNativePatch = buildContactNativePatch(contactNative);

  const ctx = log.child({
    operationId,
    organizationId,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
    dealCount: dealIds.length,
    dealFieldCount: updates.length,
    contactFieldCount: contactCustom.length,
    tagCount: tagIds.length,
    dealNative: dealNativePatch ? Object.keys(dealNativePatch) : [],
    contactNative: contactNativePatch ? Object.keys(contactNativePatch) : [],
  });
  ctx.info("Iniciando bulk-update-fields");

  const hasAnyWork =
    updates.length > 0 ||
    contactCustom.length > 0 ||
    dealNativePatch !== null ||
    contactNativePatch !== null ||
    tagIds.length > 0;

  if (dealIds.length === 0 || !hasAnyWork) {
    await markOperationFailed(
      operationId,
      organizationId,
      "Payload vazio (dealIds ausentes ou nenhuma alteração informada)",
    );
    ctx.warn("Payload vazio — operação marcada como FAILED");
    return;
  }

  await markOperationStarted(operationId, organizationId);

  // Valida que os custom fields de DEAL pertencem à org e ao escopo "deal".
  // Filtra inválidos — não rejeita a operação inteira; registra e prossegue.
  const dealFieldIds = updates.map((u) => u.fieldId);
  const validDealFields = dealFieldIds.length
    ? await prisma.customField.findMany({
        where: { id: { in: dealFieldIds }, entity: "deal" },
        select: { id: true },
      })
    : [];
  const validDealFieldIds = new Set(validDealFields.map((f) => f.id));
  const invalidDealFieldIds = dealFieldIds.filter((id) => !validDealFieldIds.has(id));
  const validDealUpdates = updates.filter((u) => validDealFieldIds.has(u.fieldId));

  if (invalidDealFieldIds.length > 0) {
    ctx.warn(
      { invalidDealFieldIds },
      "Custom fields de deal inválidos ignorados (org/entity)",
    );
  }

  // Valida custom fields de CONTATO (entity = "contact").
  const contactFieldIds = contactCustom.map((u) => u.fieldId);
  const validContactFields = contactFieldIds.length
    ? await prisma.customField.findMany({
        where: { id: { in: contactFieldIds }, entity: "contact" },
        select: { id: true },
      })
    : [];
  const validContactFieldIds = new Set(validContactFields.map((f) => f.id));
  const invalidContactFieldIds = contactFieldIds.filter(
    (id) => !validContactFieldIds.has(id),
  );
  const validContactUpdates = contactCustom.filter((u) =>
    validContactFieldIds.has(u.fieldId),
  );

  if (invalidContactFieldIds.length > 0) {
    ctx.warn(
      { invalidContactFieldIds },
      "Custom fields de contato inválidos ignorados (org/entity)",
    );
  }

  // Só tenta resolver o contato quando há trabalho VÁLIDO de contato — evita
  // marcar "sem contato" como falha quando os campos de contato foram todos
  // descartados na validação acima.
  const hasContactWork =
    validContactUpdates.length > 0 || contactNativePatch !== null;

  // Valida tags (pertencem à org — Prisma extension faz o scoping).
  const validTagIds = tagIds.length
    ? (
        await prisma.tag.findMany({
          where: { id: { in: tagIds } },
          select: { id: true },
        })
      ).map((t) => t.id)
    : [];

  // Se NADA sobrou de válido após o filtro, falha cedo.
  const hasValidWork =
    validDealUpdates.length > 0 ||
    validContactUpdates.length > 0 ||
    dealNativePatch !== null ||
    contactNativePatch !== null ||
    validTagIds.length > 0;
  if (!hasValidWork) {
    await markOperationFailed(
      operationId,
      organizationId,
      "Nenhuma alteração válida após validação (campos/tags inválidos para a org)",
    );
    return;
  }

  // Confere quais deals realmente pertencem à org. dealIds que não existem
  // (ou foram movidos para outra org via super-admin) são registrados como
  // erro mas não travam a operação.
  const existingDeals = await prisma.deal.findMany({
    where: { id: { in: dealIds } },
    select: { id: true },
  });
  const existingDealIds = new Set(existingDeals.map((d) => d.id));
  const missingDealIds = dealIds.filter((id) => !existingDealIds.has(id));

  if (missingDealIds.length > 0) {
    const now = new Date().toISOString();
    const missingErrors: BulkOperationErrorEntry[] = missingDealIds.map(
      (dealId) => ({
        itemId: dealId,
        message: "Deal não encontrado ou não pertence à organização",
        attempt: job.attemptsMade + 1,
        at: now,
      }),
    );
    await incrementOperationProgress(
      operationId,
      organizationId,
      { processed: missingDealIds.length, failed: missingDealIds.length },
      missingErrors,
    );
    ctx.warn({ missingCount: missingDealIds.length }, "Deals ausentes pulados");
  }

  // Processa em chunks. Cada deal é processado isoladamente — falha em
  // um deal não trava o restante do chunk. Erros por-deal são capturados
  // em `errors[]`; erros de infraestrutura (DB down) são re-thrown para
  // BullMQ retry do job inteiro.
  const dealsToProcess = [...existingDealIds];
  for (let i = 0; i < dealsToProcess.length; i += CHUNK_SIZE) {
    const chunk = dealsToProcess.slice(i, i + CHUNK_SIZE);
    const chunkErrors: BulkOperationErrorEntry[] = [];
    let chunkSucceeded = 0;
    let chunkFailed = 0;

    const bundle: DealUpdateBundle = {
      dealCustom: validDealUpdates,
      dealNativePatch,
      contactCustom: validContactUpdates,
      contactNativePatch,
      tagIds: validTagIds,
      hasContactWork,
    };

    try {
      const outcome = await applyChunkUpdates(chunk, bundle);
      chunkSucceeded = outcome.succeeded;
      chunkFailed = outcome.failedDealIds.length;
      const now = new Date().toISOString();
      for (const dealId of outcome.failedDealIds) {
        chunkErrors.push({
          itemId: dealId,
          message: NO_CONTACT_MESSAGE,
          attempt: job.attemptsMade + 1,
          at: now,
        });
      }
    } catch (err) {
      // O lote é all-or-nothing por operação; um erro aqui apaga a
      // granularidade por-item que a operação em massa reporta. Cai para o
      // caminho deal-a-deal (idempotente) só neste chunk.
      ctx.warn(
        { err, chunkIndex: Math.floor(i / CHUNK_SIZE) },
        "Lote falhou — reprocessando o chunk deal a deal",
      );
      chunkErrors.length = 0;
      chunkSucceeded = 0;
      chunkFailed = 0;

      for (const dealId of chunk) {
        try {
          await applyDealUpdates(dealId, bundle);
          chunkSucceeded += 1;
        } catch (itemErr) {
          chunkFailed += 1;
          chunkErrors.push({
            itemId: dealId,
            message: truncateErrorMessage(itemErr),
            attempt: job.attemptsMade + 1,
            at: new Date().toISOString(),
          });
          ctx.error(
            { dealId, err: itemErr },
            "Falha aplicando campos/tags a deal",
          );
        }
      }
    }

    await incrementOperationProgress(
      operationId,
      organizationId,
      {
        processed: chunk.length,
        succeeded: chunkSucceeded,
        failed: chunkFailed,
      },
      chunkErrors.length > 0 ? chunkErrors : undefined,
    );

    ctx.info(
      {
        chunkIndex: Math.floor(i / CHUNK_SIZE),
        chunkSucceeded,
        chunkFailed,
        progress: `${Math.min(i + chunk.length, dealsToProcess.length)}/${dealsToProcess.length}`,
      },
      "Chunk concluído",
    );
  }

  await markOperationFinished(operationId, organizationId);
  ctx.info("bulk-update-fields finalizado");
}

// ── Helpers ──────────────────────────────────────────────────────

type DealUpdateBundle = {
  dealCustom: { fieldId: string; value: string }[];
  dealNativePatch: Prisma.DealUpdateManyMutationInput | null;
  contactCustom: { fieldId: string; value: string }[];
  contactNativePatch: Prisma.ContactUpdateManyMutationInput | null;
  tagIds: string[];
  hasContactWork: boolean;
};

const NO_CONTACT_MESSAGE =
  "Negócio sem contato vinculado — campos de contato não aplicados";

/**
 * Aplica o bundle a um chunk inteiro com operações em lote. Substitui o
 * laço deal-a-deal no caminho feliz; o chamador cai de volta em
 * `applyDealUpdates` se qualquer etapa falhar, para não perder a
 * granularidade de erro por item.
 *
 * A ordem e o escopo espelham `applyDealUpdates`:
 *   - custom fields e nativos do DEAL valem para todos os deals do chunk,
 *     inclusive os que não têm contato (lá eles já eram aplicados antes do
 *     throw);
 *   - contato e tags só valem para os deals que sobrevivem ao check de
 *     contato, porque o throw acontecia antes das tags.
 */
async function applyChunkUpdates(
  dealIds: string[],
  bundle: DealUpdateBundle,
): Promise<{ succeeded: number; failedDealIds: string[] }> {
  const {
    dealCustom,
    dealNativePatch,
    contactCustom,
    contactNativePatch,
    tagIds,
    hasContactWork,
  } = bundle;

  if (dealCustom.length > 0) {
    await setDealCustomFieldValuesBulk(dealIds, dealCustom);
  }

  if (dealNativePatch) {
    await prisma.deal.updateMany({
      where: { id: { in: dealIds } },
      data: dealNativePatch,
    });
  }

  let taggableDealIds = dealIds;
  const failedDealIds: string[] = [];

  if (hasContactWork) {
    // Um findMany para o chunk no lugar de um findUnique por deal.
    const deals = await prisma.deal.findMany({
      where: { id: { in: dealIds } },
      select: { id: true, contactId: true },
    });
    const contactByDeal = new Map(deals.map((d) => [d.id, d.contactId]));

    taggableDealIds = [];
    const contactIds = new Set<string>();
    for (const dealId of dealIds) {
      const contactId = contactByDeal.get(dealId) ?? null;
      if (!contactId) {
        failedDealIds.push(dealId);
        continue;
      }
      taggableDealIds.push(dealId);
      contactIds.add(contactId);
    }

    const uniqueContactIds = [...contactIds];
    if (uniqueContactIds.length > 0) {
      if (contactCustom.length > 0) {
        await setContactCustomFieldValuesBulk(uniqueContactIds, contactCustom);
      }
      if (contactNativePatch) {
        await prisma.contact.updateMany({
          where: { id: { in: uniqueContactIds } },
          data: contactNativePatch,
        });
      }
    }
  }

  if (tagIds.length > 0 && taggableDealIds.length > 0) {
    // `@@id([dealId, tagId])` + skipDuplicates dão o mesmo efeito do
    // upsert por tag, em uma query por chunk.
    await prisma.tagOnDeal.createMany({
      data: taggableDealIds.flatMap((dealId) =>
        tagIds.map((tagId) => ({ dealId, tagId })),
      ),
      skipDuplicates: true,
    });
  }

  return {
    succeeded: dealIds.length - failedDealIds.length,
    failedDealIds,
  };
}

/**
 * Aplica TODAS as alterações de um único deal. Ordem:
 *   1. custom fields do deal (upsert)
 *   2. campos nativos do deal (update)
 *   3. resolve o contato vinculado → custom fields + nativos do contato
 *   4. tags do deal (upsert idempotente em TagOnDeal)
 *
 * Roda dentro do `withSystemContext` do worker, então a Prisma extension
 * já faz o scoping por organização. Erros sobem para o caller, que os
 * registra por-item em `BulkOperation.errors` sem travar o lote.
 */
async function applyDealUpdates(
  dealId: string,
  bundle: DealUpdateBundle,
): Promise<void> {
  const {
    dealCustom,
    dealNativePatch,
    contactCustom,
    contactNativePatch,
    tagIds,
    hasContactWork,
  } = bundle;

  if (dealCustom.length > 0) {
    await upsertDealCustomFieldValues(dealId, dealCustom);
  }

  if (dealNativePatch) {
    await prisma.deal.update({ where: { id: dealId }, data: dealNativePatch });
  }

  // Lado contato: resolve o contactId do deal e aplica os updates. Se o deal
  // não tem contato, registra como erro por-item (não silencioso) só quando
  // havia trabalho de contato a fazer.
  if (hasContactWork) {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { contactId: true },
    });
    const contactId = deal?.contactId ?? null;
    if (!contactId) {
      throw new Error(NO_CONTACT_MESSAGE);
    }
    if (contactCustom.length > 0) {
      await upsertContactCustomFieldValues(contactId, contactCustom);
    }
    if (contactNativePatch) {
      await prisma.contact.update({
        where: { id: contactId },
        data: contactNativePatch,
      });
    }
  }

  if (tagIds.length > 0) {
    for (const tagId of tagIds) {
      await prisma.tagOnDeal.upsert({
        where: { dealId_tagId: { dealId, tagId } },
        update: {},
        create: { dealId, tagId },
      });
    }
  }
}

/**
 * Monta o patch de campos nativos do Deal. Retorna null se nada a aplicar.
 * `value` chega como string numérica (já validada na rota); o Prisma aceita
 * string para colunas Decimal. `expectedClose` vira Date, ou null para limpar.
 */
function buildDealNativePatch(
  native: BulkUpdateFieldsPayload["dealNative"],
): Prisma.DealUpdateManyMutationInput | null {
  if (!native) return null;
  const patch: Prisma.DealUpdateManyMutationInput = {};
  if (typeof native.title === "string" && native.title.length > 0) {
    patch.title = native.title;
  }
  if (typeof native.value === "string" && native.value.length > 0) {
    patch.value = native.value;
  }
  if (native.expectedClose !== undefined) {
    patch.expectedClose =
      native.expectedClose && native.expectedClose.length > 0
        ? new Date(native.expectedClose)
        : null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Monta o patch de campos nativos do Contato. Retorna null se nada a aplicar.
 * Nenhum desses campos é `@unique` no schema, então bulk-set do mesmo valor
 * em vários contatos não viola constraint.
 */
function buildContactNativePatch(
  native: BulkUpdateFieldsPayload["contactNative"],
): Prisma.ContactUpdateManyMutationInput | null {
  if (!native) return null;
  const patch: Prisma.ContactUpdateManyMutationInput = {};
  if (typeof native.name === "string" && native.name.length > 0) {
    patch.name = native.name;
  }
  if (typeof native.email === "string" && native.email.length > 0) {
    patch.email = native.email;
  }
  if (typeof native.phone === "string" && native.phone.length > 0) {
    patch.phone = native.phone;
  }
  if (typeof native.source === "string" && native.source.length > 0) {
    patch.source = native.source;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
