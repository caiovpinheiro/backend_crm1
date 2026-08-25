/**
 * Smoke controlado pós-deploy (staging): 1 campanha TEMPLATE na org "teste",
 * N recipients, jobs "send" enfileirados direto na campaign-send.
 * Exercita worker-whatsapp -> mock-graph -> markRecipientSent sem disparar
 * o dispatch em massa. Uso: node _smoke-mini.mjs  (env: PG_URL, REDIS_URL, SMOKE_N)
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const N = Number(process.env.SMOKE_N || 300);
const RUN = `smk${Date.now().toString(36)}`;

const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 3 });
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const sendQueue = new Queue("campaign-send", { connection });

const org = (
  await pool.query(`
    SELECT o.id,
           (SELECT ch.id FROM channels ch WHERE ch."organizationId" = o.id
              AND ch.provider = 'META_CLOUD_API' AND ch.status = 'CONNECTED'
              ORDER BY ch.number LIMIT 1) AS channel_id,
           (SELECT u.id FROM users u WHERE u."organizationId" = o.id LIMIT 1) AS user_id
      FROM organizations o WHERE o.name = 'teste'`)
).rows[0];
if (!org?.channel_id || !org?.user_id) throw new Error("org 'teste' sem canal/usuário");

const campaignId = `cmp_${RUN}_smoke`;
const num = (
  await pool.query(
    `SELECT COALESCE(MAX(number),0)::int + 1 AS n FROM campaigns WHERE "organizationId" = $1`,
    [org.id],
  )
).rows[0].n;

await pool.query(
  `INSERT INTO campaigns
     (id, name, type, status, "channelId", "createdById", "organizationId",
      "templateName", "templateLanguage", filters, number, "sendRate", "createdAt", "updatedAt")
   VALUES ($1,$2,'TEMPLATE','SENDING',$3,$4,$5,'stress_template','pt_BR','{}'::jsonb,$6,15,now(),now())`,
  [campaignId, `__SMOKE__ ${RUN}`, org.channel_id, org.user_id, org.id, num],
);

const contacts = (
  await pool.query(
    `SELECT id, phone, whatsapp_bsuid FROM contacts
      WHERE "organizationId" = $1 AND phone IS NOT NULL ORDER BY id LIMIT $2`,
    [org.id, N],
  )
).rows;

const t0 = Date.now();
const jobs = [];
for (let i = 0; i < contacts.length; i++) {
  const c = contacts[i];
  const rid = `rcpt_${RUN}_${i}`;
  await pool.query(
    `INSERT INTO campaign_recipients (id, "campaignId", "contactId", status, "organizationId", "createdAt")
     VALUES ($1,$2,$3,'PENDING',$4,now())`,
    [rid, campaignId, c.id, org.id],
  );
  jobs.push({
    name: "send",
    data: {
      campaignId,
      recipientId: rid,
      contactId: c.id,
      contactPhone: c.phone,
      contactBsuid: c.whatsapp_bsuid ?? undefined,
    },
    opts: {
      removeOnComplete: true,
      removeOnFail: { count: 1000 },
      attempts: 6,
      backoff: { type: "exponential", delay: 3000 },
    },
  });
}
await sendQueue.addBulk(jobs);
console.log(`[smoke] run=${RUN} campaign=${campaignId} enfileirados=${jobs.length}`);

for (;;) {
  const r = (
    await pool.query(
      `SELECT status, count(*)::int c FROM campaign_recipients WHERE "campaignId" = $1 GROUP BY 1`,
      [campaignId],
    )
  ).rows;
  const map = Object.fromEntries(r.map((x) => [x.status, x.c]));
  const done = (map.SENT ?? 0) + (map.FAILED ?? 0) + (map.DELIVERED ?? 0) + (map.READ ?? 0);
  console.log(`[smoke] ${JSON.stringify(map)} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (done >= contacts.length) break;
  if (Date.now() - t0 > 180_000) {
    console.log("[smoke] TIMEOUT");
    break;
  }
  await new Promise((r2) => setTimeout(r2, 5000));
}

const elapsed = (Date.now() - t0) / 1000;
const fin = (
  await pool.query(
    `SELECT status, count(*)::int c FROM campaign_recipients WHERE "campaignId" = $1 GROUP BY 1`,
    [campaignId],
  )
).rows;
console.log(
  `[smoke] FINAL ${JSON.stringify(Object.fromEntries(fin.map((x) => [x.status, x.c])))} ` +
    `elapsed=${elapsed.toFixed(1)}s throughput=${(contacts.length / elapsed).toFixed(1)}/s`,
);

await sendQueue.close();
await connection.quit();
await pool.end();
