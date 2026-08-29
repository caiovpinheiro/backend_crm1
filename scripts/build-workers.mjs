#!/usr/bin/env node
/**
 * Build dos workers BullMQ para JavaScript executável com `node`.
 *
 * Por que precisamos compilar?
 * ────────────────────────────
 * O Dockerfile (runner stage) copia APENAS `.next/standalone` do builder.
 * O standalone do Next.js minifica `node_modules` mantendo só o que o bundle
 * Next usa em runtime — `tsx` (que está em `dependencies` no package.json)
 * NÃO é referenciado pelo Next, então o standalone tracing não inclui ele.
 *
 * Logo, em produção/Docker, `tsx src/workers/<file>.ts` NÃO FUNCIONA. Esse
 * script empacota os workers em arquivos CJS standalone em `dist/workers/`
 * que são copiados para o runner e executados com `node`.
 *
 * Em dev local (`npm run start:worker:leads`) seguimos usando `tsx` direto
 * — mais rápido pra iterar, sem precisar de rebuild a cada edit.
 *
 * Decisões do bundle:
 *   - `format: cjs`: package.json não tem `"type": "module"`; CJS é o
 *     formato seguro/compatível com o resto do projeto.
 *   - `external: ["@prisma/client", ".prisma/client", "@prisma/adapter-pg"]`
 *     mantém o Prisma vindo de `node_modules/@prisma/*` (já copiado pelo
 *     Dockerfile linhas 38-39). Bundlar o Prisma Client quebra porque ele
 *     tem dependências nativas (engines) carregadas via `require.resolve`.
 *   - `external: ["pg"]` é CRÍTICO: o `@prisma/adapter-pg` faz `require("pg")`
 *     internamente. Se bundlarmos `pg` aqui, ficam DUAS cópias da lib no
 *     processo: a bundlada (usada pelo `new Pool()` em `prisma-base.ts`) e
 *     a de `node_modules` (usada pelo adapter). O `PrismaPg` recebe um
 *     `Pool` da instância "errada" e silenciosamente cai em defaults libpq
 *     (PGHOST=localhost), causando `Can't reach database server at 127.0.0.1`
 *     mesmo com `DATABASE_URL` correto. Marcando `pg` como external garante
 *     instância única.
 *   - `external: ["pino-pretty"]` evita carregar pino-pretty no bundle
 *     (logger.ts importa dinamicamente; em prod NODE_ENV=production não usa).
 *   - Plugin custom resolve o alias `@/...` que vem do `tsconfig.json`
 *     (`"@/*": ["./src/*"]`) sem dep extra (`tsconfig-paths` etc.).
 *   - `sourcemap: true`: stacktraces apontam para os .ts originais.
 *   - `bundle: true` + `platform: node`: agrega todas as deps transitivas
 *     em um único .js por entrypoint — fácil de copiar pro runner.
 */

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/**
 * Extensões testadas para resolver `@/foo` em ordem. Espelha o
 * `resolveExtensions` default do esbuild + também `index.*` para
 * imports apontando para diretórios.
 *
 * Por que precisamos disso?
 * Quando um plugin retorna `path` em `onResolve`, o esbuild trata o
 * caminho como FINAL — não aplica `resolveExtensions` automático.
 * Sem isso, `import "@/lib/logger"` virava
 * `/app/src/lib/logger` (sem `.ts`), o esbuild tentava ler como
 * arquivo literal e quebrava com "Cannot read file" em containers
 * onde o filesystem é case-sensitive (Linux).
 */
const ALIAS_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

function resolveAliasPath(rel) {
  const baseAbs = path.resolve(projectRoot, "src", rel);
  for (const ext of ALIAS_EXTENSIONS) {
    const candidate = `${baseAbs}${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  if (fs.existsSync(baseAbs) && fs.statSync(baseAbs).isDirectory()) {
    for (const ext of ALIAS_EXTENSIONS) {
      const candidate = path.join(baseAbs, `index${ext}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  if (fs.existsSync(baseAbs) && fs.statSync(baseAbs).isFile()) {
    return baseAbs;
  }
  return null;
}

/**
 * Plugin esbuild que resolve o alias `@/...` para `<projectRoot>/src/...`.
 * Espelha o `paths` do tsconfig sem precisar puxar dep extra.
 */
const aliasAtPlugin = {
  name: "alias-at",
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2); // remove "@/"
      const resolved = resolveAliasPath(rel);
      if (!resolved) {
        return {
          errors: [
            {
              text: `[alias-at] não consegui resolver "${args.path}" — testei extensões ${ALIAS_EXTENSIONS.join(", ")} em src/${rel}`,
            },
          ],
        };
      }
      return { path: resolved };
    });
  },
};

const entries = [
  // Inbox WhatsApp Meta (meta-attach + meta-outbound + sweepers).
  "src/workers/campaign-worker.ts",
  // Disparo de campanha CRM (dispatch + rodízio / campaign-send).
  "src/workers/campaigns-worker.ts",
  // Leads (Deals) — worker novo.
  "src/workers/leads-worker.ts",
  // ETL — importação de contatos via arquivo (CSV/XLSX).
  "src/workers/etl-worker.ts",
  // Automações / Salesbot — consome a fila `automation-jobs`.
  "src/workers/automation-worker.ts",
  // Webhooks Meta — consome `meta-webhook-events` (offload da API do inbox).
  "src/workers/meta-webhook-worker.ts",
];

await build({
  absWorkingDir: projectRoot,
  entryPoints: entries,
  outdir: path.resolve(projectRoot, "dist/workers"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  // Prisma + adapter precisam vir de `node_modules/@prisma/*` (engines nativas).
  // `pg` precisa ser external para compartilhar a MESMA instância com o
  // `@prisma/adapter-pg` (ver doc no topo do arquivo). pino-pretty é
  // dynamic-require pra dev only.
  external: [
    "@prisma/client",
    ".prisma/client",
    "@prisma/adapter-pg",
    "pg",
    "pino-pretty",
  ],
  // Carrega o tsconfig do projeto para herdar `target`, `strict`, etc.
  tsconfig: path.resolve(projectRoot, "tsconfig.json"),
  plugins: [aliasAtPlugin],
  // Aliases adicionais para nomes que esbuild não consegue resolver
  // sozinho em CJS (raro, mas existem casos com `next` que vazam imports).
  // Mantemos vazio por enquanto — adicionar conforme aparecerem warnings.
  // Marca como worker code para evitar tree-shaking agressivo de side effects
  // (ex.: registro de signal handlers no `if (require.main === module)`).
  treeShaking: false,
});

console.log("[build-workers] ✓ workers compilados em dist/workers/");
