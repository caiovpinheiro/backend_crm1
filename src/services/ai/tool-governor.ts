/**
 * Governador de chamadas de ferramenta dentro de um run.
 *
 * Sintoma que originou isto: nove chamadas idênticas no mesmo run e 42
 * chamadas em cinco minutos, até estourar o limite de passos. O modelo
 * reexecutava a mesma tool porque o resultado anterior não dizia "já
 * tentou" — só repetia o mesmo erro.
 *
 * Três travas, todas determinísticas:
 *  1. Repetição idêntica (nome + argumentos normalizados) devolve o
 *     resultado anterior com aviso, sem reexecutar.
 *  2. Teto de chamadas da MESMA ferramenta por run.
 *  3. Teto global de chamadas por run.
 *
 * Estourar 2 ou 3 marca `limitHit`, e o runner grava o run com outcome
 * próprio — nunca como sucesso.
 */

export type ToolCallLimits = {
  maxToolCallsPerRun: number;
  maxRepeatsPerTool: number;
};

export const DEFAULT_TOOL_CALL_LIMITS: ToolCallLimits = {
  maxToolCallsPerRun: 24,
  maxRepeatsPerTool: 3,
};

export function normalizeToolCallLimits(
  raw?: Partial<ToolCallLimits> | null,
): ToolCallLimits {
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    maxToolCallsPerRun: num(
      raw?.maxToolCallsPerRun,
      DEFAULT_TOOL_CALL_LIMITS.maxToolCallsPerRun,
    ),
    maxRepeatsPerTool: num(
      raw?.maxRepeatsPerTool,
      DEFAULT_TOOL_CALL_LIMITS.maxRepeatsPerTool,
    ),
  };
}

/**
 * Chave de deduplicação: nome + argumentos normalizados. Chaves ordenadas
 * (a ordem que o modelo emite varia), strings com espaços colapsados e sem
 * caixa — "Atendimento" e "atendimento " são a mesma tentativa.
 */
export function toolCallKey(toolName: string, args: unknown): string {
  return `${toolName}:${stableNormalize(args)}`;
}

function stableNormalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return JSON.stringify(value.trim().replace(/\s+/g, " ").toLowerCase());
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableNormalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableNormalize(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export type GovernorDecision =
  | { action: "run" }
  | { action: "replay"; previousResult: unknown }
  | { action: "deny"; reason: "tool_cap" | "run_cap" };

export class ToolCallGovernor {
  private readonly limits: ToolCallLimits;
  private readonly results = new Map<string, unknown>();
  private readonly perTool = new Map<string, number>();
  private total = 0;

  /// Repetições idênticas devolvidas do cache.
  replays = 0;
  /// Chamadas recusadas por teto.
  denials = 0;
  /// Algum teto foi estourado neste run.
  limitHit = false;

  constructor(limits: ToolCallLimits) {
    this.limits = limits;
  }

  decide(toolName: string, args: unknown): GovernorDecision {
    const key = toolCallKey(toolName, args);
    if (this.results.has(key)) {
      this.replays++;
      return { action: "replay", previousResult: this.results.get(key) };
    }
    if (this.total >= this.limits.maxToolCallsPerRun) {
      this.denials++;
      this.limitHit = true;
      return { action: "deny", reason: "run_cap" };
    }
    if ((this.perTool.get(toolName) ?? 0) >= this.limits.maxRepeatsPerTool) {
      this.denials++;
      this.limitHit = true;
      return { action: "deny", reason: "tool_cap" };
    }
    return { action: "run" };
  }

  record(toolName: string, args: unknown, result: unknown): void {
    this.results.set(toolCallKey(toolName, args), result);
    this.perTool.set(toolName, (this.perTool.get(toolName) ?? 0) + 1);
    this.total++;
  }

  stats() {
    return {
      totalCalls: this.total,
      replays: this.replays,
      denials: this.denials,
      limitHit: this.limitHit,
    };
  }
}

/**
 * Payload devolvido ao modelo numa repetição idêntica. Carrega o resultado
 * anterior E o aviso — sem o aviso o modelo tentava de novo achando que a
 * chamada não tinha saído.
 */
export function replayPayload(toolName: string, previousResult: unknown) {
  return {
    alreadyAttempted: true,
    warning: `Você já chamou \`${toolName}\` com estes mesmos argumentos neste atendimento. O resultado abaixo é o da tentativa anterior — NÃO repita a chamada. Se o resultado não resolve, mude de abordagem ou responda ao cliente com o que você já tem.`,
    previousResult,
  };
}

export function denialPayload(
  toolName: string,
  reason: "tool_cap" | "run_cap",
) {
  return {
    ok: false as const,
    error:
      reason === "tool_cap"
        ? `Limite de chamadas de \`${toolName}\` neste atendimento atingido. Não insista nesta ferramenta — responda ao cliente com o que você já tem.`
        : "Limite de chamadas de ferramenta neste atendimento atingido. Responda ao cliente com o que você já tem, sem novas chamadas.",
    limitReached: true as const,
  };
}
