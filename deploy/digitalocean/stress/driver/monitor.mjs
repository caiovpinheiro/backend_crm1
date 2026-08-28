/**
 * Amostrador do stress test. Roda em paralelo à carga e imprime uma linha
 * por intervalo com fila, banco, progresso e o que o mock da Graph viu.
 *
 *   node monitor.mjs --seg=300 --int=5
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DURACAO_SEG = Number(args.seg || 300);
const INTERVALO_SEG = Number(args.int || 5);

const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 3 });

const filas = [
  "campaign-dispatch",
  "campaign-send",
  "meta-webhook-events",
  "automation-jobs",
].map((n) => new Queue(n, { connection: connection.duplicate() }));

async function contarFila(q) {
  const c = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed");
  return { nome: q.name, ...c };
}

async function mockStats() {
  try {
    const r = await fetch("https://graph.facebook.com/__stats", { cache: "no-store" });
    return await r.json();
  } catch { return null; }
}

let anterior = null;
const linhas = [];

console.log(
  [
    "t".padStart(4),
    "send_wait".padStart(10),
    "send_act".padStart(9),
    "send_fail".padStart(10),
    "enviados".padStart(9),
    "delta/s".padStart(8),
    "wh_wait".padStart(8),
    "auto_wait".padStart(10),
    "pg_act".padStart(7),
    "pg_max_s".padStart(9),
    "graph_req".padStart(10),
    "graph_429".padStart(10),
  ].join(" "),
);

const t0 = Date.now();
for (let i = 0; i * INTERVALO_SEG < DURACAO_SEG; i++) {
  const [counts, prog, pgact, mock] = await Promise.all([
    Promise.all(filas.map(contarFila)),
    pool.query(`
      SELECT count(*) FILTER (WHERE cr.status='SENT')::int enviados,
             count(*) FILTER (WHERE cr.status='FAILED')::int falhos,
             count(*) FILTER (WHERE cr.status='PENDING')::int pendentes
        FROM campaign_recipients cr
        JOIN campaigns c ON c.id = cr."campaignId"
       WHERE c.name LIKE '__STRESS__%'`),
    pool.query(`
      SELECT count(*) FILTER (WHERE state='active')::int ativas,
             count(*)::int total,
             COALESCE(max(EXTRACT(EPOCH FROM (now()-query_start)))
               FILTER (WHERE state='active' AND query NOT ILIKE '%pg_stat%'),0)::numeric(10,1) max_s
        FROM pg_stat_activity WHERE datname='db_crm'`),
    mockStats(),
  ]);

  const byName = Object.fromEntries(counts.map((c) => [c.nome, c]));
  const enviados = prog.rows[0].enviados;
  const seg = (Date.now() - t0) / 1000;
  const delta = anterior ? ((enviados - anterior.enviados) / (seg - anterior.seg)).toFixed(1) : "-";
  anterior = { enviados, seg };

  const g429 = mock?.porStatus?.["429"] ?? 0;
  const linha = [
    String(Math.round(seg)).padStart(4),
    String(byName["campaign-send"].waiting).padStart(10),
    String(byName["campaign-send"].active).padStart(9),
    String(byName["campaign-send"].failed).padStart(10),
    String(enviados).padStart(9),
    String(delta).padStart(8),
    String(byName["meta-webhook-events"].waiting).padStart(8),
    String(byName["automation-jobs"].waiting).padStart(10),
    String(pgact.rows[0].ativas).padStart(7),
    String(pgact.rows[0].max_s).padStart(9),
    String(mock?.total ?? "-").padStart(10),
    String(g429).padStart(10),
  ].join(" ");
  console.log(linha);
  linhas.push({
    seg: Math.round(seg),
    sendWaiting: byName["campaign-send"].waiting,
    sendActive: byName["campaign-send"].active,
    sendFailed: byName["campaign-send"].failed,
    webhookWaiting: byName["meta-webhook-events"].waiting,
    automationWaiting: byName["automation-jobs"].waiting,
    enviados,
    taxa: delta === "-" ? null : Number(delta),
    pgAtivas: pgact.rows[0].ativas,
    pgMaxQuerySeg: Number(pgact.rows[0].max_s),
    graphTotal: mock?.total ?? null,
    graph429: g429,
  });

  await new Promise((r) => setTimeout(r, INTERVALO_SEG * 1000));
}

const taxas = linhas.map((l) => l.taxa).filter((v) => typeof v === "number" && v > 0);
const mock = await mockStats();
console.log("\n===== RESUMO =====");
console.log(JSON.stringify({
  duracaoSeg: DURACAO_SEG,
  taxaEnvio: taxas.length
    ? {
        media: +(taxas.reduce((a, b) => a + b, 0) / taxas.length).toFixed(1),
        max: Math.max(...taxas),
        min: Math.min(...taxas),
      }
    : null,
  picoFilaSend: Math.max(...linhas.map((l) => l.sendWaiting)),
  picoFilaWebhook: Math.max(...linhas.map((l) => l.webhookWaiting)),
  picoFilaAutomacao: Math.max(...linhas.map((l) => l.automationWaiting)),
  falhasSend: linhas.at(-1)?.sendFailed ?? null,
  picoConexoesPg: Math.max(...linhas.map((l) => l.pgAtivas)),
  picoQueryPgSeg: Math.max(...linhas.map((l) => l.pgMaxQuerySeg)),
  enviadosTotal: linhas.at(-1)?.enviados ?? 0,
  mock,
}, null, 2));

await Promise.all(filas.map((q) => q.close()));
await connection.quit();
await pool.end();
