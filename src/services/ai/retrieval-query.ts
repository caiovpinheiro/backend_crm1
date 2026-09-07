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
 */

/** Mensagens do cliente consideradas quando a atual é curta. */
const DEICTIC_HISTORY_DEPTH = 4;
/** Mensagens do cliente consideradas quando a atual já tem assunto. */
const DEFAULT_HISTORY_DEPTH = 2;
/** Abaixo disso a mensagem não carrega assunto sozinha. */
const SHORT_MESSAGE_CHARS = 25;

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

export function needsHistoryContext(message: string): boolean {
  const t = message.trim();
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
  const current = (input.userMessage ?? "").trim();
  const depth = needsHistoryContext(current)
    ? DEICTIC_HISTORY_DEPTH
    : DEFAULT_HISTORY_DEPTH;

  const history = (input.priorUserMessages ?? [])
    .map((m) => (m ?? "").trim())
    .filter((m) => m.length > 0 && !isDeicticMessage(m))
    .slice(-depth);

  return [...history, current].filter(Boolean).join("\n");
}
