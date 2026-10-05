/**
 * Cache curto NA MEMÓRIA DO PROCESSO para tabelas pequenas de configuração
 * (widgets da org, funis, dados da organização), com invalidação por versão
 * (`versions.ts`) para valer entre as réplicas.
 *
 * Por que não o `cache.wrap` (Redis): essas leituras são de 1 a 30 linhas e
 * acontecem em quase toda requisição / todo job. Guardar o valor no Redis
 * troca uma ida ao Postgres por uma ida ao Redis com JSON; aqui o valor fica
 * no processo e a única ida à rede é a leitura da VERSÃO, que o
 * `versions.ts` já memoriza por `CACHE_VERSION_MEMO_MS` (500 ms) por nome.
 *
 * Regras de uso
 * ─────────────
 * - Só dado da ORGANIZAÇÃO (o `scope` leva o id dela). Nada por usuário em
 *   chave compartilhada; se o dado for por usuário, o id dele entra no
 *   `key`.
 * - Não é lugar de decisão de autorização. TTL máximo de 60 s
 *   (`MAX_TTL_MS`): quem depende de "organização suspensa" ou de um gate
 *   desligado volta a ler o banco em no máximo isso, mesmo se o `bump` se
 *   perder.
 * - Quem ESCREVE a entidade chama `invalidateLocalVersioned` DEPOIS da
 *   escrita concluída (fora da transação): um `bump` antes do commit
 *   deixaria outra requisição recarregar o valor antigo.
 * - O valor é compartilhado entre os chamadores: tratar como somente
 *   leitura (devolva cópia se o chamador for mutar).
 *
 * Atraso máximo até uma edição aparecer
 * ─────────────────────────────────────
 * - No processo que editou: nenhum (o `bump` atualiza a versão local).
 * - Nas outras réplicas / workers: `CACHE_VERSION_MEMO_MS` (500 ms).
 * - Redis fora ou `bump` perdido (escrita direto no banco): o TTL.
 */
import { bumpCacheVersion, cacheVersionName, getCacheVersion } from "./versions";

/** Teto do TTL — ver "Regras de uso". */
export const MAX_TTL_MS = 60_000;
/** Teto de entradas por processo (evicção da mais antiga inserida). */
const MAX_ENTRIES = 5_000;

type Entry = { version: string; expiresAt: number; value: unknown };

const entries = new Map<string, Entry>();
const loading = new Map<string, Promise<unknown>>();

export interface LocalVersionedOptions {
  /** Família da versão (`org_widgets`, `pipelines_meta`, …). */
  family: string;
  /** Escopo da versão — normalmente `[organizationId]`. */
  scope: string[];
  /** Diferencia valores dentro do mesmo escopo (opcional). */
  key?: string;
  /** Tempo de vida no processo. Limitado a `MAX_TTL_MS`. */
  ttlMs: number;
}

function store(id: string, entry: Entry): void {
  if (!entries.has(id) && entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(id, entry);
}

/**
 * Devolve o valor em memória se ele é da versão atual e não venceu; senão
 * chama `load` (uma vez por chave, mesmo com chamadas simultâneas).
 * Rejeição do `load` não fica guardada.
 */
export async function localVersioned<T>(
  options: LocalVersionedOptions,
  load: () => Promise<T>,
): Promise<T> {
  const name = cacheVersionName(options.family, ...options.scope);
  const version = await getCacheVersion(name);
  const id = `${name}|${options.key ?? ""}`;

  const hit = entries.get(id);
  if (hit && hit.version === version && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }

  const flight = `${id}|${version}`;
  const pending = loading.get(flight);
  if (pending) return pending as Promise<T>;

  const ttlMs = Math.max(0, Math.min(options.ttlMs, MAX_TTL_MS));
  const run = (async () => {
    const value = await load();
    // Uma edição que terminou durante a leitura já trocou a versão: o que
    // foi lido pode ser o estado anterior — devolve, mas não guarda.
    if ((await getCacheVersion(name)) === version) {
      store(id, { version, expiresAt: Date.now() + ttlMs, value });
    }
    return value;
  })().finally(() => {
    if (loading.get(flight) === run) loading.delete(flight);
  });
  loading.set(flight, run);
  return run;
}

/**
 * Invalida a família no escopo: `INCR` da versão (vale nas outras réplicas
 * em até `CACHE_VERSION_MEMO_MS`). Nunca lança.
 */
export async function invalidateLocalVersioned(
  family: string,
  ...scope: string[]
): Promise<void> {
  await bumpCacheVersion(cacheVersionName(family, ...scope));
}

/** Só para testes: esvazia a memória do processo. */
export function resetLocalVersionedForTests(): void {
  entries.clear();
  loading.clear();
}
