/**
 * Marca de "instante relativo ao agora" em `Date` de filtro Prisma.
 *
 * Alguns escopos embutem um corte calculado a partir do relógio (fila
 * Automação: agora − 15 s; janela de 24 h da Meta: agora − 24 h). O valor
 * muda a cada chamada, mas o SIGNIFICADO do filtro não. Para a chave de cache
 * (ex.: contadores do Inbox) o que importa é o significado: a chave usa o
 * rótulo da marca e o instante exato fica só na consulta — portanto no valor
 * calculado, cuja validade é o TTL/SWR do cache.
 *
 * A marca é uma propriedade não enumerável com símbolo: o Prisma e o
 * `JSON.stringify` não a enxergam; quem quiser lê com `nowRelativeLabel`.
 * Módulo sem dependências de propósito (é importado por `visibility.ts` e
 * `meta-session-window.ts`).
 */

const NOW_RELATIVE = Symbol.for("crm.cache.nowRelative");

/** Marca `date` como corte relativo ao agora, identificado por `label`. */
export function markNowRelative(date: Date, label: string): Date {
  Object.defineProperty(date, NOW_RELATIVE, {
    value: label,
    enumerable: false,
    configurable: true,
  });
  return date;
}

/** Rótulo da marca, ou `null` se o `Date` é um instante absoluto. */
export function nowRelativeLabel(value: unknown): string | null {
  if (!(value instanceof Date)) return null;
  const label = (value as unknown as Record<symbol, unknown>)[NOW_RELATIVE];
  return typeof label === "string" ? label : null;
}
