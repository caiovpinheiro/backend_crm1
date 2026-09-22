/**
 * Simulação de turno v2 para a aba Testar.
 * Não persiste estado nem executa ações reais.
 */

import type { V2Action, V2AgentConfig, V2CRMContext } from "@/lib/ai-v2/types";
import { evaluateV2Rules, isWithinV2BusinessHours } from "./rules";
import { selectV2Theme, getV2ThemeById } from "./themes";
import { callV2LLMTest } from "./llm";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";

export type V2TestTurnHistoryItem = { role: "user" | "assistant"; content: string };

export type V2TestTurnResult = {
  userMessage: string;
  appliedRuleId: string | null;
  appliedRuleName: string | null;
  themeId: string | null;
  themeName: string | null;
  reply: string;
  reason: string;
  handoff: boolean;
  closed: boolean;
  toolCalls: Array<{ toolName: string; args: unknown; result: unknown }>;
  ragChunks: Array<{ docId?: string; docTitle?: string; text?: string; score?: number }>;
  executedActions: Array<{ action: V2Action; label: string }>;
  discardedActions: Array<{ action: V2Action; label: string; reason: string }>;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  tone: string;
  responseLength: string;
  globalRules: string[];
  systemPrompt: string;
};

const ACTION_LABELS: Record<string, string> = {
  add_tag: "Adicionar etiqueta",
  update_field: "Atualizar campo",
  add_note: "Registrar anotação",
  create_deal: "Criar negócio",
  move_stage: "Mover etapa do negócio",
  create_activity: "Criar atividade",
  send_message_model: "Enviar mensagem pronta",
  send_product: "Enviar produto",
  send_whatsapp_template: "Enviar template oficial",
  ask_with_options: "Perguntar com opções",
  close_conversation: "Encerrar conversa",
  tabulate_conversation: "Classificar atendimento",
  handoff: "Passar para uma pessoa",
  set_theme: "Definir assunto",
  set_variable: "Definir variável",
  record_knowledge_gap: "Registrar dúvida sem resposta",
  start_survey: "Iniciar pesquisa de satisfação",
  send_message: "Enviar mensagem",
};

function actionLabel(type: string): string {
  return ACTION_LABELS[type] ?? type;
}

export async function simulateV2Turn(
  agentId: string,
  config: V2AgentConfig,
  userMessage: string,
  history: V2TestTurnHistoryItem[] = [],
): Promise<V2TestTurnResult> {
  const emptyContext: V2CRMContext = { contact: null, deals: [], selectedDeal: null, fields: config.contextFields };

  const apiKey = await tryGetAgentApiKey(agentId);
  if (!apiKey) {
    throw new Error("NO_OPENAI_KEY");
  }

  const rule = evaluateV2Rules(
    config,
    {
      userMessage,
      isFirstMessage: history.length === 0,
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

  const llmResult = await callV2LLMTest(agentId, config, userMessage, history);
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
  const executedActions: V2TestTurnResult["executedActions"] = [];
  const discardedActions: V2TestTurnResult["discardedActions"] = [];
  for (const action of output.actions) {
    if (allowedToolSet.has(action.type)) {
      executedActions.push({ action, label: actionLabel(action.type) });
    } else {
      discardedActions.push({
        action,
        label: actionLabel(action.type),
        reason: activeTheme
          ? `"${activeTheme.name}" não permite esta ação — libere em Assuntos › ${activeTheme.name} › O que ele pode fazer.`
          : "Nenhum assunto ativo libera esta ação.",
      });
    }
  }

  // Extrai chunks do RAG dos toolCalls.
  const ragChunks: V2TestTurnResult["ragChunks"] = [];
  for (const call of llmResult.toolCalls ?? []) {
    const result = call.result as Record<string, unknown> | undefined;
    if (call.toolName === "knowledge_search" && result && Array.isArray(result.chunks)) {
      for (const chunk of result.chunks as Array<Record<string, unknown>>) {
        ragChunks.push({
          docId: typeof chunk.docId === "string" ? chunk.docId : undefined,
          docTitle: typeof chunk.docTitle === "string" ? chunk.docTitle : undefined,
          text: typeof chunk.content === "string" ? chunk.content : undefined,
          score: typeof chunk.distance === "number" ? chunk.distance : undefined,
        });
      }
    }
  }

  return {
    userMessage,
    appliedRuleId,
    appliedRuleName: rule?.name ?? null,
    themeId,
    themeName: activeTheme?.name ?? null,
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
    tone: config.tone,
    responseLength: config.responseLength,
    globalRules: config.globalRules,
    systemPrompt: llmResult.systemPrompt,
  };
}
