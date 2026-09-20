/**
 * Chamada ao LLM para o motor v2.
 * Gera JSON estruturado e valida com Zod; faz 1 retry se inválido.
 * Nenhum domínio de cliente.
 */

import { z } from "zod";
import { generateWithTools } from "@/services/ai/provider";
import { getAgentApiKey } from "@/services/ai/agent-key";
import { behaviorToTemperature } from "@/lib/ai-v2/response-behavior";
import type {
  V2Action,
  V2AgentConfig,
  V2LLMOutput,
  V2Sentiment,
  V2CRMContext,
} from "@/lib/ai-v2/types";

const v2ActionSchema: z.ZodType<V2Action> = z.object({
  type: z.enum([
    "add_tag",
    "update_field",
    "add_note",
    "create_deal",
    "move_stage",
    "create_activity",
    "send_message_model",
    "send_product",
    "send_whatsapp_template",
    "ask_with_options",
    "close_conversation",
    "tabulate_conversation",
    "handoff",
    "set_theme",
    "set_variable",
    "record_knowledge_gap",
    "start_survey",
  ]),
}).passthrough();

const v2LLMOutputSchema: z.ZodType<V2LLMOutput> = z.object({
  reply: z.string(),
  theme: z.string().optional(),
  messageModel: z.object({ id: z.string(), adapt: z.boolean().optional().default(false) }).optional(),
  handoff: z.boolean().optional().default(false),
  concluded: z.boolean().optional().default(false),
  confirmed: z.boolean().nullable().optional().default(null),
  outOfScope: z.boolean().optional().default(false),
  sentiment: z.enum(["neutral", "dissatisfied", "angry"]).optional().default("neutral"),
  tabulationId: z.string().optional(),
  collected: z.record(z.string(), z.string()).optional().default({}),
  reason: z.string().optional().default(""),
  actions: z.array(v2ActionSchema).optional().default([]),
}) as unknown as z.ZodType<V2LLMOutput>;

export async function callV2LLMTest(
  agentId: string,
  config: V2AgentConfig,
  userMessage: string,
): Promise<{ output: V2LLMOutput; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const emptyContext: V2CRMContext = {
    contact: null,
    deals: [],
    selectedDeal: null,
    fields: config.contextFields,
  };
  return callV2LLM({
    agentId,
    config,
    context: emptyContext,
    userMessage,
    stage: "active",
    previousMessages: [],
  });
}

function buildV2SystemPrompt(
  config: V2AgentConfig,
  context: V2CRMContext,
  stage: string,
  themeId?: string,
  themeInstructions?: string,
  collectedVariables?: Record<string, unknown>,
): string {
  const lines: string[] = [];
  lines.push(`# Tom de voz\n${config.tone}`);
  lines.push(`# Regras globais\n${config.globalRules.join("\n")}`);

  lines.push("# Dados do cliente (só cite o que está aqui)");
  if (context.contact && Object.keys(context.contact).length > 0) {
    lines.push(`Contato: ${JSON.stringify(context.contact)}`);
  }
  if (context.selectedDeal && Object.keys(context.selectedDeal).length > 0) {
    lines.push(`Negócio: ${JSON.stringify(context.selectedDeal)}`);
  } else {
    lines.push("Negócio: nenhum encontrado.");
  }

  if (config.variables.length > 0) {
    lines.push("# Informações fixas da empresa");
    for (const v of config.variables) lines.push(`${v.key}: ${v.value}`);
  }

  if (themeInstructions) {
    lines.push(`# Tema ativo: ${themeId}`);
    lines.push(themeInstructions);
  }

  if (collectedVariables && Object.keys(collectedVariables).length > 0) {
    lines.push("# Variáveis já coletadas nesta conversa");
    lines.push(JSON.stringify(collectedVariables));
  }

  lines.push(`# Etapa atual\n${stage}`);
  lines.push("# Saída obrigatória");
  lines.push("Responda com um JSON EXATAMENTE neste formato:");
  lines.push(JSON.stringify({
    reply: "texto para o cliente",
    theme: "id do tema (opcional)",
    messageModel: { id: "id do modelo interno", adapt: false },
    handoff: false,
    concluded: false,
    confirmed: null,
    outOfScope: false,
    sentiment: "neutral",
    tabulationId: "id da tabulação (opcional)",
    collected: { "campo": "valor" },
    reason: "por que respondeu assim",
    actions: [{ type: "handoff" }],
  }, null, 2));
  lines.push("Nunca afirme ao cliente que executou uma ação que não esteja em 'actions'.");
  lines.push("Nunca prometa verificar e retornar depois. Se depender de outra pessoa, marque handoff=true.");

  return lines.join("\n\n");
}

export async function callV2LLM(args: {
  agentId: string;
  config: V2AgentConfig;
  context: V2CRMContext;
  userMessage: string;
  stage: string;
  themeId?: string;
  themeInstructions?: string;
  collectedVariables?: Record<string, unknown>;
  previousMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ output: V2LLMOutput; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const apiKey = await getAgentApiKey(args.agentId);
  const system = buildV2SystemPrompt(
    args.config,
    args.context,
    args.stage,
    args.themeId,
    args.themeInstructions,
    args.collectedVariables,
  );

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(args.previousMessages ?? []),
    { role: "user", content: args.userMessage },
  ];

  const startedAt = Date.now();

  async function attempt(): Promise<{ output: V2LLMOutput; inputTokens: number; outputTokens: number }> {
    const result = await generateWithTools({
      model: args.config.model,
      apiKey,
      system,
      messages: messages as any,
      temperature: behaviorToTemperature(args.config.responseBehavior),
      maxSteps: 1,
      toolChoice: "none",
    });

    const text = result.text.trim();
    const jsonText = text.replace(/^```json\s*/, "").replace(/```\s*$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("LLM output is not valid JSON");
    }

    const validated = v2LLMOutputSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Invalid LLM output schema: ${validated.error.message}`);
    }

    return {
      output: validated.data as V2LLMOutput,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  let lastError: Error | undefined;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await attempt();
      return { ...r, latencyMs: Date.now() - startedAt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("LLM failed");
}
