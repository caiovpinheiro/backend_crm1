import { getLogger } from "@/lib/logger";

const log = getLogger("presence-reaper");

/**
 * Rebaixa automaticamente o status de agentes inativos.
 *
 * DEPRECATED (jul/26): a "presença por ping" foi separada da disponibilidade
 * da Distribuição. O sweeper que fecha sessões de USO vive agora em
 * `system-presence.ts` (`startSystemPresenceSweeper`).
 *
 * Mantido como no-op para preservar compat com quem ainda importa
 * `startPresenceReaper` / `reapOnce`. AgentStatus é manual (botão
 * Online/Offline na Distribuição) — não rebaixa por `lastActivityAt`.
 */

let started = false;

export function startPresenceReaper() {
  if (started) return;
  started = true;
  log.info("[presence-reaper] DEPRECATED — nenhum tick agendado. Use system-presence sweeper.");
}

export async function reapOnce() {
  return { awayed: 0, offlined: 0 };
}
