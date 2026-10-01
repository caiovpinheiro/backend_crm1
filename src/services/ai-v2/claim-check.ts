/**
 * Checagem por modelo, afirmação por afirmação: um modelo auxiliar lê a
 * resposta e as fontes (trechos da base, instruções, dados do cliente,
 * calendário) e aponta o que a resposta afirma sem sustentação. Pega o que
 * as regras fixas não pegam: política sem número ("a instalação é
 * gratuita"), conhecimento geral, recurso que não existe, material citado
 * que não existe. Nenhum domínio de cliente.
 */

import { generateWithTools } from "@/services/ai/provider";
import { getLogger } from "@/lib/logger";

const log = getLogger("ai-v2.claim-check");

/** Tempo máximo da checagem: passou disso, a resposta segue (não trava o atendimento). */
export const CLAIM_CHECK_TIMEOUT_MS = 8000;
const MAX_SOURCE_CHARS = 20000;

const CLAIM_CHECK_SYSTEM = `Você confere se a resposta de um atendente está sustentada pelas fontes da empresa.

Leia a resposta e liste SÓ as afirmações de fato que NÃO estão sustentadas pelas fontes. Afirmação de fato é o que o cliente poderia usar como verdade: regra, política, condição, valor, prazo, data, horário, canal de contato, link, nome de tela, menu ou botão, passo de um procedimento, recurso ou serviço que existe ou não existe, material ou documento citado.

Está sustentada quando as fontes dizem o mesmo, mesmo com outras palavras, ou quando é consequência direta do que elas dizem.

NÃO liste:
- cumprimento, cortesia, empatia, oferta de ajuda, pergunta ao cliente;
- dizer que não tem a informação, que não consegue confirmar ou que vai chamar alguém da equipe;
- dados do próprio cliente que aparecem nas fontes;
- repetir o que o cliente disse sem confirmar como verdade.
- dizer o que o atendente vai fazer agora ou em seguida ("vou te orientar", "vou te enviar o passo a passo", "segue o material"): é intenção, não fato — só é afirmação se trouxer regra, valor, prazo ou canal que as fontes não dizem;
- frase vaga sem dado concreto ("pode levar um tempo", "depende do caso", "varia conforme a solicitação", "fica confuso"): sem número, data, nome, canal ou condição definida, o cliente não tem o que usar como verdade.

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

const STOP = new Set(["para", "como", "com", "sem", "pela", "pelo", "pelas", "pelos", "uma", "umas", "uns", "que", "voce", "seu", "sua", "seus", "suas", "este", "esta", "isso", "esse", "essa", "mais", "menos", "muito", "entao", "tambem", "depois", "antes", "quando", "onde", "aqui", "use", "usar", "entre", "entrar", "acesse", "acessar", "clique", "clicar", "digite", "informe", "coloque", "faca", "fazer", "abra", "abrir", "toque", "tocar", "selecione", "escolha", "disso", "disto", "nisso", "pode", "podem", "podera", "voces"]);
const foldText = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
/** Verbo do passo ("escolha", "toque"): a opção só vale com o mesmo verbo na fonte. */
const ACTION_VERBS = new Set(["acesse", "clique", "digite", "informe", "coloque", "abra", "toque", "selecione", "escolha", "entre", "use", "marque", "confirme", "envie"]);

/** Palavras de conteúdo da afirmação (sem link, sem as que só ligam a frase). */
function contentWordsOf(folded: string): string[] {
  return folded.replace(/https?:\/\/\S+/g, " ").split(/[^a-z0-9]+/).filter((w) => (w.length >= 4 && !STOP.has(w)) || /^\d+$/.test(w));
}

/**
 * Duas marcações do checador apontam a mesma afirmação: uma contém o começo
 * da outra, ou a maior parte das palavras de conteúdo da menor está na maior
 * (cada leitura recorta o trecho da resposta de um jeito).
 */
export function sameClaim(a: string, b: string): boolean {
  const fold = (s: string) => foldText(s).replace(/[*_~`"\u201c\u201d]/g, "").replace(/\s+/g, " ").trim();
  const fa = fold(a);
  const fb = fold(b);
  if (!fa || !fb) return false;
  if (fa.includes(fb.slice(0, 30)) || fb.includes(fa.slice(0, 30))) return true;
  const words = (s: string) => new Set(s.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 || /^\d+$/.test(w)).map((w) => w.slice(0, 6)));
  const wa = words(fa);
  const wb = words(fb);
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  if (small.size === 0) return false;
  return [...small].filter((w) => big.has(w)).length / small.size >= 0.6;
}

