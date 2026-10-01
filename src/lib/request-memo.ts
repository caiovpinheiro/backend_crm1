/**
 * Memo por requisição dos pré-checks de autorização (P-10).
 *
 * Abrir uma conversa ou listar o inbox consultava a mesma coisa várias
 * vezes em série: o contexto authz (2–3×), a flag de escopo granular (2×),
 * os grants de escopo (2×), os papéis do usuário (2×). Cada rota agora cria
 * UM memo e o passa adiante; quem precisa do dado pede pelo memo e recebe a
 * mesma promise — inclusive enquanto a primeira leitura ainda está em voo
 * (duas funções em `Promise.all` não disparam duas idas ao Redis).
 *
 * Por que explícito e não no AsyncLocalStorage: a propagação do contexto
 * aberto pelo `requireAuth` (`enterWith`) difere entre Node 22 e 24, então
 * um memo pendurado no `RequestContext` poderia não existir — ou, pior, ser
 * o de outra continuação. Um objeto criado no handler e passado por
 * parâmetro não tem como vazar entre requisições.
 *
 * Regras
 * ──────
 * - Vive só durante a requisição: nunca guardar em módulo/global. Não é
 *   cache — não tem TTL nem invalidação, e não precisa.
 * - Sem memo (`undefined`) tudo funciona como antes: cada chamada carrega.
 * - As chaves levam organização e usuário; o memo de uma requisição só vê
 *   um usuário, mas a chave não depende disso para estar certa.
 * - Rejeição não fica memorizada: a próxima chamada tenta de novo, como
 *   quando cada função carregava por conta própria.
 * - O valor é compartilhado entre os chamadores: tratar como somente
 *   leitura.
 */
export type RequestMemo = Map<string, Promise<unknown>>;

export function createRequestMemo(): RequestMemo {
  return new Map();
}

export function memoized<T>(
  memo: RequestMemo | undefined,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!memo) return load();
  const hit = memo.get(key);
  if (hit) return hit as Promise<T>;
  const pending = new Promise<T>((resolve) => resolve(load()));
  memo.set(key, pending);
  pending.catch(() => {
    if (memo.get(key) === pending) memo.delete(key);
  });
  return pending;
}
