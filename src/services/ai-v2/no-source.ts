/**
 * "Sem material": resposta com fato (número, data, prazo, passo, caminho,
 * link) quando nada nos materiais cobre a mensagem. O modelo completava com
 * o que parecia óbvio. Vale igual para o WhatsApp e a Conversa de teste.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2CRMContext, V2LLMOutput } from "@/lib/ai-v2/types";
import { calendarPromptSection } from "./calendar";
import { businessHoursText } from "./rules";
import { FACT_IN_SENTENCE, lookupResultTexts, unsupportedFacts, unsupportedFigures, unsupportedLongDates } from "./ground-reply";
import { standaloneClause } from "./reply-trim";
import { WEAK_MATCH_SIMILARITY } from "./similarity-presets";
import { getV2ThemeById } from "./themes";

/** A resposta afirma algo verificável: número/data/prazo, passos, caminho de tela, link. */
export function statesFacts(reply: string): boolean {
  return (
    FACT_IN_SENTENCE.test(reply) ||
    /^\s*\d+[.)]\s+\S/m.test(reply) ||
    /\S\s*[>→»]\s*\S/.test(reply) ||
    /https?:\/\//i.test(reply)
  );
}

/** Passo a passo, caminho de tela ou link: o que só um material sustenta. */
export function statesProcedure(reply: string): boolean {
  return /^\s*\d+[.)]\s+\S/m.test(reply) || /\S\s*[>→»]\s*\S/.test(reply) || /https?:\/\//i.test(reply);
}

/**
 * Fontes fixas do agente, fora dos materiais: informações fixas, regras
 * gerais, instruções do assunto, calendário e o que as consultas do modelo
 * (produtos, CRM) devolveram.
 */
export function fixedSources(
  config: V2AgentConfig,
  themeId: string | null | undefined,
  toolCalls: Array<{ toolName: string; result: unknown }> | undefined,
  now: Date = new Date(),
): string[] {
  return [
    ...(config.variables ?? []).map((v) => `${v.key}: ${v.value}`),
    ...(config.globalRules ?? []),
    (themeId ? getV2ThemeById(config, themeId)?.instructions : undefined) ?? "",
    calendarPromptSection(config.calendar?.events, now, config.businessHours?.timezone || "America/Sao_Paulo"),
    businessHoursText(config),
    ...lookupResultTexts(toolCalls),
  ].filter((s) => s.trim());
}

/**
 * A resposta traz data, valor ou prazo e todos vêm das fontes fixas (ex.: a
 * data do calendário). Passo a passo, caminho e link não entram: esses só o
 * material sustenta.
 */
export function factsBackedBy(reply: string, sources: string[]): boolean {
  if (sources.length === 0 || !FACT_IN_SENTENCE.test(reply) || statesProcedure(reply)) return false;
  return unsupportedFigures(reply, sources).length === 0 && unsupportedFacts(reply, sources).length === 0 && unsupportedLongDates(reply, sources).length === 0;
}

/** A resposta usa um dado do cadastro do cliente (então não é invenção de produto). */
export function mentionsClientData(reply: string, context: V2CRMContext): boolean {
  const text = reply.toLowerCase();
  const values = [context.contact, context.selectedDeal, context.citableContact, context.citableDeal]
    .flatMap((o) => Object.values(o ?? {}))
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map((v) => String(v).trim().toLowerCase())
    .filter((v) => v.length >= 4);
  return values.some((v) => text.includes(v));
}

/** O modelo diz que não tem a informação ("não tenho", "não encontrei", "não consigo confirmar"). */
export function lacksInformation(reply: string): boolean {
  return /\bn[aã]o (?:tenho|encontrei|achei|sei|consigo (?:confirmar|informar|ver|verificar))\b|\bn[aã]o h[aá] (?:essa )?informa|\bsem (?:essa )?informa[cç]/i.test(reply);
}

/**
 * Resposta que orienta o cliente além de avisar a transferência: vale
 * mandar antes do aviso. Antes só o aviso chegava e a orientação se perdia.
 */
