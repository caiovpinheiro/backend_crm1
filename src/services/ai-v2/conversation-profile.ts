/**
 * Perfil de conversa por finalidade, memória do que a pessoa contou e
 * resposta em balões. Tudo genérico (sem cliente, setor ou produto) e
 * desligado por padrão: o perfil "support" mantém o comportamento de antes.
 */

import type { V2AgentConfig } from "@/lib/ai-v2/types";

export type V2ConversationProfile = "support" | "sales" | "collections" | "aftercare";

export const CONVERSATION_PROFILES: V2ConversationProfile[] = ["support", "sales", "collections", "aftercare"];

export function conversationProfileOf(config: Pick<V2AgentConfig, "conversationProfile">): V2ConversationProfile {
  const p = config.conversationProfile;
  return p && CONVERSATION_PROFILES.includes(p) ? p : "support";
}

/**
 * Como conversar em cada finalidade. Só jeito de conduzir a conversa: fatos
 * (preço, prazo, condição) continuam vindo das fontes e da conferência.
 */
const PROFILE_GUIDES: Record<Exclude<V2ConversationProfile, "support">, string> = {
  sales: [
    "Você está ajudando a pessoa a tomar uma decisão com segurança, como um consultor que se importa com ela.",
    "Antes de informar, mostre em meia frase que entendeu o que ela disse, com as palavras dela.",
    "Use o que ela já contou (motivo, momento, objeção, preferência) para personalizar a resposta, e não pergunte de novo o que ela já disse.",
    "Pode comentar com entusiasmo a escolha dela, sem inventar característica do produto ou serviço.",
    "Objeção ou dúvida: acolha primeiro, depois responda o ponto que pesa. Se a pessoa disser que vai pensar ou que está comparando, respeite, mostre que é normal e deixe a porta aberta; não pressione.",
    "Proponha o próximo passo quando ela reagir bem ou não tiver mais dúvida. Uma pergunta por vez, e nem toda mensagem precisa terminar em pergunta.",
  ].join("\n"),
  collections: [
    "Você está tratando um valor em aberto com respeito e firmeza.",
    "Reconheça a situação da pessoa sem julgamento e sem constranger.",
    "Valores, prazos, juros e acordos só como estão nas fontes; ofereça as opções que elas trazem.",
    "Nunca ameace, não exponha a pessoa e não crie urgência que as fontes não sustentem.",
    "Feche cada passo com o que a pessoa precisa fazer agora.",
  ].join("\n"),
  aftercare: [
    "Você está cuidando de quem já é cliente: o objetivo é que a pessoa se sinta bem atendida.",
    "Mostre interesse genuíno em como está a experiência dela e acolha reclamação antes de resolver.",
    "Use o que ela já contou para não fazer repetir a história.",
    "Comemore com ela o que deu certo; quando algo não está nas fontes, diga com naturalidade que vai confirmar.",
  ].join("\n"),
};

const PROFILE_LABELS: Record<Exclude<V2ConversationProfile, "support">, string> = {
  sales: "venda consultiva",
  collections: "cobrança",
  aftercare: "pós-venda",
};

/** Bloco do prompt com o jeito de conversar do perfil (vazio no "support"). */
export function profilePromptSection(config: Pick<V2AgentConfig, "conversationProfile">): string {
  const profile = conversationProfileOf(config);
  if (profile === "support") return "";
  return `# Jeito de conversar (${PROFILE_LABELS[profile]})\n${PROFILE_GUIDES[profile]}`;
}

/**
 * Venda e pós-venda podem comentar a escolha do cliente ("ótima escolha");
 * no suporte, opinião continua fora do escopo.
 */
export function profileAllowsOpinion(config: Pick<V2AgentConfig, "conversationProfile">): boolean {
  const profile = conversationProfileOf(config);
  return profile === "sales" || profile === "aftercare";
}

export type V2MemoryField = { key: string; label: string };

