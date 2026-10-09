/**
 * Onde rodam os sweepers e a execução de automação (B5 / N-INF-15).
 *
 * Antes: sem `AUTOMATION_WORKER_MODE=external`, a API subia TODOS os
 * sweepers (timeout de automação, presença, agendadas, sessão WhatsApp,
 * projetores da outbox...) e executava automação inline — em produção isso
 * duplicava o trabalho do `worker-whatsapp` e do `worker-automation`.
 *
 * Agora o padrão de produção (`NODE_ENV=production`) é seguro: a API não sobe
 * sweeper nem executa automação inline, a menos que configurado. Em dev local
 * (`next dev`, sem workers) o comportamento antigo continua.
 *
 * Variáveis:
 * - `API_RUN_SWEEPERS` — `1/true/yes/on` sobe os sweepers na API; `0/false/
 *   no/off` nunca sobe. Ausente: legado `AUTOMATION_WORKER_MODE=external`
 *   desliga; senão desligado em produção e ligado fora dela.
 * - `AUTOMATION_WORKER_MODE` — `external` enfileira em `automation-jobs`;
 *   `inline` executa no processo. Ausente/vazio: `external` na API
 *   (`api`/`api-public`) em produção; `inline` nos workers e em dev (como
 *   antes). Qualquer outro valor → `inline` (como antes).
 */

type Env = Record<string, string | undefined>;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function norm(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
}

export function resolveAppMode(env: Env = process.env): string {
  return norm(env.APP_MODE) || "api";
}

function isProduction(env: Env): boolean {
  return norm(env.NODE_ENV) === "production";
}

function isApiMode(appMode: string): boolean {
  return appMode === "api" || appMode === "api-public";
}

export type ApiSweepersReason =
  | "not_api"
  | "build"
  | "skip_flag"
  | "explicit_on"
  | "explicit_off"
  | "automation_external"
  | "production_default"
  | "dev_default";

export type ApiSweepersDecision = { enabled: boolean; reason: ApiSweepersReason };

/** A API (`APP_MODE=api`) deve subir os sweepers neste processo? */
export function resolveApiSweepers(env: Env = process.env): ApiSweepersDecision {
  if (env.NEXT_PHASE === "phase-production-build") return { enabled: false, reason: "build" };
  if (env.CRM_SKIP_BACKGROUND_SERVERS === "1") return { enabled: false, reason: "skip_flag" };
  if (resolveAppMode(env) !== "api") return { enabled: false, reason: "not_api" };

  const explicit = norm(env.API_RUN_SWEEPERS);
  if (TRUE_VALUES.has(explicit)) return { enabled: true, reason: "explicit_on" };
  if (FALSE_VALUES.has(explicit)) return { enabled: false, reason: "explicit_off" };

  if (norm(env.AUTOMATION_WORKER_MODE) === "external") {
    return { enabled: false, reason: "automation_external" };
  }
  if (isProduction(env)) return { enabled: false, reason: "production_default" };
  return { enabled: true, reason: "dev_default" };
}

export type AutomationExecution = {
  mode: "external" | "inline";
  /** `true` quando veio do default (variável ausente/vazia). */
  defaulted: boolean;
};

/** Automação neste processo: enfileira (`external`) ou executa (`inline`)? */
export function resolveAutomationExecution(env: Env = process.env): AutomationExecution {
  const raw = norm(env.AUTOMATION_WORKER_MODE);
  if (raw === "external") return { mode: "external", defaulted: false };
  if (raw !== "") return { mode: "inline", defaulted: false };
  if (isProduction(env) && isApiMode(resolveAppMode(env))) {
    return { mode: "external", defaulted: true };
  }
  return { mode: "inline", defaulted: true };
}
