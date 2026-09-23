/**
 * Executa as tasks com no máximo `limit` em voo, na ordem da lista.
 * Nunca rejeita: efeito colateral que falha não pode derrubar o chunk.
 *
 * O worker-leads roda com concurrency 5 sobre um pool de 10 conexões;
 * 2-3 em voo por job deixa margem para a query principal do chunk e para
 * os outros jobs.
 */
export async function runWithConcurrency(
  tasks: (() => Promise<void>)[],
  limit: number,
): Promise<void> {
  if (tasks.length === 0) return;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        try {
          await task();
        } catch {
          // Já logado pelo próprio task; aqui é só a rede de segurança.
        }
      }
    },
  );
  await Promise.all(workers);
}
