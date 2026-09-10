/**
 * Trava de disparo por lote (`Campaign.sendLimit` / `Campaign.sendCap`).
 *
 * A audiência inteira é materializada em `campaign_recipients`; a trava só
 * limita quantos são processados por rodada. Ao bater `sendCap` com
 * destinatários ainda PENDING, a campanha vai para PAUSED e cada `resume`
 * libera outro lote.
 *
 * Parada aproximada: `campaign-counters` flusha em lote e os envios correm em
 * paralelo, então o corte pode passar alguns envios do limite. Corte exato
 * exigiria um lock por envio — inviável em blast de dezenas de milhares.
 */

/** Resolve valor de escrita: ausente, zero ou inválido → sem trava. */
export function resolveCampaignSendLimit(
  sendLimit?: number | null,
): number | null {
  if (sendLimit === undefined || sendLimit === null) return null;
  if (!Number.isFinite(sendLimit)) return null;
  const n = Math.floor(sendLimit);
  return n > 0 ? n : null;
}

/** Teto acumulado da próxima rodada, a partir do que já foi processado. */
export function nextCampaignSendCap(
  processed: number,
  sendLimit: number,
): number {
  return Math.max(0, processed) + sendLimit;
}
