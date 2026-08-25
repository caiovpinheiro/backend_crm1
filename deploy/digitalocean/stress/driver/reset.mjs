/**
 * Zera o estado entre fases: esvazia as filas e apaga o que as campanhas
 * de stress criaram, sem tocar nos dados pré-existentes das orgs.
 *
 *   node reset.mjs [--filas] [--dados]   (sem flags = ambos)
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const args = new Set(process.argv.slice(2).map((a) => a.replace(/^--/, "")));
const fazerFilas = args.size === 0 || args.has("filas");
const fazerDados = args.size === 0 || args.has("dados");

const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 3 });

if (fazerFilas) {
  for (const nome of ["campaign-dispatch", "campaign-send", "meta-webhook-events", "automation-jobs"]) {
    const q = new Queue(nome, { connection: connection.duplicate() });
    const antes = await q.getJobCounts("waiting", "active", "delayed", "failed");
    await q.obliterate({ force: true });
    console.log(`[reset] fila ${nome}: ${JSON.stringify(antes)} -> vazia`);
    await q.close();
  }
  // Throttle por phoneNumberId sobrevive à fila; sem limpar, a próxima fase
  // herda o "próximo slot" da anterior e começa artificialmente devagar.
  const chaves = await connection.keys("campaign:meta:throttle:*");
  if (chaves.length) {
    await connection.del(...chaves);
    console.log(`[reset] ${chaves.length} chaves de throttle removidas`);
  }
}

if (fazerDados) {
  const alvo = `(SELECT id FROM campaigns WHERE name LIKE '__STRESS__%')`;
  const q = async (sql) => (await pool.query(sql)).rowCount;
  console.log(`[reset] messages: ${await q(
    `DELETE FROM messages WHERE "externalId" LIKE 'wamid.MOCK%'`)}`);
  console.log(`[reset] recipients: ${await q(
    `DELETE FROM campaign_recipients WHERE "campaignId" IN ${alvo}`)}`);
  console.log(`[reset] campanhas: ${await q(
    `DELETE FROM campaigns WHERE name LIKE '__STRESS__%'`)}`);
}

await connection.quit();
await pool.end();
