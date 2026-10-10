/**
 * Config de conexão `pg` (Client/Pool) para os scripts `.mjs` que falam direto
 * com o Postgres (backfills que rodam no container da API, entre outros).
 *
 * Por quê: o `DATABASE_URL` do Postgres gerenciado da DigitalOcean vem com
 * `sslmode=require`, que o `pg` atual trata como `verify-full`; o CA da DO não
 * está na cadeia confiável do container, e a conexão cai com
 * `SELF_SIGNED_CERT_IN_CHAIN`. Além disso, qualquer `ssl*` na connection
 * string VENCE o objeto `ssl` passado ao Client (o `pg` faz
 * `Object.assign(config, parse(connectionString))`), então não basta passar
 * `ssl: { rejectUnauthorized: false }` — é preciso tirar os parâmetros da URL.
 *
 * Regras (mesmo padrão de `scripts/fix-keep-html-entities.mjs`):
 *   - tira `sslmode`, `ssl`, `sslrootcert`, `sslcert`, `sslkey`, `sslaccept` e
 *     `uselibpqcompat` da URL;
 *   - `sslmode=disable` (ou `ssl=0`/`ssl=false`)      → `ssl: false`;
 *   - qualquer outro sslmode (ou `ssl=true`/`ssl=1`)    → TLS com
 *     `rejectUnauthorized: false` (semântica do `require` da libpq);
 *   - sem sslmode na URL: usa `PGSSLMODE` do ambiente, se houver; senão, host
 *     local (localhost/127.0.0.1/::1/socket) → `ssl: false`; host remoto → não
 *     define `ssl` (padrão do `pg`);
 *   - `PG_SSL_VERIFY=1` (ou `sslmode=verify-ca|verify-full`) liga a verificação
 *     do certificado, com o CA de `PGSSLROOTCERT` (ou do `sslrootcert` da URL)
 *     quando o arquivo existe; sem CA, usa a cadeia confiável do Node.
 *
 * Uso:
 *   import { pgConnectionConfig } from "./lib/pg-ssl.mjs";
 *   const c = new Client({ ...pgConnectionConfig(), application_name: "..." });
 */
import { existsSync, readFileSync } from "node:fs";

const STRIP_PARAMS = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "sslaccept", "uselibpqcompat"];
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);
const TRUTHY = new Set(["1", "true", "yes", "on"]);

function readIfExists(path) {
  if (!path) return undefined;
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * @param {string | undefined} [databaseUrl] connection string (padrão: `env.DATABASE_URL`)
 * @param {Record<string, string | undefined>} [env] ambiente (padrão: `process.env`)
 * @returns {{ connectionString?: string, ssl?: false | { rejectUnauthorized: boolean, ca?: string, cert?: string, key?: string } }}
 */
export function pgConnectionConfig(databaseUrl, env = process.env) {
  const raw = (databaseUrl ?? env.DATABASE_URL ?? "").trim();
  // Sem URL: deixa o `pg` cair nos PG* do ambiente, como antes.
  if (!raw) return {};

  const url = new URL(raw);
  const params = url.searchParams;
  const sslParam = params.get("ssl")?.toLowerCase();
  let sslmode = params.get("sslmode")?.toLowerCase();
  if (!sslmode && sslParam) sslmode = TRUTHY.has(sslParam) ? "require" : "disable";
  if (!sslmode) sslmode = env.PGSSLMODE?.trim().toLowerCase() || undefined;
  const rootCertParam = params.get("sslrootcert") ?? undefined;
  const certParam = params.get("sslcert") ?? undefined;
  const keyParam = params.get("sslkey") ?? undefined;
  for (const p of STRIP_PARAMS) params.delete(p);
  const connectionString = url.toString();

  if (sslmode === "disable") return { connectionString, ssl: false };
  if (!sslmode) {
    return LOCAL_HOSTS.has(url.hostname) ? { connectionString, ssl: false } : { connectionString };
  }

  const verify =
    TRUTHY.has((env.PG_SSL_VERIFY ?? "").trim().toLowerCase()) ||
    sslmode === "verify-ca" ||
    sslmode === "verify-full";
  /** @type {{ rejectUnauthorized: boolean, ca?: string, cert?: string, key?: string }} */
  const ssl = { rejectUnauthorized: verify };
  if (verify) {
    const ca = readIfExists(env.PGSSLROOTCERT?.trim() || rootCertParam);
    if (ca) ssl.ca = ca;
  }
  const cert = readIfExists(certParam);
  const key = readIfExists(keyParam);
  if (cert) ssl.cert = cert;
  if (key) ssl.key = key;
  return { connectionString, ssl };
}
