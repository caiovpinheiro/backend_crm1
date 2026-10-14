/**
 * GET /api/me/live
 * ────────────────
 * Os campos VOLÁTEIS do shell, que saíram do bootstrap v2
 * (`GET /api/me/bootstrap` com `x-bootstrap-version: 2`), com o MESMO
 * formato que tinham no bootstrap v1:
 *
 *   agentStatus    = corpo de `GET /api/agents/:me/status` (fallback OFFLINE)
 *   emailUnread    = `{ totalUnread, accounts: [{ id, email, unreadCount }] }`
 *                    (`null` sem permissão de e-mail)
 *   teamChatRooms  = resumo das salas (`null` sem `team_chat:view` / sem org)
 *   usersPresence  = `{ [userId]: { systemOnline, lastSeenAt, agentStatus } }`
 *                    — o que saiu de `GET /api/users` com
 *                    `x-bootstrap-version: 2` (`null` sem org)
 *   departmentCounts = `{ [departmentId]: { openConversations } }` — o
 *                    `_count.conversations` que saiu de
 *                    `GET /api/settings/departments` v2 (`null` fora de
 *                    ADMIN/MANAGER; ausente = 0)
 *   failedBlocks   = campos que vieram `null` por erro
 *   blocks         = `{ [url]: <corpo idêntico ao de GET url> }` para
 *                    `/api/team-chat/rooms` (mesma consulta do resumo) e
 *                    `/api/agents/<me>/status`; URL ausente = sem permissão
 *   blockErrors    = URLs cujo bloco falhou
 *
 * `Cache-Control: no-store` — muda a todo momento; não há ETag. Custo: as
 * consultas que o bootstrap v1 fazia para os 3 primeiros campos (status do
 * agente, contas de e-mail com não lidos, salas do team-chat) + presença e
 * contagens da org, estas em cache por org no Redis (presença 30 s e
 * versionada por `rc_agent_status`; contagens versionadas por
 * `inbox_tab_counts`) — em regime, 0 consultas para elas. Contrato e merge
 * no frontend em `services/me-live.ts`; regras por campo em
 * `services/me-bootstrap.ts` (`buildMeLive`).
 *
 * Permissão: sessão autenticada; cada campo aplica a checagem da rota que
 * espelha e vem `null` quando negado.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { ServerTiming } from "@/lib/server-timing";
import { TEAM_CHAT_ROOMS_URL, teamChatRoomsBlock } from "@/services/bootstrap-blocks";
import { buildMeLive } from "@/services/me-bootstrap";

const log = getLogger("api/me/live");

export const dynamic = "force-dynamic";

export async function GET() {
  const timing = new ServerTiming();
  return withOrgContext(async (session) => {
    timing.add("auth", timing.totalMs());
    try {
      const user = session.user;
      let fullRooms: unknown[] | null = null;
      const live = await timing.time("query", () =>
        buildMeLive(user, {
          onTeamChatRooms: (rooms) => {
            fullRooms = rooms;
          },
        }),
      );

      const blocks: Record<string, string> = {};
      const blockErrors: string[] = [];
      if (fullRooms !== null && user.organizationId) {
        blocks[TEAM_CHAT_ROOMS_URL] = teamChatRoomsBlock(user.organizationId, fullRooms).body;
      } else if (live.failedBlocks.includes("teamChatRooms")) {
        blockErrors.push(TEAM_CHAT_ROOMS_URL);
      }
      const statusUrl = `/api/agents/${user.id}/status`;
      if (live.agentStatus) blocks[statusUrl] = JSON.stringify(live.agentStatus);
      else if (live.failedBlocks.includes("agentStatus")) blockErrors.push(statusUrl);

      const body = timing.timeSync("serialize", () => {
        const base = JSON.stringify(live);
        const entries = Object.entries(blocks)
          .map(([url, json]) => `${JSON.stringify(url)}:${json}`)
          .join(",");
        return `${base.slice(0, -1)},"blocks":{${entries}},"blockErrors":${JSON.stringify(blockErrors)}}`;
      });
      return new NextResponse(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Server-Timing": timing.header(),
        },
      });
    } catch (e) {
      log.error({ err: e }, "[GET /api/me/live] falhou");
      return NextResponse.json({ message: "Erro ao carregar os dados ao vivo." }, { status: 500 });
    }
  });
}
