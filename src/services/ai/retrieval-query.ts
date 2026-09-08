/**
 * Construção da query de recuperação.
 *
 * Antes a busca usava só a mensagem atual. Continuações curtas — "ok",
 * "Não fez ainda?", "já disse", "quero" — não recuperavam nada, e o turno
 * respondia sem base. Metade da conversa do aluno é dêitica: o assunto está
 * na mensagem anterior, não na atual.
 *
 * Agora a query é a mensagem atual mais as últimas mensagens do cliente, e
 * quando a atual é curta ou puramente dêitica o histórico pesa mais (entra
 * mais contexto e a atual deixa de dominar).
 *
 * Não mexe em CHUNK_SIZE, modelo de embedding, topK nem corte de distância.
 *
 * Cuidado que originou o ajuste de 07/09: mídia sem legenda chega como
 * `"[Imagem]"`. Isso tem menos de 25 caracteres, então entrava como
 * "mensagem curta" e AUTORIZAVA puxar histórico — o agente respondeu
 * perguntas de 40 minutos antes para quem estava tratando de outro assunto.
 * Placeholder de mídia e mensagem vazia são AUSÊNCIA de conteúdo: não entram
 * na query e não disparam a heurística de histórico.
 *
 * Mesma família de falha medida em 08/09, agora pelo peso do histórico:
 * "Sobre as provas? / Quando / Nao tem as datas?" recuperou os documentos de
 * prova mas NÃO o calendário, que tinha as datas. A janela de histórico ainda
 * continha "qual é meu email academico?" repetido, de 2h40 antes; repetido, o
 * assunto morto dominou o embedding e empurrou o calendário para fora do
 * topK. Daí os dois cortes abaixo: `trimToRecentSession` (silêncio longo
 * encerra o assunto) e a deduplicação (mensagem repetida não vale mais).
 */

import {
  isContentlessInbound,
  stripMediaPlaceholders,
} from "@/lib/ai-agents/media-placeholder";

/** Mensagens do cliente consideradas quando a atual é curta. */
const DEICTIC_HISTORY_DEPTH = 4;
/** Mensagens do cliente consideradas quando a atual já tem assunto. */
const DEFAULT_HISTORY_DEPTH = 2;
/** Abaixo disso a mensagem não carrega assunto sozinha. */
const SHORT_MESSAGE_CHARS = 25;
/**
 * Silêncio que encerra o assunto. Mesma ordem de grandeza do check-in de
 * inatividade da IA (`IDLE_NUDGE_MS`), mas constante própria: mudar o tempo
 * do nudge não deve mexer no que a busca enxerga.
 */
export const RETRIEVAL_SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * Mensagens que só apontam para o que já foi dito. Sem assunto próprio:
 * usadas isoladamente, a busca vetorial devolve ruído ou nada.
 */
const DEICTIC_PATTERNS = [
  /^(ok|okay|blz|beleza|certo|isso|sim|nao|não|claro|entendi|obrigad[oa]|valeu|pode ser|quero|quero sim|pode|vai|ta|tá|ta bom|tá bom)[\s!?.]*$/i,
  /^(e (ai|então|agora)|como assim|por que|pq|como|quando|onde|qual)[\s!?.]*$/i,
  /^(ja disse|já disse|nao fez|não fez|nao foi|não foi|nada|alo|alô|oi+|ola|olá)( ainda| mesmo| entao| então)?[\s!?.]*$/i,
  /^\?+$/,
];

export function isDeicticMessage(message: string): boolean {
  const t = message.trim();
  if (!t) return true;
  return DEICTIC_PATTERNS.some((p) => p.test(t));
}

/**
 * Recorta o histórico na conversa contígua mais recente: anda de trás para
 * frente e para no primeiro silêncio maior que `gapMs`. O que veio antes do
 * silêncio é assunto encerrado — continua valendo para o modelo ler, mas não
 * pode pesar na busca.
 *
 * Itens sem `at` (playground, que manda o histórico na mão) não cortam nada.
 */
export function trimToRecentSession<T extends object>(
  messages: T[],
  gapMs: number = RETRIEVAL_SESSION_GAP_MS,
): T[] {
  const sentAt = (message: T | undefined): Date | null => {
    const value = (message as { at?: Date | null } | undefined)?.at;
    return value instanceof Date ? value : null;
  };

  for (let i = messages.length - 1; i > 0; i -= 1) {
    const current = sentAt(messages[i]);
    const previous = sentAt(messages[i - 1]);
    if (!current || !previous) continue;
    if (current.getTime() - previous.getTime() > gapMs) return messages.slice(i);
  }
  return messages;
}

/** Chave de comparação: a mesma pergunta repetida não vale duas vezes. */
function dedupKey(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, " ");
}

export function needsHistoryContext(message: string): boolean {
  const t = (message ?? "").trim();
  // Sem conteúdo do cliente não há pergunta para contextualizar. Tratar
  // "[Imagem]" como continuação curta é o que arrastou histórico velho.
  if (isContentlessInbound(t)) return false;
  return t.length < SHORT_MESSAGE_CHARS || isDeicticMessage(t);
}

/**
 * Monta o texto enviado ao embedding. Ordem cronológica (histórico antes da
 * atual) porque o embedding é de sequência: o assunto vem primeiro e a
 * mensagem atual refina.
 */
export function buildRetrievalQuery(input: {
  userMessage: string;
  /// Mensagens anteriores do cliente, da mais antiga para a mais nova.
  priorUserMessages?: string[];
}): string {
  // Lote agregado pode misturar placeholder e texto ("[Imagem]\nquero
  // cancelar"): fica só o que o cliente escreveu.
  const current = stripMediaPlaceholders(input.userMessage);
  // Turno só de mídia: query vazia. A recuperação não devolve nada e o run
  // fica NO_CONTEXT — honesto. Buscar "[Imagem]" trazia chunk aleatório.
  if (!current) return "";

  const depth = needsHistoryContext(current)
    ? DEICTIC_HISTORY_DEPTH
    : DEFAULT_HISTORY_DEPTH;

  const candidates = (input.priorUserMessages ?? [])
    .map((m) => stripMediaPlaceholders(m))
    .filter((m) => m.length > 0 && !isDeicticMessage(m));

  // De trás para frente para manter a ocorrência mais recente, e só então
  // cortar em `depth`: repetição não pode consumir as vagas do histórico.
  // A mensagem atual já entra no fim da query — no inbox ela também está no
  // histórico carregado do banco, e entrava duas vezes.
  const seen = new Set<string>([dedupKey(current)]);
  const history: string[] = [];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const message = candidates[i] as string;
    const key = dedupKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    history.unshift(message);
  }

  return [...history.slice(-depth), current].filter(Boolean).join("\n");
}
