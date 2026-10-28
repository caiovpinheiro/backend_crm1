/**
 * Webchat v2 — retenção da linha do tempo e do contexto vivo
 * (docs/decisoes/webchat-widget.md §9.8). Por canal WEBCHAT, com o
 * `config.v2.events.retentionDays` dele:
 *
 *  - `webchat_events` com `createdAt` (chegada ao CRM) além da janela;
 *  - `webchat_live_contexts` sem mudança (`updatedAt`) há mais que isso.
 *
 * Apaga em lotes por id (índice `(channelId, createdAt)` nos eventos), no
 * contexto de org do canal. Sem dados do visitante em log.
 */
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
// prismaBase: varre os canais de todas as orgs (worker, sem RequestContext);
// cada canal roda depois em `withSystemContext(org)`.
import { prismaBase } from "@/lib/prisma-base";
import { readWebchatV2Config } from "@/lib/webchat/v2-config";
import { withSystemContext } from "@/lib/webhook-context";

const log = getLogger("webchat-retention");

const DAY_MS = 24 * 60 * 60 * 1000;

export type WebchatRetentionOptions = {
  now?: Date;
  /** Linhas por DELETE (padrão 2 000). */
  batchSize?: number;
  /** Teto de lotes por tabela por canal (padrão 50). */
  maxBatches?: number;
  /** Pausa entre lotes (padrão 100 ms). */
  pauseMs?: number;
};

export type WebchatRetentionChannelRun = {
  channelId: string;
  organizationId: string;
  retentionDays: number;
  cutoff: string;
  events: number;
  contexts: number;
  /** Bateu no teto de lotes: o resto sai na próxima rodada. */
  hitCap: boolean;
};

export type WebchatRetentionRun = { channels: WebchatRetentionChannelRun[] };

/** Corte de um canal: agora − `retentionDays`. */
export function webchatRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function deleteInBatches(
  findIds: (take: number) => Promise<{ id: string }[]>,
  deleteIds: (ids: string[]) => Promise<{ count: number }>,
  opts: { batchSize: number; maxBatches: number; pauseMs: number },
): Promise<{ deleted: number; hitCap: boolean }> {
  let deleted = 0;
  for (let i = 0; i < opts.maxBatches; i++) {
    const ids = (await findIds(opts.batchSize)).map((r) => r.id);
    if (ids.length === 0) return { deleted, hitCap: false };
    deleted += (await deleteIds(ids)).count;
    if (ids.length < opts.batchSize) return { deleted, hitCap: false };
    await sleep(opts.pauseMs);
  }
  return { deleted, hitCap: true };
}

/** Limpa um canal (já no contexto de org dele). */
export async function sweepWebchatChannelRetention(
  channel: { id: string; retentionDays: number },
  opts: Required<WebchatRetentionOptions>,
): Promise<{ events: number; contexts: number; hitCap: boolean; cutoff: Date }> {
  const cutoff = webchatRetentionCutoff(opts.now, channel.retentionDays);
  const events = await deleteInBatches(
    (take) =>
      prisma.webchatEvent.findMany({
        where: { channelId: channel.id, createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      }),
    (ids) => prisma.webchatEvent.deleteMany({ where: { id: { in: ids } } }),
    opts,
  );
  const contexts = await deleteInBatches(
    (take) =>
      prisma.webchatLiveContext.findMany({
        where: { channelId: channel.id, updatedAt: { lt: cutoff } },
        select: { id: true },
        take,
      }),
    // Recheca o corte: o site pode ter mudado a linha entre a busca e o DELETE.
    (ids) =>
      prisma.webchatLiveContext.deleteMany({ where: { id: { in: ids }, updatedAt: { lt: cutoff } } }),
    opts,
  );
  return {
    events: events.deleted,
    contexts: contexts.deleted,
    hitCap: events.hitCap || contexts.hitCap,
    cutoff,
  };
}

/** Uma rodada em todos os canais WEBCHAT. Falha num canal não para os outros. */
export async function sweepWebchatRetention(
  options: WebchatRetentionOptions = {},
): Promise<WebchatRetentionRun> {
  const opts: Required<WebchatRetentionOptions> = {
    now: options.now ?? new Date(),
    batchSize: options.batchSize ?? 2000,
    maxBatches: options.maxBatches ?? 50,
    pauseMs: options.pauseMs ?? 100,
  };
  const channels = await prismaBase.channel.findMany({
    where: { provider: "WEBCHAT" },
    select: { id: true, organizationId: true, config: true },
  });
  const out: WebchatRetentionChannelRun[] = [];
  for (const ch of channels) {
    const retentionDays = readWebchatV2Config(ch.config).events.retentionDays;
    try {
      const res = await withSystemContext(ch.organizationId, () =>
        sweepWebchatChannelRetention({ id: ch.id, retentionDays }, opts),
      );
      out.push({
        channelId: ch.id,
        organizationId: ch.organizationId,
        retentionDays,
        cutoff: res.cutoff.toISOString(),
        events: res.events,
        contexts: res.contexts,
        hitCap: res.hitCap,
      });
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), channelId: ch.id },
        "[webchat-retention] canal falhou",
      );
    }
  }
  return { channels: out };
}
