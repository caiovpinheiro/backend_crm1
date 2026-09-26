/**
 * Checagem por modelo, afirmação por afirmação: um modelo auxiliar lê a
 * resposta e as fontes (trechos da base, instruções, dados do cliente,
 * calendário) e aponta o que a resposta afirma sem sustentação. Pega o que
 * as regras fixas não pegam: política sem número ("a instalação é
 * gratuita"), conhecimento geral, recurso que não existe, material citado
 * que não existe. Nenhum domínio de cliente.
 */

import { generateWithTools } from "@/services/ai/provider";

/** Tempo máximo da checagem: passou disso, a resposta segue (não trava o atendimento). */
export const CLAIM_CHECK_TIMEOUT_MS = 8000;
const MAX_SOURCE_CHARS = 14000;

const CLAIM_CHECK_SYSTEM = `Você confere se a resposta de um atendente está sustentada pelas fontes da empresa.

Leia a resposta e liste SÓ as afirmações de fato que NÃO estão sustentadas pelas fontes. Afirmação de fato é o que o cliente poderia usar como verdade: regra, política, condição, valor, prazo, data, horário, canal de contato, link, nome de tela, menu ou botão, passo de um procedimento, recurso ou serviço que existe ou não existe, material ou documento citado.

Está sustentada quando as fontes dizem o mesmo, mesmo com outras palavras, ou quando é consequência direta do que elas dizem.

NÃO liste:
- cumprimento, cortesia, empatia, oferta de ajuda, pergunta ao cliente;
- dizer que não tem a informação, que não consegue confirmar ou que vai chamar alguém da equipe;
- dados do próprio cliente que aparecem nas fontes;
- repetir o que o cliente disse sem confirmar como verdade.
- dizer o que o atendente vai fazer agora ou em seguida ("vou te orientar", "vou te enviar o passo a passo", "segue o material"): é intenção, não fato — só é afirmação se trouxer regra, valor, prazo ou canal que as fontes não dizem.

O que o cliente disse sobre a própria situação (o valor que veio no boleto dele, a data em que comprou, o que aparece na tela dele) pode ser usado para explicar a regra das fontes: isso NÃO é afirmação sem fonte. Só é sem fonte quando a resposta confirma como regra, preço, prazo ou condição da empresa algo que só o cliente afirmou e as fontes não dizem (ex.: cliente "a taxa é R$ 30, né?" → resposta "Isso, a taxa é R$ 30").

Responda só com JSON: {"unsupported": ["trecho curto da resposta com a afirmação sem fonte", ...]}. Sem nenhuma, {"unsupported": []}.`;

/** Primeiro objeto JSON do texto (o modelo às vezes escreve antes/depois). */
function extractFirstJSONObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

/** Vale a pena conferir: resposta com conteúdo (não só cortesia curta). */
export function worthClaimCheck(reply: string): boolean {
  const words = reply.trim().split(/\s+/).filter(Boolean);
  if (words.length < 5) return false;
  // Só pergunta(s) ao cliente: nada afirmado.
  const sentences = reply.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  return !sentences.every((s) => s.endsWith("?"));
}

export function buildClaimCheckInput(args: { reply: string; sources: string[]; clientTexts: string[] }): string {
  let budget = MAX_SOURCE_CHARS;
  const kept: string[] = [];
  for (const s of args.sources.map((x) => x.trim()).filter(Boolean)) {
    if (budget <= 0) break;
    const piece = s.length > budget ? `${s.slice(0, budget)}…` : s;
    kept.push(piece);
    budget -= piece.length;
  }
  return [
    `Fontes da empresa:\n${kept.map((s, i) => `[${i + 1}] ${s}`).join("\n\n") || "(nenhuma)"}`,
    `O que o cliente disse (não é fonte):\n${args.clientTexts.slice(-4).map((t) => `- ${t.slice(0, 400)}`).join("\n") || "(nada)"}`,
    `Resposta do atendente:\n${args.reply}`,
  ].join("\n\n");
}

export function parseClaimCheck(text: string, reply: string): string[] {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const extracted = extractFirstJSONObject(cleaned);
    try {
      parsed = extracted ? JSON.parse(extracted) : undefined;
    } catch {
      parsed = undefined;
    }
  }
  const list = (parsed as { unsupported?: unknown } | undefined)?.unsupported;
  if (!Array.isArray(list)) return [];
  // Só trechos que existem na resposta: o verificador às vezes inventa o que apontar.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const replyNorm = norm(reply);
  return [...new Set(
    list
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().replace(/^["“]|["”]$/g, ""))
      .filter((x) => x.length >= 3 && replyNorm.includes(norm(x).slice(0, 40))),
  )].slice(0, 5);
}

/** Afirmações sem fonte segundo o modelo auxiliar. Falha ou demora: lista vazia. */
export async function checkClaimsWithModel(args: {
  model: string;
  apiKey: string;
  reply: string;
  sources: string[];
  clientTexts: string[];
}): Promise<{ unsupported: string[]; inputTokens: number; outputTokens: number; ok: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      generateWithTools({
        model: args.model,
        apiKey: args.apiKey,
        system: CLAIM_CHECK_SYSTEM,
        messages: [{ role: "user", content: buildClaimCheckInput(args) }] as any,
        tools: {},
        temperature: 0,
        maxOutputTokens: 300,
        maxSteps: 1,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("tempo esgotado")), CLAIM_CHECK_TIMEOUT_MS);
      }),
    ]);
    return { unsupported: parseClaimCheck(res.text, args.reply), inputTokens: res.inputTokens, outputTokens: res.outputTokens, ok: true };
  } catch (err) {
    console.warn("[ai-v2] checagem por modelo falhou:", err instanceof Error ? err.message : err);
    return { unsupported: [], inputTokens: 0, outputTokens: 0, ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
