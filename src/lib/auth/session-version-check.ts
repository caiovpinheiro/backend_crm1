/**
 * Versão da sessão (SV-1) — leitura com banco. Usado pelo `requireAuth`
 * (defesa em profundidade: o callback `jwt` já derruba o token no mesmo
 * processo; aqui cobre o caso de cache frio neste processo).
 *
 * Caminho quente: cache de `session-version.ts`, primado pelo refresh do
 * JWT na mesma chamada de `auth()` — sem query. Cache frio: uma consulta
 * mínima (`select sessionVersion`). Linha ausente ou erro no banco →
 * `null` ("sem veredito", fail-open; ver `sessionVersionMatches`).
 *
 * SV-2 (renovação da sessão atual): a claim de um token pode estar À
 * FRENTE do cache deste processo — outra réplica incrementou a versão e
 * renovou a sessão que fez o pedido, e o cache daqui ainda não expirou.
 * Claim só sobe depois de conferida no banco (`session-renewal.ts`), então
 * "claim > cache" quer dizer cache velho: relê o banco antes de decidir.
 */
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";

import {
  getCachedSessionVersion,
  sessionVersionFromClaim,
  sessionVersionMatches,
  setCachedSessionVersion,
} from "./session-version";

const log = getLogger("auth");

export async function loadSessionVersion(
  userId: string,
  opts: { fresh?: boolean } = {},
): Promise<number | null> {
  if (!opts.fresh) {
    const cached = getCachedSessionVersion(userId);
    if (cached !== null) return cached;
  }
  try {
    const row = await prismaBase.user.findUnique({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    if (!row) return null;
    const version = sessionVersionFromClaim(row.sessionVersion);
    setCachedSessionVersion(userId, version);
    return version;
  } catch (err) {
    log.warn({ err, userId }, "[auth] leitura de sessionVersion falhou — sem veredito");
    return null;
  }
}

/** `true` quando a claim bate com o banco (ou não há veredito). */
export async function isSessionVersionCurrent(
  userId: string,
  tokenVersion: number,
): Promise<boolean> {
  return sessionVersionMatches(
    tokenVersion,
    await resolveKnownSessionVersion(userId, tokenVersion, await loadSessionVersion(userId)),
  );
}

/**
 * Versão a comparar com a claim. Quando a claim está à frente de `known`
 * (cache velho — ver SV-2 no topo), devolve a leitura direta do banco.
 */
export async function resolveKnownSessionVersion(
  userId: string,
  tokenVersion: number,
  known: number | null,
): Promise<number | null> {
  if (known === null || tokenVersion <= known) return known;
  return loadSessionVersion(userId, { fresh: true });
}