/**
 * A afirmação marcada está nas fontes: os links iguais e as palavras de
 * conteúdo (radical de 6 letras) num mesmo trecho curto de uma fonte. O
 * checador às vezes marcava o que o material diz com outras palavras (ex.:
 * o endereço do portal) e o cliente era transferido.
 */
export function claimFoundInSources(claim: string, sources: string[]): boolean {
  // Marcação com mais de uma frase ("Depois disso, sua conta fica pronta.
  // Pelo celular, use o aplicativo."): cada frase pode vir de um trecho
  // diferente; vale quando todas estão nas fontes.
  const parts = claim.split(/(?<=[.!?])\s+/).filter((p) => contentWordsOf(foldText(p)).length > 0 || /https?:\/\//i.test(p));
  if (parts.length > 1) return parts.every((p) => claimFoundInSources(p, sources));
  const c = foldText(claim);
  const urls = [...c.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
  const words = contentWordsOf(c);
  const negated = /\b(?:nao|nunca|sem|nem|nenhum|nenhuma|gratis|gratuit\w*|isent\w*)\b/.test(c);
  const plain = (source: string) => foldText(source).replace(/[*_~`"“”]/g, "").replace(/\s+/g, " ");
  // Nome de tela ou botão ("Toque em *Pagar Fatura*"): duas palavras não
  // bastavam para a conferência por trecho e o passo certo do material era
  // barrado. Vale quando as duas aparecem juntas numa fonte, na mesma ordem —
  // nunca com negação ("não há taxa de cancelamento" contradiz a fonte).
  if (urls.length === 0 && words.length === 2 && !negated) {
    const phrase = new RegExp(`\\b${words[0]}(?:\\s+[a-z]{1,3}){0,2}\\s+${words[1]}\\b`);
    return sources.some((source) => phrase.test(plain(source)));
  }
  // Passo de uma palavra ("Escolha *Telefone*."): vale quando a mesma frase
  // de uma fonte traz a opção e o mesmo verbo de ação ("Escolha a opção Telefone").
  if (urls.length === 0 && words.length === 1 && !negated) {
    const verbs = c.split(/[^a-z0-9]+/).filter((w) => ACTION_VERBS.has(w)).map((w) => w.slice(0, 5));
    if (verbs.length === 0) return false;
    const word = new RegExp(`\\b${words[0]}\\b`);
    return sources.some((source) =>
      foldText(source).replace(/[*_~`"“”]/g, "").split(/(?<=[.!?])\s+|\n+/)
        .some((s) => word.test(s) && s.split(/[^a-z0-9]+/).some((w) => verbs.includes(w.slice(0, 5)))),
    );
  }
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
  if (/\bnao (?:consigo|posso|sei|tenho|temos|encontrei|achei)\b|\bnao (?:esta|estao|foi|ha) (?:informad|disponivel|disponiveis|confirmad|especificad|previst)|\bsem (?:essa |esta )?informacao\b|\bnao da para (?:confirmar|saber)\b/.test(c)) return true;
  // "O material n\u00e3o traz esse encontro", "n\u00e3o consta", "n\u00e3o menciona": a
  // resposta diz que a fonte n\u00e3o tem a informa\u00e7\u00e3o \u2014 n\u00e3o afirma nada.
  if (/\bnao (?:traz|trazem|informa|informam|consta|constam|menciona|mencionam|inclui|incluem|aparece|aparecem|lista|listam|detalha|detalham|especifica|especificam|indica|indicam|mostra|mostram|cobre|cobrem)\b/.test(c)) return true;
  if (/\b(?:vou|irei|vamos|posso) (?:te |lhe )?(?:encaminhar|transferir|direcionar|passar|chamar|pedir)\b|\b(?:encaminhar|transferir|direcionar) (?:seu|o seu|voce|o) (?:atendimento|caso|pedido)\b/.test(c)) return true;
  // "preciso que um atendente analise a tela com você", "alguém da equipe vai
  // conferir": também é aviso de transferência, não afirmação da empresa.
  if (/\b(?:preciso|precisamos|vou precisar) que (?:um|uma|alguem|a equipe|o time|um atendente|uma pessoa|um consultor)\b|\b(?:um|uma) (?:atendente|pessoa|consultor\w*|colega|especialista)(?: da equipe| do time)? (?:vai|precisa|pode|ira) (?:analisar|verificar|conferir|avaliar|resolver|te ajudar|continuar|assumir)\b|\b(?:alguem|a equipe|o time) (?:da equipe |do time )?(?:vai|precisa|pode) (?:analisar|verificar|conferir|avaliar|resolver|te ajudar|continuar|assumir)\b/.test(c)) return true;
  // Cortesia ("fico feliz em ajudar", "por nada"): o checador às vezes marca.
  if (!/\d/.test(c) && c.split(/\s+/).length <= 12 && /\b(?:fico (?:muito )?feliz|feliz em ajudar|que bom|por nada|de nada|obrigad[oa]|disponha|conte comigo|espero ter ajudado|a disposicao|qualquer (?:duvida|coisa)|estou por aqui|e so (?:me )?chamar|bom dia|boa tarde|boa noite|tudo bem)\b/.test(c)) return true;
  if (/(?:^|\bque |\bpelo que |\bcomo )(?:entendi[,.]?\s*)?voce (?:ja |tambem )?(?:enviou|disse|falou|mencionou|informou|tentou|subiu|mandou|comentou|contou|relatou|escreveu)\b/.test(c)) return true;
  // Motivo da transferência ("precisa ser tratado por uma pessoa da equipe").
  if (/\b(?:precisa|deve|tem que) ser (?:tratad|analisad|verificad|resolvid|feit|confirmad|avaliad)\w* (?:por|pela|pelo) (?:uma pessoa|alguem|a equipe|equipe|um atendente|atendente|setor|um consultor)/.test(c)) return true;
  // Pedido ao cliente ("para eu identificar o erro, envie…").
  if (/^para (?:eu|que eu|a gente) (?:identificar|verificar|entender|confirmar|analisar|te ajudar)\b/.test(c)) return true;
  return isVagueClaim(claim);
}

// "Depende de X" fica de fora: afirma uma regra (o avaliador conta como
// invenção quando X não está nas fontes). Só o que não diz nada de
// verificável: prazo indefinido, variação, "caso a caso", comentário.
const VAGUE = /\b(?:depende (?:do caso|da situacao|de cada caso|de varios fatores)|varia|variam|pode (?:variar|levar|demorar|mudar|ser diferente)|podem (?:variar|levar|demorar|mudar)|caso a caso|um pouco de tempo|algum tempo|fica confuso|e comum|e normal|nao e incomum)\b/;

/**
 * Frase vaga sem dado concreto ("o retorno pode levar um pouco de tempo",
 * "o prazo varia conforme a solicitação"): não traz número, data, link,
 * nem nome próprio no meio da frase. O cliente não tem o que usar como
 * verdade; barrar isso virava reescrita (outra frase vaga) e transferência.
 */
export function isVagueClaim(claim: string): boolean {
  const raw = claim.trim();
  if (/\d|https?:\/\/|@/.test(raw)) return false;
  // Nome próprio no meio da frase (menu, sistema, setor): é fato, não vagueza.
  if (raw.split(/\s+/).slice(1).some((w) => /^[*"“(]?\p{Lu}/u.test(w))) return false;
  const c = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return VAGUE.test(c);
}

const ECHO_STOP = new Set(["para", "como", "com", "sem", "pela", "pelo", "uma", "que", "voce", "seu", "sua", "esta", "este", "isso", "esse", "essa", "mais", "menos", "muito", "tambem", "depois", "antes", "quando", "onde", "aqui", "esta", "estao", "nao", "sim", "mas", "porque", "sobre", "entre", "ainda", "sistema", "ja"]);

/**
 * A marcação repete o que o cliente contou sobre a própria situação, numa
 * frase dele que não era pergunta: "o sistema não está aceitando arquivos
 * acima de 60 páginas" quando foi o cliente quem disse isso. Repetir não é
 * afirmar. Se o cliente PERGUNTOU ("a taxa é R$ 30, né?"), confirmar continua
 * sendo afirmação sem fonte.
 */
export function claimEchoesClient(claim: string, clientTexts: string[]): boolean {
  const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const wordsOf = (s: string) => fold(s).split(/[^a-z0-9]+/).filter((w) => (w.length >= 4 && !ECHO_STOP.has(w)) || /^\d+$/.test(w));
  const words = wordsOf(claim.replace(/\d[\d.]*(?:,\d+)?/g, (n) => ` ${n.replace(/\./g, "")} `));
  const numbers = words.filter((w) => /^\d+$/.test(w));
  if (words.length < 2) return false;
  // Pergunta de confirmação ("é R$ 30, né?", "o limite é 40, certo?") não é
  // relato. Relato seguido de pergunta curta ("não está aceitando, e agora?")
  // é relato: vale a parte antes da vírgula.
  const CONFIRMATION_TAIL = /,?\s*(?:n[eé]|certo|correto|n[ãa]o [eé]|[eé] isso|ser[áa]|ser[áa] que|pode ser|confere|verdade)\s*\??\s*$/i;
  const sentences = clientTexts
    .flatMap((t) => t.split(/(?<=[.!?])\s+|\n+/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!/\?\s*$/.test(s)) return CONFIRMATION_TAIL.test(s) ? "" : s;
      if (CONFIRMATION_TAIL.test(s)) return "";
      const comma = s.lastIndexOf(",");
      if (comma < 0) return "";
      const tail = s.slice(comma + 1).trim();
      return tail.split(/\s+/).length <= 4 ? s.slice(0, comma).trim() : "";
    })
    .filter(Boolean);
  return sentences.some((s) => {
    const vocab = new Set(wordsOf(s.replace(/\d[\d.]*(?:,\d+)?/g, (n) => ` ${n.replace(/\./g, "")} `)));
    if (!numbers.every((n) => vocab.has(n))) return false;
    return words.filter((w) => vocab.has(w)).length / words.length >= 0.8;
  });
}

const COMMON_CITABLE = new Set(["sim", "nao", "yes", "no", "true", "false", "ok", "ativo", "inativo", "aberto", "fechado", "pendente"]);

/**
 * A marcação traz um valor do cadastro ou informação montada que o agente
 * pode dizer (e-mail, código, senha provisória): o valor literal está nos
 * dados, então está sustentado — de forma determinística, antes e no lugar
 * do modelo. Só quando, tirando os valores, não sobra número, link nem nome
 * entre aspas: a frase apenas apresentava o dado.
 */
export function claimBackedByCitableValues(claim: string, values: string[]): boolean {
  const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[*_~`]/g, "");
  let rest = fold(claim);
  let hit = false;
  for (const raw of values) {
    const v = fold(String(raw).trim());
    if (v.length < 4 || COMMON_CITABLE.has(v) || !rest.includes(v)) continue;
    hit = true;
    rest = rest.split(v).join(" ");
  }
  if (!hit) return false;
  return !/\d|https?:\/\//.test(rest) && !/["“”]/.test(rest);
}

/** Afirmações sem fonte segundo o modelo auxiliar. Falha ou demora: lista vazia. */
export async function checkClaimsWithModel(args: {
  model: string;
  apiKey: string;
  reply: string;
  sources: string[];
  clientTexts: string[];
  agentHistory?: string[];
  /** Valores do cadastro/informações montadas que o agente pode citar. */
  citableValues?: string[];
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
    const unsupported = flagged.filter((c) => !notAFactClaim(c) && !claimEchoesClient(c, args.clientTexts) && !claimBackedByCitableValues(c, args.citableValues ?? []) && !claimFoundInSources(c, args.sources));
    if (unsupported.length < flagged.length) {
      log.info(
        { descartadas: flagged.length - unsupported.length },
        "[ai-v2] checagem por modelo: marcação descartada, está nas fontes",
      );
    }
    return { unsupported, inputTokens: res.inputTokens, outputTokens: res.outputTokens, ok: true };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      "[ai-v2] checagem por modelo falhou",
    );
    return { unsupported: [], inputTokens: 0, outputTokens: 0, ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
