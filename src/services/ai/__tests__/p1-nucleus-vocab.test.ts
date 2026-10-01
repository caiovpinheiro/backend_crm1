/**
 * Catraca de vocabulário de tenant/produto no núcleo.
 *
 * Antes isto era uma lista de arquivos isentos: `tools.ts`, `steering.ts` e
 * `inbox-handler.ts` ficavam fora da varredura inteira, então qualquer
 * termo novo entrava sem ninguém ver. Agora nenhum arquivo é isento — o
 * que existe é um baseline versionado com as ocorrências de hoje.
 *
 * O teste falha quando:
 *   - aparece ocorrência que não está no baseline (regressão), ou
 *   - o baseline cita ocorrência que não existe mais (limpe o baseline).
 *
 * Para regravar depois de remover ocorrências:
 *   UPDATE_VOCAB_BASELINE=1 npx vitest run src/services/ai/__tests__/p1-nucleus-vocab.test.ts
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const BASELINE_PATH = join(__dirname, "nucleus-vocab-baseline.json");
const SCAN = ["services/ai", "lib/ai-agents", "app/api/ai-agents"].map((p) =>
  join(ROOT, p),
);
const FORBIDDEN =
  /Cruzeiro|UNICID|aluno|matr[ií]cul|acolh|reten[cç]|Joseph/i;

type BaselineFile = {
  /** Ocorrências por arquivo: trecho normalizado → quantas vezes aparece. */
  occurrences: Record<string, Record<string, number>>;
};

function skip(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  if (n.includes("/verticals/")) return true;
  if (n.includes("/scripts/")) return true;
  if (n.includes("/__tests__/")) return true;
  if (/\.test\.tsx?$/.test(n) || /\.spec\.tsx?$/.test(n)) return true;
  return false;
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "verticals" || name === "scripts") {
        continue;
      }
      walk(full, acc);
    } else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Trecho sem número de linha: mover código não conta como ocorrência nova. */
function snippet(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 160);
}

function collect(): BaselineFile["occurrences"] {
  const found: BaselineFile["occurrences"] = {};
  for (const dir of SCAN) {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (skip(rel)) continue;
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        if (!FORBIDDEN.test(line)) continue;
        const key = snippet(line);
        found[rel] ??= {};
        found[rel][key] = (found[rel][key] ?? 0) + 1;
      }
    }
  }
  return found;
}

function loadBaseline(): BaselineFile["occurrences"] {
  try {
    return (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile)
      .occurrences;
  } catch {
    return {};
  }
}

describe("núcleo sem vocabulário de tenant/produto", () => {
  const current = collect();
  const baseline = loadBaseline();

  if (process.env.UPDATE_VOCAB_BASELINE === "1") {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ occurrences: current }, null, 2)}\n`,
      "utf8",
    );
  }

  it("nenhuma ocorrência nova fora do baseline", () => {
    const novas: string[] = [];
    for (const [file, lines] of Object.entries(current)) {
      for (const [line, count] of Object.entries(lines)) {
        const allowed = baseline[file]?.[line] ?? 0;
        if (count > allowed) {
          novas.push(`${file} (${count - allowed}x nova): ${line}`);
        }
      }
    }
    expect(novas, novas.join("\n")).toEqual([]);
  });

  it("baseline não cita ocorrência que já foi removida", () => {
    const obsoletas: string[] = [];
    for (const [file, lines] of Object.entries(baseline)) {
      for (const [line, count] of Object.entries(lines)) {
        const still = current[file]?.[line] ?? 0;
        if (still < count) {
          obsoletas.push(`${file} (${count - still}x a menos): ${line}`);
        }
      }
    }
    expect(obsoletas, obsoletas.join("\n")).toEqual([]);
  });
});
