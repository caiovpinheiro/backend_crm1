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

O que o atendente já disse antes na conversa não é fonte: repetir uma afirmação anterior só está sustentado se as fontes a sustentam.

O que o cliente disse sobre a própria situação (o valor que veio na cobrança dele, a data em que comprou, o que aparece na tela dele) pode ser usado para explicar a regra das fontes: isso NÃO é afirmação sem fonte. Só é sem fonte quando a resposta confirma como regra, preço, prazo ou condição da empresa algo que só o cliente afirmou e as fontes não dizem (ex.: cliente "a taxa é R$ 30, né?" → resposta "Isso, a taxa é R$ 30").

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

export function buildClaimCheckInput(args: { reply: string; sources: string[]; clientTexts: string[]; agentHistory?: string[] }): string {
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
    ...(args.agentHistory?.length
      ? [`O que o atendente já disse antes (não é fonte; só para entender a conversa):\n${args.agentHistory.slice(-3).map((t) => `- ${t.slice(0, 400)}`).join("\n")}`]
      : []),
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
  // Só trechos que existem na resposta: o verificador às vezes inventa o que
  // apontar. Vale o trecho literal ou parafraseado (a maior parte das
  // palavras dele está na resposta); antes a paráfrase era descartada.
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  const replyNorm = norm(reply);
  const replyWords = new Set(replyNorm.split(/[^\p{L}\p{N}$%]+/u).filter(Boolean));
  const inReply = (x: string) => {
    const n = norm(x);
    if (replyNorm.includes(n.slice(0, 40))) return true;
    const words = n.split(/[^\p{L}\p{N}$%]+/u).filter((w) => w.length >= 4 || /\d/.test(w));
    return words.length >= 2 && words.filter((w) => replyWords.has(w)).length / words.length >= 0.7;
  };
  return [...new Set(
    list
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().replace(/^["“]|["”]$/g, ""))
      .filter((x) => x.length >= 3 && inReply(x)),
  )].slice(0, 5);
}

const STOP = new Set(["para", "como", "com", "sem", "pela", "pelo", "pelas", "pelos", "uma", "umas", "uns", "que", "voce", "seu", "sua", "seus", "suas", "este", "esta", "isso", "esse", "essa", "mais", "menos", "muito", "entao", "tambem", "depois", "antes", "quando", "onde", "aqui", "use", "usar", "entre", "entrar", "acesse", "acessar", "clique", "clicar", "digite", "informe", "coloque", "faca", "fazer", "abra", "abrir", "toque", "tocar", "selecione", "escolha", "depois"]);
const foldText = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/**
 * A afirmação marcada está nas fontes: os links iguais e as palavras de
 * conteúdo (radical de 6 letras) num mesmo trecho curto de uma fonte. O
 * checador às vezes marcava o que o material diz com outras palavras (ex.:
 * o endereço do portal) e o cliente era transferido.
 */
export function claimFoundInSources(claim: string, sources: string[]): boolean {
  const c = foldText(claim);
  const urls = [...c.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
  const words = c.replace(/https?:\/\/\S+/g, " ").split(/[^a-z0-9]+/).filter((w) => (w.length >= 4 && !STOP.has(w)) || /^\d+$/.test(w));
  if (urls.length === 0 && words.length < 3) return false;
  for (const source of sources) {
    const sentences = foldText(source).split(/(?<=[.!?])\s+|\n+/);
    for (let i = 0; i < sentences.length; i += 1) {
      const window = `${sentences[i]} ${sentences[i + 1] ?? ""} ${sentences[i + 2] ?? ""}`;
      if (!urls.every((u) => window.includes(u))) continue;
      const vocab = new Set(window.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w.slice(0, 6)));
      const hit = words.filter((w) => vocab.has(w.slice(0, 6))).length;
      if (words.length === 0 || hit / words.length >= 0.8) return true;
    }
  }
  return false;
}

/**
 * Marcação do checador que não é afirmação de fato da empresa:
 *  - admitir que não sabe ("não consigo confirmar", "não tenho essa informação");
 *  - avisar a transferência ("vou encaminhar ao setor…");
 *  - repetir o que o cliente contou ("você enviou…", "você disse…").
 * Barradas, viravam reescrita e depois transferência — o agente pedia ajuda
 * à equipe justamente por dizer que não sabia.
 */
export function notAFactClaim(claim: string): boolean {
  const c = claim.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\bnao (?:consigo|posso|sei|tenho|temos|encontrei|achei)\b|\bnao (?:esta|estao|foi|ha) (?:informad|disponivel|disponiveis|confirmad)|\bsem (?:essa |esta )?informacao\b|\bnao da para (?:confirmar|saber)\b/.test(c)) return true;
  if (/\b(?:vou|irei|vamos|posso) (?:te |lhe )?(?:encaminhar|transferir|direcionar|passar|chamar)\b|\b(?:encaminhar|transferir|direcionar) (?:seu|o seu|voce|o) (?:atendimento|caso|pedido)\b/.test(c)) return true;
  if (/^(?:entendi[,.]?\s*)?voce (?:enviou|disse|falou|mencionou|informou|tentou|subiu|mandou|comentou|contou|relatou|escreveu)\b/.test(c)) return true;
  return false;
}

/** Afirmações sem fonte segundo o modelo auxiliar. Falha ou demora: lista vazia. */
export async function checkClaimsWithModel(args: {
  model: string;
  apiKey: string;
  reply: string;
  sources: string[];
  clientTexts: string[];
  agentHistory?: string[];
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
    const flagged = parseClaimCheck(res.text, args.reply);
    const unsupported = flagged.filter((c) => !notAFactClaim(c) && !claimFoundInSources(c, args.sources));
    if (unsupported.length < flagged.length) {
      console.info("[ai-v2] checagem por modelo: marcação descartada, está nas fontes:", flagged.filter((c) => !unsupported.includes(c)));
    }
    return { unsupported, inputTokens: res.inputTokens, outputTokens: res.outputTokens, ok: true };
  } catch (err) {
    console.warn("[ai-v2] checagem por modelo falhou:", err instanceof Error ? err.message : err);
    return { unsupported: [], inputTokens: 0, outputTokens: 0, ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
