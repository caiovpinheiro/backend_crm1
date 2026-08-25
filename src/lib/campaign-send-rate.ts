/**
 * Hard caps for Campaign.sendRate.
 *
 * Unit: messages per second (msgs/s) — see prisma Campaign.sendRate and
 * `waitForMetaThrottle` in campaign-worker (`intervalMs = 1000 / rate`).
 *
 * Env overrides (ops):
 * - CAMPAIGN_SEND_RATE_MAX (default 30)
 * - CAMPAIGN_SEND_RATE_DEFAULT (default 20, never above max)
 * - CAMPAIGN_SEND_CONCURRENCY (default 4) — used by campaign-worker
 */

function envPositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

/** Sensible defaults when env is unset. */
export const CAMPAIGN_SEND_RATE_MAX = 30;
export const CAMPAIGN_SEND_RATE_DEFAULT = 20;
export const CAMPAIGN_SEND_CONCURRENCY_DEFAULT = 4;

/** Absolute ceiling for campaign sendRate (msgs/s). */
export function getCampaignSendRateMax(): number {
  return envPositiveInt("CAMPAIGN_SEND_RATE_MAX", CAMPAIGN_SEND_RATE_MAX);
}

/** Default for new campaigns when sendRate is unset. */
export function getCampaignSendRateDefault(): number {
  const max = getCampaignSendRateMax();
  const d = envPositiveInt("CAMPAIGN_SEND_RATE_DEFAULT", CAMPAIGN_SEND_RATE_DEFAULT);
  return Math.min(d, max);
}

/** Clamp to [1, max] — defense-in-depth for worker + writes. */
export function clampCampaignSendRate(sendRate: number): number {
  const max = getCampaignSendRateMax();
  if (!Number.isFinite(sendRate)) return getCampaignSendRateDefault();
  return Math.max(1, Math.min(max, Math.floor(sendRate)));
}

/** Resolve write value: unset → default; set → clamp. */
export function resolveCampaignSendRate(sendRate?: number | null): number {
  if (sendRate === undefined || sendRate === null) {
    return getCampaignSendRateDefault();
  }
  return clampCampaignSendRate(sendRate);
}

/** BullMQ send-worker concurrency (lower = less PG/Meta pressure). */
export function getCampaignSendConcurrency(): number {
  return envPositiveInt(
    "CAMPAIGN_SEND_CONCURRENCY",
    CAMPAIGN_SEND_CONCURRENCY_DEFAULT,
  );
}

/**
 * Rodízio com reabastecimento do Postgres no consumo de campanhas.
 * Ligado por default; CAMPAIGN_SEND_ROUND_ROBIN=0/false/off volta ao
 * Worker BullMQ FIFO antigo (rollback sem rebuild — o dispatch também
 * volta a enfileirar em `campaign-send`).
 */
export function isCampaignSendRoundRobinEnabled(): boolean {
  const raw = (process.env.CAMPAIGN_SEND_ROUND_ROBIN ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * Crédito por org por ciclo do rodízio: máximo de recipients reivindicados
 * de uma org numa rodada. É o que impede uma org de monopolizar o envio.
 */
export function getCampaignOrgCredit(): number {
  return envPositiveInt("CAMPAIGN_ORG_CREDIT", 200);
}

/**
 * Prefetch da janela 24h no claim do rodízio (elimina o N+1 de
 * `isWithinMetaWindow` — 1 query por lote em vez de 1 por destinatário
 * TEXT). Ligado por default; CAMPAIGN_WINDOW_PREFETCH=0/false/off volta ao
 * check ao vivo por destinatário (rollback sem rebuild).
 */
export function isCampaignWindowPrefetchEnabled(): boolean {
  const raw = (process.env.CAMPAIGN_WINDOW_PREFETCH ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * Válvula global ALTA do rodízio (msg/s) — proteção do Postgres, NÃO rate
 * limit da Meta. Usada só no modo de slot por phoneNumberId (2.4): cada
 * phone tem seu teto real (min(WHATSAPP_RATE_LIMIT_MAX,
 * CAMPAIGN_SEND_RATE_MAX)) e esta válvula limita a soma de todos contra o
 * banco. Default 500/s. O teto por phone sobe gradualmente via
 * CAMPAIGN_SEND_RATE_MAX (30 → 50 → 80), sem rebuild.
 */
export function getCampaignSendGlobalRateMax(): number {
  return envPositiveInt("CAMPAIGN_SEND_GLOBAL_RATE_MAX", 500);
}

/**
 * Slot de envio por phoneNumberId (2.4). Ligado por default;
 * CAMPAIGN_SEND_PER_PHONE_SLOT=0/false/off volta ao teto global único
 * `campaign:send:global-slot` (rollback sem rebuild).
 */
export function isCampaignPerPhoneSlotEnabled(): boolean {
  const raw = (process.env.CAMPAIGN_SEND_PER_PHONE_SLOT ?? "")
    .trim()
    .toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}