export function answersBeforeHandoff(reply: string): boolean {
  const text = reply.trim();
  if (text.split(/\s+/).length < 12) return false;
  // Tirando o aviso de transferência e o "não tenho essa informação", sobra
  // orientação? ("A taxa é cobrada só na primeira entrega; o valor exato
  // eu não tenho" — a regra vale mandar.)
  const rest = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => !announcesTransfer(s) && !lacksInformation(s)).join(" ");
  return rest.split(/\s+/).filter(Boolean).length >= 10;
}

// Mesmas formas que `announcesTransfer` reconhece como aviso: "acionar o
// time", "chamar o setor", "passar para a equipe". Faltando aqui, "se o
// erro continuar, será necessário acionar o time" não era vista como
// condição e a resposta transferia na hora, com a instrução junto.
const TRANSFER_WORD = new RegExp(
  [
    String.raw`\b(?:encaminh\w*|transfer(?:ir|irei|imos|e|o|indo)\b|transfir\w*|repass\w*)`,
    String.raw`\b(?:chamar|acionar|envolver|direcionar)\s+(?:(?:voc[eê]|te|lhe)\s+)?(?:para\s+|pra\s+)?(?:algu[eé]m|uma pessoa|um(?:a)? (?:colega|atendente|especialista|respons[áa]vel)|o time|a equipe|o setor|o pessoal|o departamento|a [áa]rea|o suporte|o atendimento)`,
    String.raw`\bpassar\s+(?:voc[eê]\s+|o caso\s+|o atendimento\s+)?(?:para|pra)\s+(?:o time|a equipe|o setor|o atendimento|algu[eé]m|uma pessoa|um atendente)`,
  ].join("|"),
  "i",
);
/** "se"/"caso" como condição: no começo da frase ou depois de vírgula, "e", "mas"… ("o seu caso" e "se aplica" não contam). */
const CONDITION = /(?:^|[,;:(]\s*|\b(?:e|mas|ou|porém|porem|então|entao)\s+)(?:se|caso)(?![\p{L}])/iu;

/**
 * A resposta põe uma condição para transferir ("se o valor continuar
 * diferente, encaminho à equipe"; "caso não apareça, te transfiro"):
 * toda frase que fala em transferir é condicional. Transferir na hora
 * deixava o cliente na fila sem ter conferido o que o agente pediu.
 */
export function conditionalHandoff(reply: string): boolean {
  const sentences = reply.split(/(?<=[.!?])\s+|\n+/).filter((s) => TRANSFER_WORD.test(s));
  return sentences.length > 0 && sentences.every((s) => CONDITION.test(s.trim()));
}

/** A resposta já avisa a transferência (não vale mandar antes do aviso). */
export function announcesTransfer(reply: string): boolean {
  return /\b(?:transfer|encaminh|atendente|equipe)\w*/i.test(reply) ||
    // "vou chamar o time de X", "acionar o setor", "chamar alguém" (e não "chamar a atenção").
    /\b(?:chamar|acionar|envolver|direcionar)\s+(?:(?:voc[eê]|te|lhe)\s+)?(?:para\s+|pra\s+)?(?:algu[eé]m|uma pessoa|um(?:a)? (?:colega|atendente|especialista|respons[áa]vel)|o time|a equipe|o setor|o pessoal|o departamento|a [áa]rea|o suporte|o respons[áa]vel|o especialista|o atendimento|o financeiro)(?![\p{L}])/iu.test(reply) ||
    // "vou te passar para o time…" (e não "vou te passar o link").
    /\b(?:vou|irei|vamos|posso)\s+(?:te\s+|lhe\s+)?passar\s+(?:voc[eê]\s+)?(?:para|pra)\b/i.test(reply);
}

/**
 * Explicação curta do modelo que sai antes da mensagem configurada de
 * transferência: a resposta sem as frases que avisam a transferência (essas
 * viram a mensagem configurada). Vazio quando não sobra explicação. Um
 * caminho só: a mesma situação gera a mesma estrutura de mensagem.
 */
export function handoffExplanation(reply: string): string {
  // A resposta já fecha com a passagem ("Entendo sua frustração. Anotei seu
  // pedido de cancelamento e alguém da equipe te responde por aqui"): vai
  // inteira, como está — é a frase literal da regra. Antes sobrava só o aviso
  // padrão, sem acolhimento nem o pedido (POS8-06, POS4-02, 27/11).
  if (promisesReturn(reply) && !conditionalHandoff(reply)) return reply.trim();
  const lines = reply
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .map((s) => withoutTransferClause(withoutTransferDoneClause(s)))
        .filter((s) => s.trim() && (!isEmpathyOnly(s) || acknowledgesFeeling(s)))
        .join(" ")
        .trim(),
    )
    .filter(Boolean);
  const text = lines.join("\n").trim();
  return text.split(/\s+/).filter(Boolean).length >= 4 || (text && acknowledgesFeeling(text)) ? text : "";
}

