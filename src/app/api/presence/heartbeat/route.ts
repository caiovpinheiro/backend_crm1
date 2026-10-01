import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { removeViewer, touchViewer } from "@/lib/entity-presence";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Entidades que suportam presença "quem está vendo". Allowlist evita salas
 *  arbitrárias criadas por payload malicioso. */
const ALLOWED_ENTITIES = new Set(["deal"]);

/** Cache curto de nome/avatar por usuário — evita 1 query a cada heartbeat
 *  (25s, enviado só pela aba líder do navegador; TTL do viewer 90s em
 *  `entity-presence.ts`). TTL de 5 min cobre trocas de foto sem custo
 *  relevante. */
const userInfoCache = new Map<
  string,
  { name: string; avatarUrl: string | null; ts: number }
>();
const USER_CACHE_TTL_MS = 5 * 60_000;

async function getUserInfo(userId: string): Promise<{ name: string; avatarUrl: string | null }> {
  const cached = userInfoCache.get(userId);
  if (cached && Date.now() - cached.ts < USER_CACHE_TTL_MS) {
    return { name: cached.name, avatarUrl: cached.avatarUrl };
  }
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, avatarUrl: true },
  });
  const info = { name: u?.name ?? "Usuário", avatarUrl: u?.avatarUrl ?? null };
  userInfoCache.set(userId, { ...info, ts: Date.now() });
  return info;
}

/**
 * Heartbeat de presença por entidade. Corpo: `{ entityType, entityId,
 * action? }`. `action: "leave"` (enviado por `navigator.sendBeacon` no
 * unmount / aba fechada) remove o viewer imediatamente; qualquer outro valor
 * registra/renova. Sempre devolve a lista atual de viewers da entidade.
 */
export async function POST(req: Request) {
  return withOrgContext(async (session) => {
    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json({ viewers: [] });
    }

    let body: { entityType?: unknown; entityId?: unknown; action?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      // sendBeacon pode mandar texto puro; tenta parsear manualmente.
      try {
        body = JSON.parse(await req.text());
      } catch {
        body = {};
      }
    }

    const entityType = String(body.entityType ?? "");
    const entityId = String(body.entityId ?? "");
    if (!ALLOWED_ENTITIES.has(entityType) || !entityId) {
      return NextResponse.json({ viewers: [] }, { status: 400 });
    }

    const userId = session.user.id;

    if (body.action === "leave") {
      const viewers = removeViewer({ orgId, entityType, entityId, userId });
      return NextResponse.json({ viewers });
    }

    const { name, avatarUrl } = await getUserInfo(userId);
    const viewers = touchViewer({ orgId, entityType, entityId, userId, name, avatarUrl });
    return NextResponse.json({ viewers });
  });
}
