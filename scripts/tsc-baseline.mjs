#!/usr/bin/env node
/**
 * Catraca do `tsc --noEmit`.
 *
 * O repo tem um passivo grande de erros de tipo (na maioria `select` do
 * Prisma sem a coluna usada depois), então um step de typecheck puro
 * nasceria vermelho e seria ignorado. A catraca resolve o impasse: o
 * passivo fica congelado num baseline versionado e o CI só reclama do que
 * é NOVO.
 *
 * A chave de cada erro é `arquivo|código|mensagem normalizada`, SEM linha
 * e coluna — mexer no arquivo desloca as linhas e faria o baseline inteiro
 * parecer novo a cada commit.
 *
 * Falha quando:
 *   - aparece erro fora do baseline (ou a mesma chave passa a ocorrer mais
 *     vezes);
 *   - um erro do baseline some (foi corrigido): o baseline precisa ser
 *     regravado, senão o passivo nunca diminui de verdade.
 *
 * Regravar:  UPDATE_TSC_BASELINE=1 node scripts/tsc-baseline.mjs
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BASELINE = resolve("tsc-baseline.json");
const LINE_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * Caminhos e espaços variam entre Windows e o runner; a chave, não.
 * Mensagens do TS trazem o caminho ABSOLUTO do módulo
 * (`import("/home/runner/work/.../node_modules/next-auth")`), que muda o
 * hash do mesmo erro entre a máquina de quem gerou e o CI.
 */
function normalize(msg) {
  return msg
    .replace(/(?:[A-Za-z]:)?[\\/][^"')\s]*?[\\/]node_modules[\\/]/g, "node_modules/")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function collect() {
  const run = spawnSync("npx", ["tsc", "--noEmit"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const counts = {};
  for (const line of out.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue; // linhas de continuação da mensagem não entram
    const [, file, , , code, message] = m;
    const key = `${file.replaceAll("\\", "/")}|${code}|${normalize(message)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const current = collect();
const total = Object.values(current).reduce((a, b) => a + b, 0);

if (process.env.UPDATE_TSC_BASELINE === "1") {
  const sorted = Object.fromEntries(
    Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  console.log(`baseline regravado: ${total} erros, ${Object.keys(sorted).length} chaves`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(
    "tsc-baseline.json não existe. Gere com UPDATE_TSC_BASELINE=1 node scripts/tsc-baseline.mjs",
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const baseTotal = Object.values(baseline).reduce((a, b) => a + b, 0);

const novos = [];
for (const [key, count] of Object.entries(current)) {
  const allowed = baseline[key] ?? 0;
  if (count > allowed) novos.push(`${key} (${count}x, baseline ${allowed}x)`);
}

const corrigidos = [];
for (const [key, count] of Object.entries(baseline)) {
  const now = current[key] ?? 0;
  if (now < count) corrigidos.push(`${key} (${now}x, baseline ${count}x)`);
}

const resumo = `tsc: ${total} erros agora, ${baseTotal} no baseline (${Object.keys(baseline).length} chaves)`;
console.log(resumo);

// No CI o log bruto do job exige autenticação para ler; anotação, não.
// Sem isto, uma catraca vermelha em branch de auditoria vira adivinhação.
if (process.env.GITHUB_ACTIONS === "true") {
  const cmd = (m) => console.log(`::error::${m.replaceAll("\n", " ")}`);
  cmd(resumo);
  for (const n of novos.slice(0, 40)) cmd(`NOVO ${n}`);
  for (const c of corrigidos.slice(0, 40)) cmd(`CORRIGIDO ${c}`);
}

if (novos.length) {
  console.error(`\n${novos.length} erro(s) de tipo NOVO(S) — fora do baseline:`);
  for (const n of novos) console.error(`  - ${n}`);
}
if (corrigidos.length) {
  console.error(
    `\n${corrigidos.length} erro(s) do baseline não acontece(m) mais. Regrave o baseline:`,
  );
  console.error("  UPDATE_TSC_BASELINE=1 node scripts/tsc-baseline.mjs");
  for (const c of corrigidos) console.error(`  - ${c}`);
}

process.exit(novos.length || corrigidos.length ? 1 : 0);
