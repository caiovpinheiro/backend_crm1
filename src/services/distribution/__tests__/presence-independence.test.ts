/**
 * Garantia: a Distribuição decide "online" SÓ por `agent_statuses.status`
 * (controle manual do agente). A batida de presença (`/api/presence/beat`),
 * o ping, o heartbeat de viewers e `system_usage_sessions` não podem entrar
 * na elegibilidade — mudar a cadência ou o limite da batida não pode mudar
 * para quem vai lead.
 *
 * Varredura estática de `src/services/distribution/**`: nenhum arquivo
 * importa os módulos de presença; a única leitura de presença de uso
 * (`getSystemPresenceMap`) fica em `responsibles.ts`, só para exibição
 * (`systemOnline`/`lastSeenAt` na tela de Distribuição), fora dos dados que
 * vão para `evaluateResponsibleEligibility`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(ROOT).map((f) => ({
  path: relative(ROOT, f).replace(/\\/g, "/"),
  src: readFileSync(f, "utf8"),
}));

const PRESENCE_MODULES = [
  "@/lib/presence-beat",
  "@/lib/presence-beat-config",
  "@/lib/presence-ping-limit",
  "@/lib/entity-presence",
  "@/lib/presence-user-info",
];

describe("Distribuição independente da presença de uso", () => {
  it("varre os arquivos da distribuição", () => {
    expect(FILES.length).toBeGreaterThan(10);
    expect(FILES.some((f) => f.path === "responsibles.ts")).toBe(true);
    expect(FILES.some((f) => f.path === "eligibility.ts")).toBe(true);
  });

  it("nenhum arquivo importa batida/ping/viewers nem lê system_usage_sessions", () => {
    for (const f of FILES) {
      for (const mod of PRESENCE_MODULES) {
        expect(f.src.includes(`"${mod}"`), `${f.path} importa ${mod}`).toBe(false);
      }
      expect(/systemUsageSession|system_usage_sessions|lastHeartbeatAt/.test(f.src), f.path).toBe(
        false,
      );
    }
  });

  it("presença de uso só em responsibles.ts, e fora da elegibilidade", () => {
    const users = FILES.filter((f) => f.src.includes("@/services/system-presence"));
    expect(users.map((f) => f.path)).toEqual(["responsibles.ts"]);

    for (const f of FILES) {
      if (f.path === "responsibles.ts") continue;
      expect(/systemOnline|getSystemPresenceMap/.test(f.src), f.path).toBe(false);
    }

    const src = users[0]!.src;
    const start = src.indexOf("evaluateResponsibleEligibility(");
    expect(start).toBeGreaterThan(0);
    // Argumentos da chamada (até o `eligibilityCtx`): sem presença de uso.
    const call = src.slice(start, src.indexOf("eligibilityCtx", start));
    expect(call).not.toMatch(/systemOnline|systemPresence|lastSeenAt/);
    expect(call).toMatch(/status/);
  });
});
