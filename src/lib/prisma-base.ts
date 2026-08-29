import { readFileSync } from "node:fs";

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { warnPublicDoManagedHosts } from "@/lib/warn-public-do-managed-hosts";

/**
 * Cliente Prisma cru (sem extension de organizationId). Use quando:
 * - A query precisa atravessar orgs (ex.: painel /admin listando todas).
 * - O codigo roda antes do RequestContext existir (NextAuth.authorize,
 *   jwt callback, middleware de edge — que aliás não importa prisma).
 * - Scripts/seed precisam criar a primeira org "EduIT" sem ter contexto.
 *
 * Para qualquer codigo de request em API/page scoped, prefira o cliente
 * scoped exportado em @/lib/prisma (que e esta base + extension de
 * organization-scope).
 */

const globalForPrisma = globalThis as unknown as {
  prismaBase: PrismaClient | undefined;
};

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (!v) return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

function appMode(): string {
  return (process.env.APP_MODE ?? "api").trim().toLowerCase() || "api";
}

/**
 * Defaults por APP_MODE. A regra é `pool ≥ demanda real de conexões
 * simultâneas do processo`, e não `pool ≥ concurrency nominal`: um job
 * pode segurar mais de uma conexão quando dispara trabalho sem `await`.
 * Quando o pool fica abaixo da demanda, o excedente espera invisível na
 * fila interna do pg-pool e estoura em `DB_POOL_CONN_TIMEOUT_MS` com
 * "timeout exceeded when trying to connect" — que no worker vira retry do
 * job inteiro.
 *
 * - api: 20 (inbox/pipeline/board sob carga)
 * - worker-whatsapp: 16 (rodízio de campanha com CAMPAIGN_SEND_CONCURRENCY
 *   runners: o tempo do runner é dominado por espera de throttle/HTTP Meta,
 *   mas cada envio faz ~4-6 queries curtas; 16 conexões cobrem o duty cycle
 *   sem fila invisível no pg-pool. Antes: 6 — gargalo medido a 300 msg/s)
 * - worker-meta-webhook: 16 (concurrency 4 × ~4 conexões: o handler de
 *   status/inbound dispara IIFEs `void (async () => ...)` que rodam em
 *   paralelo ao job e não são contabilizadas pela concurrency)
 * - worker-leads: 10 (concurrency 5 + semáforo de efeitos colaterais do
 *   bulk-move-stage, limitado a 3 em voo por processo, + folga)
 * - worker-automation: 6 (concurrency 4 + folga p/ enqueue/log)
 * - worker-etl: 4 (concurrency 1, mas o import grava em várias tabelas
 *   por linha)
 *
 * Soma dos defaults com 1 réplica de cada: 20 + 16 + 16 + 10 + 6 + 4 = 72,
 * contra ~197 conexões disponíveis no Postgres gerenciado (4 vCPU/8 GB).
 * Sobram ~125 para réplicas, migrations e sessões de manutenção.
 */
function defaultPoolMax(): number {
  const mode = appMode();
  if (!mode.startsWith("worker")) return 20;
  if (mode === "worker-whatsapp") return 16;
  if (mode === "worker-meta-webhook") return 16;
  if (mode === "worker-leads") return 10;
  if (mode === "worker-automation") return 6;
  return 4;
}

/** Erro clássico do `pg-pool` quando `connectionTimeoutMillis` estoura. */
export function isPgPoolTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /timeout exceeded when trying to connect/i.test(err.message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry 1x em pool timeout. Seguro para read e write: o timeout ocorre
 * ANTES de checkout — a query ainda não começou.
 */
export async function withPgPoolRetry<T>(
  fn: () => Promise<T>,
  label?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isPgPoolTimeoutError(err)) throw err;
    const mode = appMode();
    console.warn(
      `[prisma-base] pool timeout APP_MODE=${mode}` +
        (label ? ` op=${label}` : "") +
        " — retry 1x",
    );
    await sleep(50 + Math.floor(Math.random() * 100));
    return await fn();
  }
}

