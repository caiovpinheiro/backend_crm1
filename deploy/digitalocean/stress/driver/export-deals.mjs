/**
 * Simulador de EXPORTAÇÃO de negócios sob carga — chama a rota REAL
 * GET /api/deals/export (síncrona, streaming em lotes de 400) usando
 * tokens de API (Bearer) criados direto no banco, espelhando
 * services/api-tokens.ts generateToken (sha256 do raw, prefixo eduit_).
 *
 * Roda N rodadas disparando as 6 orgs EM PARALELO e mede por org:
 * HTTP status, TTFB, tempo total, bytes e linhas do CSV.
 *
 *   node export-deals.mjs [--rounds=3] [--interval=60] [--api=http://api:3000]
 *
 * Os tokens criados são removidos ao final (nome __STRESS_EXPORT__).
 */
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const ROUNDS = Number(args.rounds || 3);
const INTERVAL_S = Number(args.interval || 60);
const API = args.api || "http://api:3000";
const RUN = `str${Date.now().toString(36)}`;

const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 4 });

const orgs = (await pool.query(`
  SELECT o.id, o.name,
         (SELECT u.id FROM users u WHERE u."organizationId" = o.id AND u.role = 'ADMIN' LIMIT 1) AS admin_id
    FROM organizations o
   WHERE o.status = 'ACTIVE'
   ORDER BY o.name`)).rows;

const tokens = [];
for (const org of orgs) {
  if (!org.admin_id) continue;
  const raw = "eduit_" + randomBytes(24).toString("hex");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const id = `cok${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
  await pool.query(
    `INSERT INTO api_tokens
       (id, "organizationId", name, "tokenHash", "tokenPrefix", "userId", "createdAt")
     VALUES ($1,$2,$3,$4,$5,$6, now())`,
    [id, org.id, `__STRESS_EXPORT__ ${RUN}`, tokenHash, raw.slice(0, 12), org.admin_id],
  );
  tokens.push({ org: org.name, orgId: org.id, id, raw });
}
console.log(`[export-deals] run=${RUN} tokens criados=${tokens.length} api=${API} rodadas=${ROUNDS}`);

async function exportOne(t, round) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 280_000);
  const t0 = performance.now();
  let ttfb = null;
  let bytes = 0;
  let newlines = 0;
  try {
    const res = await fetch(`${API}/api/deals/export`, {
      headers: { authorization: `Bearer ${t.raw}` },
      signal: ctrl.signal,
    });
    ttfb = performance.now() - t0;
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      return { org: t.org, round, ok: false, http: res.status, err: body.slice(0, 200) };
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      for (let i = 0; i < value.length; i++) if (value[i] === 0x0a) newlines++;
    }
    const total = performance.now() - t0;
    return { org: t.org, round, ok: true, http: 200, ttfbMs: Math.round(ttfb), totalMs: Math.round(total), bytes, rows: Math.max(0, newlines - 1) };
  } catch (e) {
    return { org: t.org, round, ok: false, err: String(e?.message ?? e).slice(0, 200), elapsedMs: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(killer);
  }
}

const allResults = [];
for (let r = 1; r <= ROUNDS; r++) {
  const t0 = Date.now();
  console.log(`[export-deals] rodada ${r}/${ROUNDS} — disparando ${tokens.length} exports em paralelo...`);
  const results = await Promise.all(tokens.map((t) => exportOne(t, r)));
  for (const res of results) {
    allResults.push(res);
    if (res.ok) {
      console.log(`  ${res.org}: 200 em ${(res.totalMs / 1000).toFixed(1)}s (ttfb ${(res.ttfbMs / 1000).toFixed(1)}s) — ${res.rows} linhas, ${(res.bytes / 1024 / 1024).toFixed(1)} MiB`);
    } else {
      console.log(`  ${res.org}: FALHOU http=${res.http ?? "-"} ${res.err ?? ""}`);
    }
  }
  if (r < ROUNDS) {
    const wait = Math.max(0, INTERVAL_S * 1000 - (Date.now() - t0));
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }
}

console.log("\n[export-deals] resumo JSON:");
console.log(JSON.stringify(allResults));

// Cleanup: remove os tokens criados nesta execução.
const ids = tokens.map((t) => t.id);
await pool.query(`DELETE FROM api_tokens WHERE id = ANY($1)`, [ids]);
console.log(`[export-deals] ${ids.length} tokens removidos.`);

await pool.end();
