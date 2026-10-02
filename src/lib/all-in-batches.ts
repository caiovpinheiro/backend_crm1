/**
 * Executa tarefas assíncronas em lotes de no máximo `size` simultâneas,
 * preservando a ordem e os tipos da tupla (como `Promise.all`).
 *
 * Motivo: o dashboard disparava ~25 consultas num único `Promise.all` com
 * pool de 20 conexões; dois dashboards abertos esgotavam o pool e travavam o
 * inbox. Lotes pequenos mantêm o pool livre para o resto da API.
 *
 * Cada item é uma função (thunk) — a consulta só começa quando o lote chega.
 */
export async function allInBatches<
  T extends readonly (() => PromiseLike<unknown>)[],
>(
  tasks: readonly [...T],
  size = 4,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const limit = Math.max(1, Math.floor(size));
  const results: unknown[] = new Array(tasks.length);
  for (let i = 0; i < tasks.length; i += limit) {
    const slice = tasks.slice(i, i + limit);
    const out = await Promise.all(slice.map((task) => task()));
    for (let j = 0; j < out.length; j++) results[i + j] = out[j];
  }
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