/** Memória padrão do perfil de venda, quando a configuração não define a sua. */
export const DEFAULT_SALES_MEMORY: V2MemoryField[] = [
  { key: "motivo", label: "Por que quer (objetivo, motivação)" },
  { key: "momento", label: "Quando pretende começar ou decidir" },
  { key: "objecao", label: "O que preocupa ou pesa na decisão" },
  { key: "preferencia", label: "Preferências que contou (formato, horário, orçamento)" },
];

export function memoryFieldsOf(config: Pick<V2AgentConfig, "conversationProfile" | "personMemory">): V2MemoryField[] {
  const own = (config.personMemory ?? []).filter((f) => f.key?.trim() && f.label?.trim());
  if (own.length > 0) return own;
  return conversationProfileOf(config) === "sales" ? DEFAULT_SALES_MEMORY : [];
}

const valueText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
};

/**
 * "O que você já sabe da pessoa": o que ela contou nos turnos anteriores
 * (guardado em `collected`) e o que ainda falta. O modelo usa para
 * personalizar e não perguntar de novo.
 */
export function memoryPromptSection(
  config: Pick<V2AgentConfig, "conversationProfile" | "personMemory">,
  collected: Record<string, unknown> | undefined,
): string {
  const fields = memoryFieldsOf(config);
  if (fields.length === 0) return "";
  const lines = fields.map((f) => {
    const v = valueText(collected?.[f.key]);
    return `- ${f.label} (chave "${f.key}"): ${v || "ainda não sabe"}`;
  });
  return [
    "# O que você já sabe da pessoa",
    ...lines,
    "Quando a pessoa contar algo disso, guarde em collected com a chave indicada, em poucas palavras, com o que ela disse. Use o que já sabe para personalizar a conversa e não pergunte de novo o que ela já contou.",
  ].join("\n");
}

/** Perguntas que o agente já fez na conversa (frases terminadas em "?"). */
export function askedQuestions(previousMessages: Array<{ role: "user" | "assistant"; content: string }> | undefined, limit = 6): string[] {
  const out: string[] = [];
  for (const m of previousMessages ?? []) {
    if (m.role !== "assistant") continue;
    for (const s of m.content.split(/(?<=[.!?])\s+|\n+/)) {
      const q = s.trim();
      if (q.endsWith("?") && q.length >= 8 && !out.includes(q)) out.push(q);
    }
  }
  return out.slice(-limit);
}

/** Bloco do prompt com as perguntas já feitas (só fora do perfil "support"). */
export function askedQuestionsSection(
  config: Pick<V2AgentConfig, "conversationProfile">,
  previousMessages: Array<{ role: "user" | "assistant"; content: string }> | undefined,
): string {
  if (conversationProfileOf(config) === "support") return "";
  const qs = askedQuestions(previousMessages);
  if (qs.length === 0) return "";
  return ["# Perguntas que você já fez nesta conversa", ...qs.map((q) => `- ${q}`), "Não repita nenhuma delas, nem com outras palavras. Se a pessoa já respondeu, siga a partir da resposta; se não respondeu, siga a conversa de outro jeito."].join("\n");
}

/** Instrução de balões para o prompt (só com `replyBubbles: "split"`). */
export function bubblesPromptLine(config: Pick<V2AgentConfig, "replyBubbles">): string {
  if (config.replyBubbles !== "split") return "";
  return "Escreva como alguém digitando no WhatsApp: quando a resposta tiver mais de uma ideia, separe em até 3 mensagens curtas, com uma linha em branco entre elas (por exemplo, a reação ao que a pessoa disse, a informação, a pergunta). Não divida listas nem passo a passo.";
}

const LIST_LINE = /^\s*(?:\d+[.)]|[-•*])\s+/m;

/**
 * Divide a resposta em até `max` balões pelas linhas em branco. Lista ou
 * passo a passo não se divide; o que passar do limite vai junto no último.
 */
export function splitReplyBubbles(text: string, max = 3): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (LIST_LINE.test(clean)) return [clean];
  const parts = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return [clean];
  if (parts.length <= max) return parts;
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join("\n\n")];
}
