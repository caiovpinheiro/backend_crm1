/**
 * Revoga o SSE de quem perdeu o acesso (apagado ou saiu da org) — UMA
 * consulta por processo a cada 60s para todos os usuários conectados.
 *
 * Antes cada conexão tinha o próprio `setInterval` com um `findFirst`:
 * 300 abas abertas = 300 consultas por minuto só para isto.
 */

import { prismaBase } from "@/lib/prisma-base";
import { sseBus } from "@/lib/sse-bus";

const INTERVAL_MS = 60_000;

type Watched = { organizationId: string | null; isSuperAdmin: boolean; count: number };

/** Chave por usuário + org da sessão (a mesma pessoa pode ter abas de orgs distintas). */
const watched = new Map<string, Watched & { userId: string }>();
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

const keyOf = (userId: string, organizationId: string | null) =>
  `${userId}:${organizationId ?? ""}`;

/** Decide quem perdeu o acesso (puro, testável). */
export function lostSseAccess(
  entries: readonly { userId: string; organizationId: string | null; isSuperAdmin: boolean }[],
  rows: readonly { id: string; isErased: boolean; organizationId: string | null }[],
): { userId: string; organizationId: string | null }[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return entries
    .filter((e) => {
      const row = byId.get(e.userId);
      if (!row || row.isErased) return true;
      return e.organizationId != null && row.organizationId !== e.organizationId && !e.isSuperAdmin;
    })
    .map((e) => ({ userId: e.userId, organizationId: e.organizationId }));
}

async function sweep() {
  if (running || watched.size === 0) return;
  running = true;
  try {
    const entries = [...watched.values()];
    const ids = [...new Set(entries.map((e) => e.userId))];
    const rows = await prismaBase.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, isErased: true, organizationId: true },
    });
    for (const lost of lostSseAccess(entries, rows)) {
      sseBus.revokeUser(lost);
    }
  } catch {
    /* tenta de novo no próximo tick */
  } finally {
    running = false;
  }
}

/** Registra uma conexão; devolve o unregister. */
export function watchSseMembership(ctx: {
  userId: string;
  organizationId: string | null;
  isSuperAdmin: boolean;
}): () => void {
  const key = keyOf(ctx.userId, ctx.organizationId);
  const current = watched.get(key);
  if (current) current.count += 1;
  else watched.set(key, { ...ctx, count: 1 });

  if (!timer) {
    timer = setInterval(() => void sweep(), INTERVAL_MS);
    timer.unref?.();
  }

  let done = false;
  return () => {
    if (done) return;
    done = true;
    const entry = watched.get(key);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) watched.delete(key);
    if (watched.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
