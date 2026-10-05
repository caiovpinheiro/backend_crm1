/**
 * Janela de `occurredAt` para consultas em `activity_events`.
 *
 * A tabela é particionada por MÊS em `occurredAt` (migration
 * 20260606170000) e as partições de 2025_01 a 2028_12 já existem. Consulta
 * sem filtro nessa coluna abre o índice de TODAS as partições — em
 * produção (05/10) cada partição vazia tinha ~25,9 mil leituras de índice
 * em 6 dias. Com a janela, o Postgres descarta as partições fora dela
 * (inclusive em plano genérico: a poda acontece na execução).
 *
 * - `lte`: agora + 1 dia. Evento não nasce no futuro; a folga cobre relógio
 *   adiantado. Sozinho, já descarta todos os meses futuros.
 * - `gte` (opcional): `notBefore` − 1 dia, quando quem chama sabe que
 *   nenhum evento procurado pode ser anterior (ex.: a criação da conversa,
 *   ou da linha da outbox que origina o evento).
 */
const DAY_MS = 86_400_000;

export function occurredAtWindow(notBefore?: Date | null): { gte?: Date; lte: Date } {
  const lte = new Date(Date.now() + DAY_MS);
  if (!notBefore || Number.isNaN(notBefore.getTime())) return { lte };
  return { gte: new Date(notBefore.getTime() - DAY_MS), lte };
}
