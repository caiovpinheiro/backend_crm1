/**
 * Versão da sessão (SV-1) — leitura com banco. Usado pelo `requireAuth`
 * (defesa em profundidade: o callback `jwt` já derruba o token no mesmo
 * processo; aqui cobre o caso de cache frio neste processo).
 *
 * Caminho quente: cache de `session-version.ts`, primado pelo refresh do
 * JWT na mesma chamada de `auth()` — sem query. Cache frio: uma consulta
 * mínima (`select sessionVersion`). Linha ausente ou erro no banco →
 * `null` ("sem veredito", fail-open; ver `sessionVersionMatches`).
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

export async function loadSessionVersion(userId: string): Promise<number | null> {
  const cached = getCachedSessionVersion(userId);
  if (cached !== null) return cached;
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
  const known = await loadSessionVersion(userId);
  return sessionVersionMatches(tokenVersion, known);
}
