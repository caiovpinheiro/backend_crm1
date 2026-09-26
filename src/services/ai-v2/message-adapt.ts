/**
 * "Adaptar" mensagem pronta: com a opção ligada na config e o modelo pedindo
 * `adapt`, o texto da mensagem pronta é ajustado ao que o cliente disse
 * (tratamento, o ponto que ele perguntou, conexão com a conversa). O
 * conteúdo não muda: links e números da mensagem têm de sair iguais e nada
 * novo pode entrar. Se a versão adaptada não passar, vai o texto original.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { v2AuxModel } from "@/lib/ai-v2/models";
import { getAgentApiKey } from "@/services/ai/agent-key";
import { generateWithTools } from "@/services/ai/provider";

const URL_RE = /https?:\/\/[^\s<>()]+/gi;
const FIGURE_RE = /\d(?:[\d.,:/h-]*\d)?/g;

function urlsOf(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
}

function figuresOf(text: string): string[] {
  return (text.replace(URL_RE, " ").match(FIGURE_RE) ?? []).map((f) => f.replace(/[.,:/-]+$/, ""));
}

/** A versão adaptada mantém os links e números do original e não traz outros. */
export function adaptedKeepsContent(original: string, adapted: string): { ok: true } | { ok: false; reason: string } {
  const a = adapted.trim();
  if (!a) return { ok: false, reason: "vazia" };
  if (a.length > original.length * 1.6 + 200) return { ok: false, reason: "muito maior que a original" };
  const origUrls = new Set(urlsOf(original));
  const adUrls = new Set(urlsOf(a));
  const lostUrl = [...origUrls].find((u) => !adUrls.has(u));
  if (lostUrl) return { ok: false, reason: `perdeu o link ${lostUrl}` };
  const newUrl = [...adUrls].find((u) => !origUrls.has(u));
  if (newUrl) return { ok: false, reason: `link novo ${newUrl}` };
  const origFigs = new Set(figuresOf(original));
  const adFigs = new Set(figuresOf(a));
  const lostFig = [...origFigs].find((f) => !adFigs.has(f));
  if (lostFig) return { ok: false, reason: `perdeu "${lostFig}"` };
  const newFig = [...adFigs].find((f) => !origFigs.has(f));
  if (newFig) return { ok: false, reason: `número novo "${newFig}"` };
  return { ok: true };
}

export const MESSAGE_ADAPT_SYSTEM = [
  "Você ajusta uma mensagem pronta de atendimento para a conversa em curso, antes de ela ser enviada ao cliente pelo WhatsApp.",
  "Pode: trocar a saudação e o tratamento, ligar o começo ao que o cliente acabou de dizer, tirar trechos que claramente não se aplicam a ele e reordenar para responder primeiro o que ele perguntou.",
  "Não pode: acrescentar informação, mudar ou tirar links, números, datas, valores, prazos ou passos, nem prometer nada que a mensagem não diz.",
  "Mantenha o tom e a formatação do WhatsApp (*negrito*, listas). Responda só com o texto final da mensagem, sem comentários.",
].join("\n");

/**
 * Texto adaptado, ou o original quando a adaptação falha ou não passa na
 * checagem. `reason` explica por que ficou o original.
 */
export async function adaptMessageModelText(args: {
  agentId: string;
  config: V2AgentConfig;
  text: string;
  clientMessage: string;
}): Promise<{ text: string; adapted: boolean; reason?: string }> {
  const original = args.text;
  if (!original.trim() || !args.clientMessage.trim()) return { text: original, adapted: false, reason: "sem mensagem do cliente" };
  try {
    const apiKey = await getAgentApiKey(args.agentId);
    const user = [
      `Mensagem do cliente:\n${args.clientMessage.slice(0, 1500)}`,
      `Mensagem pronta:\n${original}`,
    ].filter(Boolean).join("\n\n");
    const result = await generateWithTools({
      model: v2AuxModel(args.config.model),
      apiKey,
      system: MESSAGE_ADAPT_SYSTEM,
      messages: [{ role: "user", content: user }] as never,
      temperature: 0.2,
      maxOutputTokens: Math.min(2000, Math.ceil(original.length / 2) + 300),
      maxSteps: 1,
    });
    const adapted = result.text.trim().replace(/^```\w*\s*/, "").replace(/```\s*$/, "").trim();
    const check = adaptedKeepsContent(original, adapted);
    if (!check.ok) return { text: original, adapted: false, reason: check.reason };
    return { text: adapted, adapted: true };
  } catch (err) {
    return { text: original, adapted: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
