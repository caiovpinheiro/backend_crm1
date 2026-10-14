/**
 * Nome/avatar do viewer de "quem está vendo" (`/api/presence/beat` e
 * `/api/presence/heartbeat`). Cache curto por processo: evita 1 consulta por
 * batida; 5 min cobre troca de foto sem custo relevante.
 */
import { prisma } from "@/lib/prisma";

const userInfoCache = new Map<string, { name: string; avatarUrl: string | null; ts: number }>();
const USER_CACHE_TTL_MS = 5 * 60_000;
const MAX_KEYS = 10_000;

export async function getPresenceUserInfo(
  userId: string,
): Promise<{ name: string; avatarUrl: string | null }> {
  const now = Date.now();
  const cached = userInfoCache.get(userId);
  if (cached && now - cached.ts < USER_CACHE_TTL_MS) {
    return { name: cached.name, avatarUrl: cached.avatarUrl };
  }
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, avatarUrl: true },
  });
  const info = { name: u?.name ?? "Usuário", avatarUrl: u?.avatarUrl ?? null };
  if (userInfoCache.size >= MAX_KEYS) userInfoCache.clear();
  userInfoCache.set(userId, { ...info, ts: now });
  return info;
}