/**
 * Acolhimento do que a pessoa sente ("Entendo sua frustração", "sinto pela
 * demora"): não é cortesia vazia, é o que a regra pede antes da passagem.
 * "Entendo a dúvida", "claro", "ok" continuam saindo.
 */
export function acknowledgesFeeling(sentence: string): boolean {
  return /(?<![\p{L}])(?:frustra\p{L}*|chatea\p{L}*|irrita\p{L}*|indigna\p{L}*|chatead\p{L}*|preocupa\p{L}*|susto|transtorno|demora|espera|incômodo|incomodo|sinto\s+(?:muito|por\s+isso|pela|pelo)|lamento)(?![\p{L}])/iu.test(sentence);
}

/**
 * Anúncio no passado ou no presente: "já chamei o time", "já avisei",
 * "passei pra consultora", "tô vendo isso aqui", "estou chamando alguém".
 * A mensagem configurada de transferência sai logo em seguida e diz o mesmo
 * — antes a frase saía duas vezes, às vezes idêntica.
 */
const TRANSFER_DONE_CLAUSE = /,?\s*(?:e\s+)?(?:por isso|ent[ãa]o|assim)?\s*,?\s*(?:eu\s+)?(?:j[áa]\s+)?(?:(?:chamei|passei|encaminhei|transferi|pedi|direcionei|repassei)\b(?=[^.!?]*\b(?:time|equipe|setor|pessoal|consultor|consultora|algu[eé]m|atendente|respons[áa]vel|especialista|colega|coordena|suporte|financeiro|secretaria))|(?:avisei|acionei|sinalizei|notifiquei)\b|(?:t[ôo]|to|estou|j[áa] estou)\s+(?:chamando|passando|encaminhando|transferindo|acionando|avisando)\b)[^.!?]*[.!?]?\s*$/i;
/** Frase só de "estou vendo isso" ("Tô vendo isso aqui pra você."): sem conteúdo, anuncia que alguém vai ver. */
const LOOKING_INTO_IT = /^\s*(?:[\p{L}]+,\s*)?(?:j[áa]\s+)?(?:t[ôo]|to|estou|vou)\s+(?:vendo|verificando|checando|olhando|ver|verificar|checar|olhar)\s+(?:isso|isto|aqui|esse ponto|essa quest[ãa]o)(?:\s+(?:aqui|pra voc[eê]|para voc[eê]|agora|j[áa]|com (?:o|a) (?:time|equipe)))*\s*[.!]?\s*$/iu;

