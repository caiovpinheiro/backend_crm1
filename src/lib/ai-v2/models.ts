/**
 * Modelos que o agente v2 pode usar, com o que cada um aceita. A escolha do
 * fornecedor define a chave (OpenAI ou Anthropic, ambas por agente); busca nos
 * materiais, transcrição e tarefas auxiliares continuam na OpenAI.
 *
 * `reasoning`: o modelo pensa antes de responder e esse pensamento conta no
 * limite de tokens da resposta — a chamada ganha folga e esforço baixo.
 * `temperature`: modelos de raciocínio recusam o parâmetro (erro 400).
 */

export type V2ModelProvider = "openai" | "anthropic";

export type V2ModelInfo = {
  id: string;
  label: string;
  provider: V2ModelProvider;
  /** Uma frase para a tela: quando usar. */
  hint: string;
  reasoning: boolean;
  temperature: boolean;
  /** Aceita o modo JSON da API sem esquema. */
  jsonMode: boolean;
  /** USD por 1M tokens. */
  inputPer1M: number;
  outputPer1M: number;
};

export const V2_MODELS: V2ModelInfo[] = [
  { id: "gpt-4o-mini", label: "GPT-4o mini", provider: "openai", hint: "Barato e rápido; o padrão até aqui.", reasoning: false, temperature: true, jsonMode: true, inputPer1M: 0.15, outputPer1M: 0.6 },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", provider: "openai", hint: "Barato, segue instruções melhor que o 4o mini.", reasoning: false, temperature: true, jsonMode: true, inputPer1M: 0.4, outputPer1M: 1.6 },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai", hint: "Geração anterior, mais caro.", reasoning: false, temperature: true, jsonMode: true, inputPer1M: 2.5, outputPer1M: 10 },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "openai", hint: "O mais barato; para volume alto.", reasoning: true, temperature: false, jsonMode: true, inputPer1M: 0.1, outputPer1M: 0.5 },
  { id: "gpt-6-sol", label: "GPT-6 Sol", provider: "openai", hint: "Equilíbrio entre qualidade e custo.", reasoning: true, temperature: false, jsonMode: true, inputPer1M: 2, outputPer1M: 10 },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai", hint: "Barato, família de julho.", reasoning: true, temperature: false, jsonMode: true, inputPer1M: 0.2, outputPer1M: 1.2 },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai", hint: "Intermediário da família de julho.", reasoning: true, temperature: false, jsonMode: true, inputPer1M: 2, outputPer1M: 12 },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai", hint: "Topo da família de julho (preço promocional).", reasoning: true, temperature: false, jsonMode: true, inputPer1M: 4, outputPer1M: 20 },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", hint: "Rápido e barato da Anthropic.", reasoning: false, temperature: true, jsonMode: false, inputPer1M: 1, outputPer1M: 5 },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", hint: "Equilibrado da Anthropic.", reasoning: true, temperature: false, jsonMode: false, inputPer1M: 2, outputPer1M: 10 },
  { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic", hint: "O mais capaz da Anthropic; mais caro.", reasoning: true, temperature: false, jsonMode: false, inputPer1M: 5, outputPer1M: 25 },
  // Antigos: ficam para agentes que já usam.
  { id: "gpt-4-turbo", label: "GPT-4 Turbo (antigo)", provider: "openai", hint: "Mantido para agentes antigos.", reasoning: false, temperature: true, jsonMode: true, inputPer1M: 10, outputPer1M: 30 },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo (antigo)", provider: "openai", hint: "Mantido para agentes antigos.", reasoning: false, temperature: true, jsonMode: true, inputPer1M: 0.5, outputPer1M: 1.5 },
];

/** Modelo auxiliar (busca, mídia, avaliador) quando o agente usa outro fornecedor. */
export const V2_AUX_OPENAI_MODEL = "gpt-4.1-mini";

export function v2ModelInfo(id: string): V2ModelInfo | undefined {
  return V2_MODELS.find((m) => m.id === id);
}

/** Fornecedor pelo id (modelo fora da lista: pelo prefixo). */
export function v2ModelProvider(id: string): V2ModelProvider {
  return v2ModelInfo(id)?.provider ?? (id.startsWith("claude-") ? "anthropic" : "openai");
}

/** Modelo para tarefas auxiliares com a chave OpenAI do agente. */
export function v2AuxModel(id: string): string {
  return v2ModelProvider(id) === "openai" ? id : V2_AUX_OPENAI_MODEL;
}