function createPrismaClient() {
  warnPublicDoManagedHosts();
  // Pool config tunado para multi-tenant SaaS:
  //
  //   - DB_POOL_MAX (default por APP_MODE — ver defaultPoolMax): conexoes
  //     concorrentes ATIVAS por processo. Em prod EasyPanel tipico
  //     (1 API + 3 workers) cabe em max_connections=100 com folga.
  //   - DB_POOL_IDLE_TIMEOUT_MS (default 30s): idle conn devolve pro
  //     pool depois desse tempo. Reduz pressao em janelas de baixo
  //     trafego (off-hours).
  //   - DB_POOL_CONN_TIMEOUT_MS (default 8s): tempo max esperando uma
  //     conn livre no pool OU TCP ao Postgres. Se estourar → erro
  //     "timeout exceeded when trying to connect" (pg-pool).
  //   - DB_STATEMENT_TIMEOUT_MS (default 30s): mata queries individuais
  //     que demoram mais que isso. Evita N+1 acidentais em endpoints
  //     publicos drenarem o pool inteiro.
  //
  // Tunar via env. Defaults ja servem dev e prod pequena (1-2 replicas).
  const mode = appMode();
  const prismaLog =
    process.env.NODE_ENV === "development"
      ? ([{ emit: "stdout", level: "warn" }, { emit: "stdout", level: "error" }] as const)
      : (["error"] as const);

  // Engine `binary` (Windows ARM64 / PRISMA_CLIENT_ENGINE_TYPE=binary) não
  // aceita driver adapter. Sem este bypass o client quebra no constructor
  // ("Cannot use a driver adapter with the binary Query Engine").
  const engineType = (process.env.PRISMA_CLIENT_ENGINE_TYPE ?? "").toLowerCase();
  const winArm64 = process.platform === "win32" && process.arch === "arm64";
  if (engineType === "binary" || winArm64) {
    console.info(
      `[prisma-base] engine=${engineType || "library"} arch=${process.arch} sem adapter APP_MODE=${mode}`,
    );
    return new PrismaClient({ log: [...prismaLog] });
  }

  const max = envInt("DB_POOL_MAX", defaultPoolMax());
  const idleTimeoutMillis = envInt("DB_POOL_IDLE_TIMEOUT_MS", 30_000);
  const connectionTimeoutMillis = envInt("DB_POOL_CONN_TIMEOUT_MS", 8_000);
  const statementTimeoutMs = envInt("DB_STATEMENT_TIMEOUT_MS", 30_000);

  // application_name aparece em pg_stat_activity — facilita achar quem
  // segura conexao quando max_connections aperta.
  const appName = `crm_${mode}`.replace(/[^a-z0-9_]/gi, "_").slice(0, 63);

  // NÃO monkey-patchar pool.connect: pg.Pool.query usa a forma callback.
  // Substituir só a Promise (c2892a0) vazava conexões — SELECT 1 do /health
  // estourava 2s e login/inbox devolviam "Internal Server Error".
  //
  // TLS para Postgres gerenciado (DigitalOcean): a CA da DO não está no
  // truststore do Node, então `sslmode=require` na URL falha com
  // "self-signed certificate in certificate chain". O driver `pg` NÃO lê
  // `sslcert` da connection string — ele precisa do objeto `ssl` com a CA.
  // Lemos o arquivo do CA (montado via bind mount) e passamos ao pool.
  // PGSSLROOTCERT ou PG_CA_PATH apontam para o arquivo; se ausentes, cai no
  // comportamento padrão do pg (sslmode da URL).
  const caPath =
    process.env.PGSSLROOTCERT?.trim() || process.env.PG_CA_PATH?.trim();
  let ssl: { ca: string; rejectUnauthorized: boolean } | undefined;
  if (caPath) {
    try {
      ssl = { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
    } catch (err) {
      console.warn(
        `[prisma-base] não conseguiu ler o CA em ${caPath} — caindo no TLS padrão:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Quando passamos o objeto `ssl`, o `sslmode` da connection string CONFLITA
  // e vence (o pg trata `require` como `verify-full` e ignora o objeto ssl) —
  // provado em teste local: mesmo `rejectUnauthorized:false` falhava com
  // `sslmode=require` presente. Por isso removemos o `sslmode`/`sslcert` da URL
  // quando o objeto ssl está presente, deixando o objeto mandar no TLS.
  let connectionString = process.env.DATABASE_URL;
  if (ssl && connectionString) {
    connectionString = connectionString
      .replace(/([?&])sslmode=[^&]*/g, "$1")
      .replace(/([?&])sslcert=[^&]*/g, "$1")
      .replace(/[?&]$/, "")
      .replace(/\?&/, "?")
      .replace(/\?$/, "");
  }

  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    // Após restart do Postgres, conexões idle mortas saem do pool em vez
    // de ficarem "in use" até o statement_timeout.
    allowExitOnIdle: true,
    // Só statement_timeout. `application_name` via options (c2892a0) pode
    // travar o handshake no PgBouncer — /health SELECT 1 estourava 2s.
    options: `-c statement_timeout=${statementTimeoutMs}`,
    ...(ssl ? { ssl } : {}),
  });

  // Resiliencia: log mas nao crash em erros transientes do pool.
  pool.on("error", (err) => {
    console.warn(
      `[prisma-base] pool error APP_MODE=${mode} (continuando):`,
      err.message,
    );
  });

  console.info(
    `[prisma-base] pool ready APP_MODE=${mode} max=${max}` +
      ` connTimeoutMs=${connectionTimeoutMillis}` +
      ` idleTimeoutMs=${idleTimeoutMillis}` +
      ` statementTimeoutMs=${statementTimeoutMs}` +
      ` application_name=${appName}`,
  );

  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    log: [...prismaLog],
  });
}

export const prismaBase =
  globalForPrisma.prismaBase ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaBase = prismaBase;