/** Tira a oração que diz que a transferência já foi feita ou está sendo feita (frase que é só isso sai inteira). */
export function withoutTransferDoneClause(sentence: string): string {
  const s = sentence.trim();
  if (LOOKING_INTO_IT.test(s)) return "";
  if (!TRANSFER_DONE_CLAUSE.test(s)) return s;
  const cut = standaloneClause(s.replace(TRANSFER_DONE_CLAUSE, "").trim().replace(/[,;:\s]+$/, ""));
  if (!cut || cut.split(/\s+/).length < 3) return "";
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

/** Oração que anuncia a transferência, ligada por vírgula/conector ("…, então vou chamar a equipe"). */
const TRANSFER_CLAUSE = /,?\s*(?:e\s+)?(?:por isso|ent[ãa]o|assim|portanto|logo|dessa forma|por esse motivo)?\s*,?\s*(?:eu\s+)?(?:vou|irei|vamos|preciso|precisamos|posso)\s+(?:te\s+|lhe\s+)?(?:encaminhar|transferir|passar|chamar|direcionar|acionar|pedir)[^.!?]*[.!?]?\s*$/i;

/**
 * Tira da frase só a oração de aviso ("…, então vou chamar alguém da
 * equipe"): a parte que diz O QUE falta ("seu e-mail não está cadastrado
 * aqui, e ele é necessário para seguir") é a explicação e fica. Frase que é
 * só o aviso sai inteira.
 */
export function withoutTransferClause(sentence: string): string {
  const s = sentence.trim();
  if (!announcesTransfer(s)) return s;
  // "Me manda um print do comprovante que eu passo pra equipe conferir": o
  // pedido fica, sai só "que eu passo pra equipe…" (a frase inteira saía e o
  // pedido do comprovante sumia — POS6-02).
  const relay = s.replace(/[,;]?\s+(?:que|e)\s+(?:eu\s+)?(?:j[áa]\s+)?(?:passo|repasso|encaminho|mando|levo|envio)\s+(?:pra|para|[àa])\s+(?:a\s+|o\s+)?(?:equipe|time|setor|atendimento|algu[eé]m|consultor\p{L}*)\b[^.!?]*([.!?]?)\s*$/iu, "$1").trim();
  if (relay !== s && relay.split(/\s+/).length >= 3 && !announcesTransfer(relay)) return /[.!?]$/.test(relay) ? relay : `${relay}.`;
  // "…online; vou te passar…" deixava "online;." e "Como X, vou chamar…" deixava "Como X.".
  const cut = standaloneClause(s.replace(TRANSFER_CLAUSE, "").trim().replace(/[,;:\s]+$/, ""));
  if (!cut || announcesTransfer(cut) || cut.split(/\s+/).length < 3) return "";
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

/** Frase só de empatia/cortesia, sem conteúdo ("Ana, entendo a dúvida."). */
export function isEmpathyOnly(sentence: string): boolean {
  const s = sentence.trim().replace(/^[\p{L}\s]{1,30}?[,!]\s*/u, "");
  if (s.split(/\s+/).length > 7) return false;
  return /^(?:entendo|entendi|compreendo|imagino|sinto muito|poxa|que pena|tudo bem|claro|certo|perfeito|ok|obrigad[oa]|sem problemas?)\b/i.test(s);
}

/**
 * Frase de "sem fonte": o campo da tela ("Se não achar a informação nos
 * materiais", `fallback.noSource.message`) vale para as duas conferências —
 * material vazio e afirmação sem fonte. Agente antigo que só tem o campo
 * escondido (`groundingFallbackMessage` com `groundingFallback="answer"`)
 * continua com ele. Vazio = nenhuma frase configurada.
 */
export function noSourceReplyMessage(config: Pick<V2AgentConfig, "fallback" | "groundingFallback" | "groundingFallbackMessage">): string {
  const screen = config.fallback?.noSource?.message?.trim();
  if (screen) return screen;
  return config.groundingFallback === "answer" ? config.groundingFallbackMessage?.trim() ?? "" : "";
}

/**
 * A conferência de afirmações responde (sem transferir) quando há frase de
 * "sem fonte" na tela; sem ela, vale o modo antigo (padrão: transferir).
 */
export function groundingAnswersWithoutHandoff(config: Pick<V2AgentConfig, "fallback" | "groundingFallback">): boolean {
  return !!config.fallback?.noSource?.message?.trim() || config.groundingFallback === "answer";
}

/**
 * A resposta traz conteúdo além da pergunta do fim (informação, valor,
 * explicação): "O curso custa R$ 199 com a bolsa. Vamos garantir?" não é
 * troca sem avanço só por terminar em "?". Reconhecimento curto
 * ("Entendo.", "A rotina pesa mesmo.") não conta como conteúdo.
 */
export function hasContentBeyondQuestion(reply: string): boolean {
  const statements = reply
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith("?") && !isEmpathyOnly(s));
  if (statements.length === 0) return false;
  const text = statements.join(" ");
  // Fato (valor, data, prazo, percentual, passo, link) é avanço. Sem fato,
  // só explicação de verdade: duas frases e 20+ palavras — uma abertura
  // longa ("Entendo, muita gente passa por isso…") não zera o contador.
  if (statesFacts(text)) return true;
  return statements.length >= 2 && text.split(/\s+/).filter(Boolean).length >= 20;
}

/** Tira a(s) pergunta(s) do fim: o que sobra é a parte que informa ("" se só havia pergunta). */
export function withoutTrailingQuestion(reply: string): string {
  const sentences = reply
    .trim()
    .split(/\n+/)
    .flatMap((line, i, all) => line.split(/(?<=[.!?])\s+/).map((s, j, parts) => (j === parts.length - 1 && i < all.length - 1 ? `${s}\n` : `${s} `)));
  while (sentences.length > 0 && sentences[sentences.length - 1].trim().endsWith("?")) sentences.pop();
  return sentences.join("").trim();
}

/** Resposta que já fecha o turno: termina em pergunta ou diz que a equipe/o agente retorna. */
export function explanationClosesTurn(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\?\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]\s*)*$/u.test(t)) return true;
  return promisesReturn(t);
}

