/**
 * Chamada ao LLM para a v2 simples.
 *
 * Reaproveita a chave OpenAI do agente via `getAgentApiKey` e o modelo
 * via `getModel` do provider existente. Não depende do runner/tools antigos.
 */

import { generateText } from "ai";
import { z } from "zod";
import { getModel } from "@/services/ai/provider";
import { getAgentApiKey } from "@/services/ai/agent-key";
import type { SimpleConfig, SimpleLLMOutput } from "@/lib/ai-simple/types";

const simpleActionSchema = z.object({
  tool: z.enum([
    "create_deal",
    "add_tag",
    "create_activity",
    "search_products",
    "move_stage",
    "send_whatsapp_template",
  ]),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const simpleLLMOutputSchema = z.object({
  reply: z.string(),
  confirmed: z.boolean().nullable().default(null),
  mode: z.string().nullable().default(null),
  actions: z.array(simpleActionSchema).default([]),
  handoff: z.boolean().default(false),
  reason: z.string().default(""),
});

export type GenerateSimpleInput = {
  agentId: string;
  model: string;
  temperature: number;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
};

export type GenerateSimpleResult =
  | {
      ok: true;
      output: SimpleLLMOutput;
      inputTokens: number;
      outputTokens: number;
      raw: string;
    }
  | {
      ok: false;
      error: string;
      raw: string;
      inputTokens: number;
      outputTokens: number;
    };

export async function generateSimpleResponse(
  input: GenerateSimpleInput,
): Promise<GenerateSimpleResult> {
  const apiKey = await getAgentApiKey(input.agentId).catch((err) => {
    throw new Error(`[ai-simple] chave do agente: ${err instanceof Error ? err.message : String(err)}`);
  });

  const model = getModel(input.model, apiKey);

  const result = await generateText({
    model,
    system: input.system,
    messages: input.messages,
    temperature: input.temperature,
    maxOutputTokens: input.maxTokens,
  });

  const raw = result.text ?? "";
  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;

  const parsed = parseSimpleOutput(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      raw,
      inputTokens,
      outputTokens,
    };
  }

  return {
    ok: true,
    output: parsed.data,
    inputTokens,
    outputTokens,
    raw,
  };
}

function parseSimpleOutput(raw: string): { ok: true; data: SimpleLLMOutput } | { ok: false; error: string } {
  const jsonText = extractJsonBlock(raw);
  if (!jsonText) {
    return { ok: false, error: "Nenhum JSON encontrado na resposta" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, error: `JSON inválido: ${err instanceof Error ? err.message : String(err)}` };
  }

  const validation = simpleLLMOutputSchema.safeParse(parsed);
  if (!validation.success) {
    return { ok: false, error: `Shape inválido: ${validation.error.message}` };
  }

  return { ok: true, data: validation.data as SimpleLLMOutput };
}

function extractJsonBlock(text: string): string | null {
  const trimmed = text.trim();

  // Resposta pura JSON.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  // Bloco markdown ```json ... ```
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(text);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Primeiro objeto JSON no texto.
  const objectMatch = /\{[\s\S]*\}/.exec(text);
  return objectMatch ? objectMatch[0] : null;
}
