import { prismaBase } from "@/lib/prisma-base";

/**
 * Contadores denormalizados da Campaign (sentCount/deliveredCount/readCount/
 * failedCount). Em blast (~2k destinatários × 3-4 eventos) o caminho antigo
 * fazia 1 UPDATE por evento na MESMA row — lock contention no Postgres
 * compartilhado com a API (CRM congelava durante ativação).
 *
 * Aqui acumulamos em memória e flushamos em lote (por quantidade ou janela
 * de tempo). A UI de campanha passa a ver contadores com ~2s de atraso —
 * aceitável. A fonte da verdade continua sendo CampaignRecipient.status.
 *
 * Buffer é por processo (campaign-worker e meta-webhook-worker flusham
 * independentemente). Perda em crash é tolerável: contadores são
 * denormalizados e reconciliáveis a partir de CampaignRecipient.
 */

export type CampaignCounterField =
  | "sentCount"
  | "deliveredCount"
  | "readCount"
  | "failedCount";

type Pending = {
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  timer: NodeJS.Timeout | null;
};

const FLUSH_THRESHOLD = 50;
const FLUSH_INTERVAL_MS = 2_000;

const globalForCounters = globalThis as unknown as {
  campaignCounterBuffer?: Map<string, Pending>;
};

function buffer(): Map<string, Pending> {
  return (globalForCounters.campaignCounterBuffer ??= new Map());
}

async function flush(campaignId: string): Promise<void> {
  const buf = buffer();
  const p = buf.get(campaignId);
  if (!p) return;
  if (p.timer) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  const data: Record<string, { increment: number }> = {};
  if (p.sentCount > 0) data.sentCount = { increment: p.sentCount };
  if (p.deliveredCount > 0) data.deliveredCount = { increment: p.deliveredCount };
  if (p.readCount > 0) data.readCount = { increment: p.readCount };
  if (p.failedCount > 0) data.failedCount = { increment: p.failedCount };
  buf.delete(campaignId);
  if (Object.keys(data).length === 0) return;
  const sentOrFailed = Boolean(data.sentCount || data.failedCount);
  try {
    // prismaBase: workers rodam fora de RequestContext; campaign.update por id
    // não precisa de filtro de tenant (id é global único).
    await prismaBase.campaign.update({ where: { id: campaignId }, data });
  } catch (err) {
    console.warn(
      `[campaign-counters] flush falhou campaign=${campaignId}:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }
  // O flush do timer (2s) é o último evento da campanha — se não concluirmos
  // aqui, o status fica SENDING com 100% na UI para sempre.
  if (sentOrFailed) await maybeCompleteCampaign(campaignId);
}

/**
 * Marca COMPLETED quando sent+failed já cobriu o total — ou PAUSED quando a
 * trava por lote (`sendCap`) foi atingida e ainda há destinatários pendentes.
 * Idempotente.
 *
 * Tem de viver neste módulo (não no worker) para o flush do timer também
 * concluir — o worker só chama o check em 1/N envios.
 */
export async function maybeCompleteCampaign(campaignId: string): Promise<void> {
  const campaign = await prismaBase.campaign.findUnique({
    where: { id: campaignId },
    select: {
      totalRecipients: true,
      sentCount: true,
      failedCount: true,
      sendCap: true,
      status: true,
    },
  });
  if (!campaign || campaign.status !== "SENDING") return;
  const processed = campaign.sentCount + campaign.failedCount;

  if (processed < campaign.totalRecipients) {
    if (campaign.sendCap === null || processed < campaign.sendCap) return;
    // Trava batida com pendentes: pausa e espera o `resume` liberar o próximo
    // lote. O claim do rodízio já parou de reivindicar desta campanha.
    await prismaBase.campaign.update({
      where: { id: campaignId },
      data: { status: "PAUSED" },
    });
    console.info(
      `[campaign-send] Campaign ${campaignId} pausada na trava: ${processed}/${campaign.totalRecipients} processados (cap ${campaign.sendCap})`,
    );
    return;
  }

  await prismaBase.campaign.update({
    where: { id: campaignId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  console.info(
    `[campaign-send] Campaign ${campaignId} completed: ${campaign.sentCount} sent, ${campaign.failedCount} failed`,
  );
}

export function incrementCampaignCounter(
  campaignId: string,
  field: CampaignCounterField,
  by = 1,
): void {
  const buf = buffer();
  const p = buf.get(campaignId) ?? {
    sentCount: 0,
    deliveredCount: 0,
    readCount: 0,
    failedCount: 0,
    timer: null,
  };
  p[field] += by;
  buf.set(campaignId, p);

  const total = p.sentCount + p.deliveredCount + p.readCount + p.failedCount;
  if (total >= FLUSH_THRESHOLD) {
    void flush(campaignId);
    return;
  }
  if (!p.timer) {
    p.timer = setTimeout(() => void flush(campaignId), FLUSH_INTERVAL_MS);
    p.timer.unref?.();
  }
}

/** Força flush — usar antes de ler contadores (ex.: check de conclusão). */
export async function flushCampaignCounters(campaignId: string): Promise<void> {
  await flush(campaignId);
}