/**
 * A resposta já diz que a equipe ou o agente retorna ("anotei e te respondo
 * por aqui", "a equipe te responde", "já já te chamam"). Só isso dispensa o
 * aviso de transferência logo depois; terminar em pergunta, não.
 */
export function promisesReturn(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /(?<![\p{L}])(?:j[áa]\s+te\s+retorno|te\s+retorno|te\s+dou\s+(?:um\s+)?retorno|retorno\s+(?:por\s+aqui|j[áa]|em\s+breve)|volto\s+(?:a\s+falar|aqui|j[áa])|te\s+(?:chamo|aviso|respondo|confirmo)(?:\s+(?:por\s+aqui|aqui|j[áa]|em\s+breve))?|(?:eu\s+)?vejo\s+(?:isso|isto|o\s+\p{L}+|a\s+\p{L}+)?\s*com\s+voc[eê]|vejo\s+isso\s+(?:aqui|pra\s+voc[eê])|(?:a\s+)?equipe\s+(?:j[áa]\s+)?(?:te\s+)?(?:responde|retorna|chama|manda|fala\s+com\s+voc[eê])|algu[eé]m\s+(?:da\s+equipe\s+)?(?:j[áa]\s+)?(?:te\s+)?(?:chama|responde|retorna)|j[áa]\s+j[áa]\s+te\s+(?:chamam|chamo|respondem|respondo|retornam|retorno))(?![\p{L}])/iu.test(t);
}

export type V2PrefetchFact = { searched?: boolean; found?: number; bestSimilarity?: number | null };

/** Nada relevante nos materiais para esta mensagem (buscou e não achou). */
export function nothingRelevantFound(prefetch: V2PrefetchFact | undefined): boolean {
  if (!prefetch?.searched) return false;
  return (prefetch.found ?? 0) === 0 || (prefetch.bestSimilarity ?? 0) < WEAK_MATCH_SIMILARITY;
}

/**
 * Aplica a saída "sem material" quando:
 *  - o modelo consultou e tudo voltou vazio, e não há dado do cliente; ou
 *  - nada relevante nos materiais (pré-busca e consultas do modelo) e a
 *    resposta afirma fatos que não vêm do cadastro do cliente.
 * Muda `output` no lugar. `handoff` diz se transferiu (sem mensagem
 * configurada) ou só respondeu com a mensagem "sem material".
 */
