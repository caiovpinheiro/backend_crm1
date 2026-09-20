/**
 * Execução de ações estruturadas da v2 simples.
 *
 * Reaproveita as ferramentas existentes do runner v1 (`buildToolSet` de
 * `@/services/ai/tools`), sem duplicar implementação. Cada ação é mapeada
 * para uma tool pelo nome; a allowlist da config decide quais podem rodar.
 */

import { buildToolSet, type RunContext } from "@/services/ai/tools";
import type { SimpleAction, SimpleActionType } from "@/lib/ai-simple/types";

export type ExecuteActionsInput = {
  actions: SimpleAction[];
  allowedActions: SimpleActionType[];
  runContext: RunContext;
};

export type ExecuteActionsResult = {
  executed: Array<{ action: SimpleAction; result: unknown }>;
  discarded: SimpleAction[];
};

export async function executeSimpleActions(
  input: ExecuteActionsInput,
): Promise<ExecuteActionsResult> {
  const executed: Array<{ action: SimpleAction; result: unknown }> = [];
  const discarded: SimpleAction[] = [];

  if (input.actions.length === 0) return { executed, discarded };

  const toolSet = buildToolSet(
    input.runContext,
    input.allowedActions,
    null,
    undefined,
  );

  for (const action of input.actions) {
    if (!input.allowedActions.includes(action.type)) {
      discarded.push(action);
      continue;
    }

    const tool = toolSet[action.type] as
      | { execute: (args: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => Promise<unknown> }
      | undefined;
    if (!tool) {
      discarded.push(action);
      console.warn("[ai-simple] tool não encontrada", { tool: action.type });
      continue;
    }

    try {
      const result = await tool.execute(action.args, {});
      executed.push({ action, result });
    } catch (err) {
      discarded.push(action);
      console.warn("[ai-simple] tool falhou", {
        tool: action.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { executed, discarded };
}
