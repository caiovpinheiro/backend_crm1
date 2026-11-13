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
  /** Mantido só para agentes antigos: vai para o fim da lista e não entra no teto de preço desconhecido. */
  legacy?: boolean;
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
  { id: "gpt-4-turbo", label: "GPT-4 Turbo (antigo)", provider: "openai", hint: "Mantido para agentes antigos.", reasoning: false, temperature: true, jsonMode: true, inputPer1M: 10, outputPer1M: 30, legacy: true },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo (antigo)", provider: "openai", hint: "Mantido para agentes antigos.", reasoning: false, temperature: true, jsonMode: true, inputPer1M: 0.5, outputPer1M: 1.5, legacy: true },
];

/** Modelo auxiliar (busca, mídia, avaliador) quando o agente usa outro fornecedor. */
export const V2_AUX_OPENAI_MODEL = "gpt-4.1-mini";

/** Só os modelos fixos do código (com preço de tabela). */
export function v2ModelInfo(id: string): V2ModelInfo | undefined {
  return V2_MODELS.find((m) => m.id === id);
}

export type V2ModelCaps = Pick<V2ModelInfo, "id" | "provider" | "reasoning" | "temperature" | "jsonMode">;

/**
 * O que a chamada pode mandar ao modelo: o da lista fixa ou, para modelo
 * descoberto no provedor ("Atualizar modelos"), o deduzido pelo id.
 * Fora disso (id que não é de chat), undefined.
 */
export function v2ModelCaps(id: string): V2ModelCaps | undefined {
  const info = v2ModelInfo(id);
  if (info) return info;
  return inferV2ModelCaps(id);
}

/** Fornecedor só pelo id (vale para modelo descoberto). */
export function providerFromModelId(id: string): V2ModelProvider {
  return id.startsWith("claude-") ? "anthropic" : "openai";
}

const OPENAI_NOT_CHAT = /(embedding|whisper|tts|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|instruct|codex|computer-use|sora|deep-research)/;
const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;

/**
 * Serve para o agente: modelo de chat e texto. Fora: embeddings, áudio,
 * imagem, moderação, busca, modelos de completar texto e ajustes finos.
 */
export function isAgentChatModelId(provider: V2ModelProvider, rawId: string): boolean {
  const id = rawId.trim().toLowerCase();
  if (!id || id !== rawId || id.includes(":") || id.length > 80) return false;
  if (provider === "anthropic") return /^claude-/.test(id) && !/^claude-(instant|1|2)([-.]|$)/.test(id);
  if (!/^(gpt-\d|o\d)/.test(id)) return false;
  return !OPENAI_NOT_CHAT.test(id);
}

/** Id sem a data de versão (`gpt-4o-2024-08-06` → `gpt-4o`); sem data, ele mesmo. */
export function stripModelDateSuffix(id: string): string {
  return id.replace(DATE_SUFFIX, "");
}

/**
 * Número da família pelo id, para ordenar do mais novo ao mais antigo:
 * gpt-6.1-terra → 6.1; claude-sonnet-4-5 → 4.5; claude-3-5-haiku → 3.5;
 * o3 → 4.3 (entre o 4.x e o 5). Sem número reconhecível: 0.
 */
export function modelFamilyVersion(id: string): number {
  const gpt = /^gpt-(\d+(?:\.\d+)?)/.exec(id);
  if (gpt) return Number(gpt[1]);
  const o = /^o(\d)/.exec(id);
  if (o) return 4 + Number(o[1]) / 10;
  const named = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d)(?!\d))?/.exec(id);
  if (named) return Number(named[1]) + (named[2] ? Number(named[2]) / 10 : 0);
  const old = /^claude-(\d)(?:-(\d)(?!\d))?-/.exec(id);
  if (old) return Number(old[1]) + (old[2] ? Number(old[2]) / 10 : 0);
  return 0;
}

/**
 * Capacidades de um modelo que não está na lista fixa, pelo id. OpenAI:
 * GPT-5 em diante e a série o raciocinam (recusam temperatura); `-chat`
 * não. Anthropic: Haiku e Claude 3 não raciocinam; sem modo JSON.
 */
export function inferV2ModelCaps(id: string): V2ModelCaps | undefined {
  const provider = providerFromModelId(id);
  if (!isAgentChatModelId(provider, id)) return undefined;
  let reasoning: boolean;
  if (provider === "anthropic") {
    reasoning = !/haiku/.test(id) && modelFamilyVersion(id) >= 4;
  } else {
    reasoning = (/^o\d/.test(id) || modelFamilyVersion(id) >= 5) && !/-chat/.test(id);
  }
  return { id, provider, reasoning, temperature: !reasoning, jsonMode: provider === "openai" };
}

/** Nome legível para modelo descoberto sem nome do provedor: gpt-6.1-terra → GPT-6.1 Terra. */
export function prettyModelLabel(id: string): string {
  const base = stripModelDateSuffix(id);
  const parts = base.split("-");
  if (parts[0] === "gpt" && parts[1]) {
    const rest = parts.slice(2).map((w) => (w === "mini" || w === "nano" ? w : w.charAt(0).toUpperCase() + w.slice(1)));
    return [`GPT-${parts[1]}`, ...rest].join(" ") + (base !== id ? ` (${id.slice(base.length + 1)})` : "");
  }
  if (parts[0] === "claude") {
    const words = parts.slice(1);
    const out: string[] = ["Claude"];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (/^\d$/.test(w) && /^\d$/.test(words[i + 1] ?? "")) {
        out.push(`${w}.${words[i + 1]}`);
        i++;
      } else out.push(/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));
    }
    return out.join(" ") + (base !== id ? ` (${id.slice(base.length + 1)})` : "");
  }
  return id;
}

/**
 * Preço usado quando o modelo não tem preço (descoberto e ninguém
 * preencheu): o maior da lista fixa atual do mesmo provedor. Estimativa
 * do lado seguro — o limite de gasto corta antes, nunca depois.
 */
export function unknownModelPriceCeiling(provider: V2ModelProvider): { inputPer1M: number; outputPer1M: number } {
  const list = V2_MODELS.filter((m) => m.provider === provider && !m.legacy);
  return {
    inputPer1M: Math.max(...list.map((m) => m.inputPer1M)),
    outputPer1M: Math.max(...list.map((m) => m.outputPer1M)),
  };
}

/** Fornecedor pelo id (modelo fora da lista: pelo prefixo). */
export function v2ModelProvider(id: string): V2ModelProvider {
  return v2ModelInfo(id)?.provider ?? providerFromModelId(id);
}

/** Modelo para tarefas auxiliares com a chave OpenAI do agente. */
export function v2AuxModel(id: string): string {
  return v2ModelProvider(id) === "openai" ? id : V2_AUX_OPENAI_MODEL;
}

/**
 * Tarefa auxiliar dentro do turno (reformular a busca, conferir a resposta):
 * modelo sem raciocínio. Com o modelo do agente sendo de raciocínio, cada
 * uma somava vários segundos à espera do cliente.
 */
export function v2FastAuxModel(id: string): string {
  const aux = v2AuxModel(id);
  return v2ModelCaps(aux)?.reasoning ? V2_AUX_OPENAI_MODEL : aux;
}
