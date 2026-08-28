/**
 * Cria e lança campanhas de stress, replicando o que POST /api/campaigns/[id]/launch
 * faz (a rota exige sessão NextAuth, inviável para 6 orgs distintas).
 * O trabalho real — resolver destinatários, criar recipients, enfileirar os
 * envios e chamar a Graph — continua inteiramente a cargo dos workers.
 *
 *   node launch.mjs --orgs=all --limit=20000 [--dry]
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const PG_URL = process.env.PG_URL;
const REDIS_URL = process.env.REDIS_URL;
const CAMPAIGN_DISPATCH_QUEUE_NAME = "campaign-dispatch";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const LIMIT = Number(args.limit || 20000);
const RUN = `str${Date.now().toString(36)}`;

const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const dispatchQueue = new Queue(CAMPAIGN_DISPATCH_QUEUE_NAME, { connection });

const orgs = (await pool.query(`
  SELECT o.id, o.name,
         (SELECT ch.id FROM channels ch
           WHERE ch."organizationId" = o.id AND ch.provider = 'META_CLOUD_API'
             AND ch.status = 'CONNECTED' ORDER BY ch.number LIMIT 1) AS channel_id,
         (SELECT u.id FROM users u WHERE u."organizationId" = o.id LIMIT 1) AS user_id,
         (SELECT count(*)::int FROM contacts c
           WHERE c."organizationId" = o.id AND c.phone IS NOT NULL) AS elegiveis
    FROM organizations o
   ORDER BY o.name`)).rows;

const alvo = args.only
  ? orgs.filter((o) => o.name.toLowerCase().includes(String(args.only).toLowerCase()))
  : orgs;

console.log(`[launch] run=${RUN} orgs=${alvo.length} limite/org=${LIMIT}`);

const created = [];
for (const org of alvo) {
  if (!org.channel_id || !org.user_id) {
    console.warn(`[launch] ${org.name}: sem canal conectado ou sem usuário — pulando`);
    continue;
  }

  // O dispatch resolve destinatários por `filters` (SegmentFilters). Um objeto
  // vazio significa "todos os contatos da org com telefone", que é o cenário
  // de campanha ampla que queremos medir.
  const campaignId = `cmp_${RUN}_${org.id.slice(-8)}`;
  const num = (await pool.query(
    `SELECT COALESCE(MAX(number),0)::int + 1 AS n FROM campaigns WHERE "organizationId"=$1`,
    [org.id],
  )).rows[0].n;

  if (args.dry) {
    console.log(`[launch] (dry) ${org.name}: ${org.elegiveis} elegíveis, canal ${org.channel_id}`);
    continue;
  }

  // TEMPLATE, não TEXT: campanha para contato sem inbound recente cai em
  // META_WINDOW_EXPIRED_24H no caminho de texto (campaign-worker L605-608).
  // Template é o que uma campanha ampla de verdade usaria.
  await pool.query(
    `INSERT INTO campaigns
       (id, name, type, status, "channelId", "createdById", "organizationId",
        "templateName", "templateLanguage", filters, number, "sendRate",
        "createdAt", "updatedAt")
     VALUES ($1,$2,'TEMPLATE','DRAFT',$3,$4,$5,$6,$7,$8::jsonb,$9,$10, now(), now())`,
    [
      campaignId,
      `__STRESS__ ${RUN} ${org.name}`,
      org.channel_id,
      org.user_id,
      org.id,
      "stress_template",
      "pt_BR",
      JSON.stringify({}),
      num,
      Number(process.env.SEND_RATE || 15),
    ],
  );

  // Espelha a rota: DRAFT -> PROCESSING e enfileira o dispatch.
  await pool.query(`UPDATE campaigns SET status='PROCESSING' WHERE id=$1`, [campaignId]);
  await dispatchQueue.add("dispatch", { campaignId }, {
    removeOnComplete: true,
    removeOnFail: 50,
  });

  created.push({ org: org.name, campaignId, elegiveis: org.elegiveis });
  console.log(`[launch] ${org.name}: campanha ${campaignId} lançada (${org.elegiveis} elegíveis)`);
}

console.log(`\n[launch] ${created.length} campanhas lançadas — run=${RUN}`);
console.log(JSON.stringify(created, null, 2));

await dispatchQueue.close();
await connection.quit();
await pool.end();
