/**
 * Header do frontend novo: `x-bootstrap-version: 2`.
 *
 * Com ele, `GET /api/me/bootstrap` devolve só o payload estável e as rotas
 * globais que têm dados voláteis devolvem a variante ESTÁVEL (sem presença,
 * status de agente e contagens), que só muda por escrita:
 *
 * - `GET /api/users`: sem `agentStatus`, `systemOnline`, `lastSeenAt`;
 * - `GET /api/settings/departments` (ADMIN/MANAGER): sem
 *   `_count.conversations`.
 *
 * Os voláteis vêm de `GET /api/me/live` (`usersPresence`,
 * `departmentCounts`). Sem o header, tudo como antes (frontend da main).
 */
export const BOOTSTRAP_VERSION_HEADER = "x-bootstrap-version";

export function isBootstrapV2(request: Request): boolean {
  return request.headers.get(BOOTSTRAP_VERSION_HEADER)?.trim() === "2";
}
