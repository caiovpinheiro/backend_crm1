/**
 * Sweeper de mensagens outbound "stale" — comportamento de timeout→failed
 * DESATIVADO.
 *
 * Histórico: a Meta pode aceitar o envio (200 + wamid) sem nunca emitir
 * webhook de status; o sweeper marcava `sent` antigo como `failed` com
 * sendError de timeout e ligava `hasError` na conversa.
 *
 * Decisão de produto: NÃO marcar timeout como erro. A mensagem permanece
 * `sent` (1 ✓ na UI) até um webhook real (`delivered` / `read` / `failed`).
 *
 * O módulo continua existindo só pelo export estável
 * (`startStaleOutboundSweeper` ainda é chamado no boot do worker-whatsapp).
 *
 * Auto-cura removida (BD-21): `healWronglyFailedInternalMessages` rodava um
 * `updateMany` em `messages` por `sendStatus='failed' AND sendError=<texto
 * legado>` a cada boot — filtro sem índice, varrendo a tabela inteira para
 * corrigir linhas que o sweeper antigo marcou por engano. A correção já foi
 * aplicada em todos os ambientes e o sweeper que causava o problema é no-op
 * desde então; não há mais linhas novas para curar. Se algum ambiente
 * antigo ainda precisar, rode uma vez à mão:
 *
 *   UPDATE messages SET "sendStatus" = 'delivered', "sendError" = NULL
 *   WHERE "sendStatus" = 'failed'
 *     AND "messageType" IN ('whatsapp_call', 'whatsapp_call_recording', 'note', 'ai_draft')
 *     AND "sendError" LIKE 'Timeout: a Meta não confirmou entrega%';
 */

import { getLogger } from "@/lib/logger";

const log = getLogger("stale-outbound-sweeper");

/**
 * No-op: não marca mais outbound stale como `failed`.
 * Mantido o export para callers/testes existentes.
 */
export async function sweepStaleOutbound(
  _timeoutMs?: number,
): Promise<number> {
  return 0;
}

let _started = false;

export function startStaleOutboundSweeper(_intervalMs?: number) {
  if (_started) return;
  _started = true;
  // Não inicia intervalo nem toca o banco — timeout não vira failed.
  log.info(
    "Sweeper de stale-outbound desativado (mensagens `sent` sem webhook da Meta permanecem `sent`).",
  );
}

export function stopStaleOutboundSweeper() {
  _started = false;
}
