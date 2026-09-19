import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN = ["services/ai", "lib/ai-agents", "app/api/ai-agents"].map((p) =>
  join(ROOT, p),
);
const FORBIDDEN =
  /Cruzeiro|UNICID|aluno|matr[ií]cul|acolh|reten[cç]|Joseph/i;

/** Camada acadêmica ainda no núcleo; migração para pack fica em follow-up. */
const SKIP_REL =
  /academic-record-policy\.ts$|sensitive-fields\.ts$|tools\.ts$|steering\.ts$|message-models-retrieval\.ts$|tabulation-classify-policy\.ts$|inbox-handler\.ts$|cockpit-academic\.ts$|department-handoff\.ts$/;

function skip(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  if (SKIP_REL.test(n)) return true;
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

describe("P1-A núcleo sem vocabulário de tenant/produto", () => {
  it("não contém Cruzeiro|UNICID|aluno|matrícula|acolh|retenção|Joseph", () => {
    const hits: string[] = [];
    for (const dir of SCAN) {
      for (const file of walk(dir)) {
        const rel = relative(ROOT, file);
        if (skip(rel)) continue;
        const text = readFileSync(file, "utf8");
        const lines = text.split(/\r?\n/);
        lines.forEach((line, i) => {
          if (FORBIDDEN.test(line)) {
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
          }
        });
      }
    }
    expect(hits, hits.slice(0, 40).join("\n")).toEqual([]);
  });
});
