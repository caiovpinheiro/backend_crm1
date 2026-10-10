/**
 * Corrige Message.channelId de disparos de campanha que herdaram o canal da
 * conversa antiga em vez do canal usado no envio Meta.
 *
 * Critério 100% determinístico: campaign_recipients.metaMessageId =
 * messages.externalId (wamid). O canal correto é campaigns.channelId.
 *
 * Idempotente. Uso:
 *   DATABASE_URL=... node scripts/backfill-campaign-message-channel.mjs
 *   DATABASE_URL=... node scripts/backfill-campaign-message-channel.mjs --apply
 *   TARGET_ORG_ID=<org> DATABASE_URL=... node scripts/backfill-campaign-message-channel.mjs [--apply]
 */
import { Client } from "pg";

import { pgConnectionConfig } from "./lib/pg-ssl.mjs";

const APPLY = process.argv.includes("--apply");
const TARGET_ORG = process.env.TARGET_ORG_ID ?? null;

const c = new Client(pgConnectionConfig());
await c.connect();

const orgClause = TARGET_ORG ? `AND camp."organizationId" = $1` : "";
const params = TARGET_ORG ? [TARGET_ORG] : [];

const selectSql = `
  SELECT
    m.id AS message_id,
    m."channelId" AS old_channel_id,
    camp."channelId" AS new_channel_id,
    camp.name AS campaign_name,
    ch_old.name AS old_channel,
    ch_new.name AS new_channel
  FROM campaign_recipients cr
  JOIN campaigns camp ON camp.id = cr."campaignId"
  JOIN messages m ON m."externalId" = cr."metaMessageId"
  LEFT JOIN channels ch_old ON ch_old.id = m."channelId"
  LEFT JOIN channels ch_new ON ch_new.id = camp."channelId"
  WHERE cr."metaMessageId" IS NOT NULL
    AND cr."metaMessageId" <> ''
    AND m.direction = 'out'
    AND camp."channelId" IS NOT NULL
    AND m."channelId" IS DISTINCT FROM camp."channelId"
    ${orgClause}
`;

const rows = (await c.query(selectSql, params)).rows;
console.log(
  `[backfill-campaign-message-channel] ${rows.length} mensagem(ns) com canal diferente do disparo`,
);
const sample = rows.slice(0, 15).map((r) => ({
  campaign: r.campaign_name,
  from: r.old_channel,
  to: r.new_channel,
}));
if (sample.length) console.log(JSON.stringify(sample, null, 2));

if (!APPLY) {
  console.log("Dry-run. Passe --apply para gravar.");
  await c.end();
  process.exit(0);
}

const updateSql = `
  UPDATE messages m
  SET "channelId" = camp."channelId"
  FROM campaign_recipients cr
  JOIN campaigns camp ON camp.id = cr."campaignId"
  WHERE cr."metaMessageId" IS NOT NULL
    AND cr."metaMessageId" <> ''
    AND m."externalId" = cr."metaMessageId"
    AND m.direction = 'out'
    AND camp."channelId" IS NOT NULL
    AND m."channelId" IS DISTINCT FROM camp."channelId"
    ${orgClause}
`;
const updated = await c.query(updateSql, params);
console.log(`[backfill-campaign-message-channel] atualizadas: ${updated.rowCount ?? 0}`);
await c.end();