export function applyNoSourceGuard(args: {
  config: V2AgentConfig;
  output: V2LLMOutput;
  context: V2CRMContext;
  toolCalls: Array<{ toolName: string; args?: unknown; result: unknown }> | undefined;
  queriedEmpty: boolean;
  prefetch: V2PrefetchFact | undefined;
  /** Assunto do turno: as instruções dele contam como fonte fixa. */
  themeId?: string | null;
  /**
   * Mensagens da conversa (cliente e agente: proposta enviada, cartão do
   * produto, valor que a pessoa escreveu). O que está nelas não é invenção —
   * a conferência do turno já as aceita; aqui a resposta inteira virava o
   * aviso padrão (POS6-05: "a taxa é R$ 99", com a proposta na conversa).
   */
  conversationTexts?: string[];
}): { applied: boolean; handoff: boolean; explanationDropped?: boolean; trimmed?: boolean } {
  const { config, output, context } = args;
  const backing = [...fixedSources(config, args.themeId, args.toolCalls), ...(args.conversationTexts ?? []).filter((t) => t?.trim())];
  if (output.concluded) return { applied: false, handoff: false };
  const hasClientData = !!context.contact || !!context.selectedDeal;
  const modelQueried = (args.toolCalls ?? []).some((c) => !(c.args as { prefetch?: boolean } | undefined)?.prefetch);
  const modelFound = modelQueried && !args.queriedEmpty;
  const legacy = args.queriedEmpty && !hasClientData;
  const invented =
    (args.queriedEmpty || (nothingRelevantFound(args.prefetch) && !modelFound)) &&
    statesFacts(output.reply) &&
    !mentionsClientData(output.reply, context) &&
    // Data do calendário, valor das informações fixas, preço do catálogo:
    // não é invenção só porque os materiais não falam disso.
    !factsBackedBy(output.reply, backing);
  // O modelo já transfere: o que importa é a explicação que sai antes do
  // aviso. Fato sem material nela ("o prazo é de 5 dias; vou te passar…")
  // não vai — fica só o aviso configurado.
  if (output.handoff) {
    if (!invented) return { applied: false, handoff: false };
    // Sai só a frase que afirma fato sem apoio; acolhimento, pedido ao
    // cliente e a frase de passagem ficam. Sem nada que sobre, o aviso.
    const keptBeforeHandoff = output.reply
      .split(/\n+/)
      .map((line) => line.split(/(?<=[.!?])\s+/).filter((sent) => sent.trim() && !(statesFacts(sent) && !mentionsClientData(sent, context) && !factsBackedBy(sent, backing))).join(" ").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    output.reply = keptBeforeHandoff || config.handoff.message;
    output.reason = [output.reason, keptBeforeHandoff
      ? "explicação antes da transferência afirmava fatos sem material — essa frase saiu"
      : "explicação antes da transferência afirmava fatos sem material — só o aviso sai"].filter(Boolean).join(" · ");
    return { applied: true, handoff: true, explanationDropped: !keptBeforeHandoff, trimmed: !!keptBeforeHandoff };
  }
  if (!legacy && !invented) return { applied: false, handoff: false };
  const noSourceMessage = noSourceReplyMessage(config);
  if (noSourceMessage) {
    // Sai só a frase que afirma fato sem apoio; o resto da resposta
    // (acolhimento, o que a regra manda dizer) fica, seguido da frase de
    // "sem fonte". Antes a resposta inteira virava só essa frase.
    const fixed = backing;
    const kept = output.reply
      .split(/\n+/)
      .map((line) => line.split(/(?<=[.!?])\s+/).filter((sent) => sent.trim() && !(statesFacts(sent) && !mentionsClientData(sent, context) && !factsBackedBy(sent, fixed))).join(" ").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    output.handoff = false;
    // Consultou e não achou nada, sem dado do cliente: a resposta toda é
    // palpite; vai só a frase. Nos demais, fica o que não afirma fato.
    output.reply = !legacy && kept && kept.split(/\s+/).length >= 3 ? `${kept} ${noSourceMessage}` : noSourceMessage;
    output.reason = "Nada nos materiais cobre a mensagem (consulta sem resultados) — saída 'sem material de consulta' configurada";
    return { applied: true, handoff: false };
  }
  output.handoff = true;
  output.reply = config.handoff.message;
  output.reason = "Nada nos materiais cobre a mensagem (consulta sem resultados)";
  return { applied: true, handoff: true };
}
