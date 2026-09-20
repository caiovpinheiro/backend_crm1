/**
 * Simulação de turno v2 para a aba Testar.
 * Não persiste estado nem executa ações reais.
 */

import type { V2Action, V2AgentConfig, V2CRMContext } from "@/lib/ai-v2/types";
import { evaluateV2Rules, isWithinV2BusinessHours } from "./rules";
import { selectV2Theme, getV2ThemeById } from "./themes";
import { callV2LLMTest } from "./llm";

export type V2TestTurnResult = {
  userMessage: string;
  appliedRuleId: string | null;
  themeId: string | null;
  reply: string;
  reason: string;
  handoff: boolean;
  closed: boolean;
  toolCalls: Array<{ toolName: string; args: unknown; result: unknown }>;
  ragChunks: Array<{ docId?: string; text?: string; score?: number }>;
  executedActions: V2Action[];
  discardedActions: V2Action[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export async function simulateV2Turn(
  agentId: string,
  config: V2AgentConfig,
  userMessage: string,
): Promise<V2TestTurnResult> {
  const emptyContext: V2CRMContext = { contact: null, deals: [], selectedDeal: null };

  const rule = evaluateV2Rules(
    config,
    {
      userMessage,
      isFirstMessage: true,
      withinBusinessHours: isWithinV2BusinessHours(config),
      contactTags: [],
      mediaKinds: ["text"],
    },
    emptyContext,
  );
  const appliedRuleId = rule?.id ?? null;

  // Tema escolhido pela regra ou pelo selector.
  let themeId: string | null = null;
  if (rule?.actions.some((a) => a.type === "set_theme" && a.themeId)) {
    themeId = rule.actions.find((a) => a.type === "set_theme")?.themeId ?? null;
  }
  if (!themeId) {
    const theme = selectV2Theme(config, userMessage, undefined);
    themeId = theme?.id ?? null;
  }

  const llmResult = await callV2LLMTest(agentId, config, userMessage);
  const output = llmResult.output;

  // Se o LLM sugerir um tema, sobrescreve (ele tem a última palavra na simulação).
  if (output.theme) {
    themeId = output.theme;
  }

  // Filtra ações pela allowlist do tema ativo.
  const activeTheme = getV2ThemeById(config, themeId ?? undefined);
  const allowedToolSet = new Set([
    ...(activeTheme?.allowedTools ?? []),
    "handoff",
    "close_conversation",
    "set_theme",
    "set_variable",
  ]);
  const executedActions: V2Action[] = [];
  const discardedActions: V2Action[] = [];
  for (const action of output.actions) {
    if (allowedToolSet.has(action.type)) executedActions.push(action);
    else discardedActions.push(action);
  }

  // Extrai chunks do RAG dos toolCalls.
  const ragChunks: V2TestTurnResult["ragChunks"] = [];
  for (const call of llmResult.toolCalls ?? []) {
    const result = call.result as Record<string, unknown> | undefined;
    if (call.toolName === "knowledge_search" && result && Array.isArray(result.chunks)) {
      for (const chunk of result.chunks as Array<Record<string, unknown>>) {
        ragChunks.push({
          docId: typeof chunk.docId === "string" ? chunk.docId : undefined,
          text: typeof chunk.text === "string" ? chunk.text : undefined,
          score: typeof chunk.score === "number" ? chunk.score : undefined,
        });
      }
    }
  }

  return {
    userMessage,
    appliedRuleId,
    themeId,
    reply: output.reply,
    reason: output.reason,
    handoff: output.handoff,
    closed: output.concluded,
    toolCalls: llmResult.toolCalls ?? [],
    ragChunks,
    executedActions,
    discardedActions,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
    latencyMs: llmResult.latencyMs,
  };
}
