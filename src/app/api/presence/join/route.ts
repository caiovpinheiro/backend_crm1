/**
 * POST /api/presence/join — sinal IMEDIATO de "entrei / saí deste negócio".
 *
 * A batida de 1 minuto (`/api/presence/beat`) continua mantendo a presença
 * viva; este sinal só antecipa a ENTRADA e a SAÍDA, para quem está no mesmo
 * negócio ver em ~1 s (e não em até 1 min) que outra pessoa entrou ou saiu.
 *
 * Corpo: `{ entityType: "deal", entityId, action?: "leave" }` (aceita
 * `navigator.sendBeacon`, texto puro).
 * - entrada: grava o usuário na sala (Redis, sem Postgres) e avisa em tempo
 *   real quem está no negócio. Limite: 1 por usuário+negócio a cada 5 s;
 *   repetida dentro do limite só lê (`throttled: true`).
 * - `leave`: tira o usuário da sala na hora e avisa quem ficou.
 * Sempre devolve `{ viewers }` (lista atual, inclui o próprio usuário).
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { listViewers, removeViewer, touchViewer } from "@/lib/entity-presence";
import { claimPresenceJoin } from "@/lib/presence-join-limit";
import { getPresenceUserInfo } from "@/lib/presence-user-info";

export const dynamic = "force-dynamic";

const ALLOWED_ENTITIES = new Set(["deal"]);
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(req: Request) {
  return withOrgContext(async (session) => {
    const orgId = session.user.organizationId;
    if (!orgId) return NextResponse.json({ viewers: [] });

    let body: { entityType?: unknown; entityId?: unknown; action?: unknown } = {};
    try {
      body = JSON.parse(await req.text());
    } catch {
      body = {};
    }
    const entityType = String(body?.entityType ?? "");
    const entityId = String(body?.entityId ?? "");
    if (!ALLOWED_ENTITIES.has(entityType) || !ENTITY_ID_RE.test(entityId)) {
      return NextResponse.json({ viewers: [] }, { status: 400 });
    }
    const userId = session.user.id;
    const room = { orgId, entityType, entityId };

    if (body.action === "leave") {
      const viewers = await removeViewer({ ...room, userId });
      return NextResponse.json({ viewers });
    }

    if (!(await claimPresenceJoin({ userId, entityType, entityId }))) {
      const viewers = await listViewers(room);
      return NextResponse.json({ viewers, throttled: true });
    }
    const { name, avatarUrl } = await getPresenceUserInfo(userId);
    const viewers = await touchViewer({ ...room, userId, name, avatarUrl });
    return NextResponse.json({ viewers });
  });
}
