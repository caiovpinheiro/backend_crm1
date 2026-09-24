/**
 * Trechos da base que o modelo leu num turno (pré-busca + buscas que ele
 * mesmo fez), a partir das chamadas de ferramenta gravadas no log.
 * É o que permite responder "de onde ele tirou isso?" — na tela de
 * conversas de teste e no diagnóstico de erro.
 * Nenhum domínio de cliente.
 */

export type V2TurnSource = { title: string; content: string; similarity: number | null };

const MAX_SOURCES = 8;
const MAX_CONTENT = 2000;

export function sourcesFromToolCalls(toolCalls: unknown): V2TurnSource[] {
  if (!Array.isArray(toolCalls)) return [];
  const seen = new Map<string, V2TurnSource>();
  for (const call of toolCalls as Array<{ toolName?: string; result?: { chunks?: unknown } }>) {
    if (call?.toolName !== "knowledge_search" || !Array.isArray(call.result?.chunks)) continue;
    for (const chunk of call.result!.chunks as Array<Record<string, unknown>>) {
      const content = typeof chunk.content === "string" ? chunk.content.trim() : "";
      if (!content) continue;
      const title = typeof chunk.docTitle === "string" ? chunk.docTitle : "";
      const key = `${title}\u0000${content}`;
      const similarity = typeof chunk.distance === "number" ? Number((1 - chunk.distance).toFixed(2)) : null;
      const prev = seen.get(key);
      if (!prev || (similarity ?? -1) > (prev.similarity ?? -1)) {
        seen.set(key, {
          title,
          content: content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT)}…` : content,
          similarity,
        });
      }
    }
  }
  return [...seen.values()].slice(0, MAX_SOURCES);
}
