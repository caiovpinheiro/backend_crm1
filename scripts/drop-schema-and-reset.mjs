// Limpa completamente o schema 'public' do banco staging e zera _prisma_migrations.
// Uso restrito: só rodar contra banco de TESTE, nunca contra prod.
//
// Confirmação obrigatória via env var:
//   $env:CONFIRM_DROP = "yes"
//   node scripts/drop-schema-and-reset.mjs
//
// Travas (antes de qualquer conexão):
//   - NODE_ENV=production → recusa sempre.
//   - Host do DATABASE_URL fora desta máquina (localhost / 127.x / ::1) →
//     recusa, a menos que DROP_SCHEMA_ALLOW_HOST traga EXATAMENTE esse host
//     (banco de teste remoto; digitar o host é a confirmação).
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL ausente");
  process.exit(2);
}
if (process.env.NODE_ENV === "production") {
  console.error("Recusado: NODE_ENV=production. Este script só roda contra banco de teste.");
  process.exit(4);
}
let dbHost = "";
try {
  dbHost = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
} catch {
  console.error("Recusado: DATABASE_URL ilegível — não dá para confirmar que o host é local.");
  process.exit(4);
}
const isLocalHost =
  dbHost === "localhost" ||
  dbHost.endsWith(".localhost") ||
  dbHost === "::1" ||
  /^127(\.\d{1,3}){3}$/.test(dbHost);
const allowedHost = (process.env.DROP_SCHEMA_ALLOW_HOST ?? "").trim().toLowerCase();
if (!isLocalHost && (!dbHost || allowedHost !== dbHost)) {
  console.error(`Recusado: o host do banco (${dbHost || "?"}) não é local.`);
  console.error("Para um banco de TESTE remoto, defina DROP_SCHEMA_ALLOW_HOST com esse host exato.");
  process.exit(4);
}
if (process.env.CONFIRM_DROP !== "yes") {
  console.error("Confirmação ausente. Defina CONFIRM_DROP=yes pra prosseguir.");
  console.error("CUIDADO: isso APAGA TODO o schema public.");
  process.exit(3);
}

const safe = url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
console.log(`>> Conectando em ${safe}`);
const c = new Client({ connectionString: url });
await c.connect();

console.log(">> Drop schema public CASCADE...");
await c.query(`DROP SCHEMA IF EXISTS public CASCADE`);
console.log(">> Recriando schema public...");
await c.query(`CREATE SCHEMA public`);
await c.query(`GRANT ALL ON SCHEMA public TO PUBLIC`);

const r = await c.query(
  `SELECT COUNT(*)::int AS n FROM information_schema.tables
   WHERE table_schema='public'`
);
console.log(`>> Tabelas restantes em public: ${r.rows[0].n} (esperado: 0)`);

await c.end();
console.log(">> Pronto. Schema vazio.");
