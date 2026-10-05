/**
 * Busca de produtos sem acento (`GET /api/products?search=`).
 *
 * As expressões SQL daqui são IDÊNTICAS às dos índices GIN trigram da
 * migration `20261005200000_products_search_fold_trgm` (`public.crm_fold`:
 * lower + troca de acentos, IMMUTABLE). Nada de parâmetro dentro da
 * expressão: com as constantes de acento como `$n` o Postgres não casa com
 * índice de expressão. Mudou aqui → mude a migration
 * (`src/app/api/products/route.test.ts` compara as duas).
 */
export const PRODUCT_NAME_FOLD_SQL = "public.crm_fold(p.name)";
export const PRODUCT_SKU_FOLD_SQL = "public.crm_fold(p.sku)";

/**
 * Termo mais curto que isso não filtra (lista normal): trigrama precisa de
 * 3 letras, e com 1 letra o LIKE '%a%' varria a tabela inteira.
 */
export const PRODUCT_SEARCH_MIN_CHARS = 2;

/** Termo como o banco compara: sem acento, minúsculo, sem curingas do LIKE. */
export function foldProductSearch(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[%_\\]/g, "");
}
