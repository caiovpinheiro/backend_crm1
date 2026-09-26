/**
 * Materiais já enviados na conversa: mensagem pronta mandada há pouco não
 * sai de novo (a trava anti-repetição barrava o texto e o cliente ficava só
 * com o "vou te enviar"), e o #reset do teste zera a contagem.
 * Nenhum domínio de cliente.
 */

import { prismaBase } from "@/lib/prisma-base";

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
};

/** Janela em que a mesma mensagem pronta não é reenviada. */
export const RESEND_WINDOW_MS = 30 * 60 * 1000;

/** Resposta quando o material pedido acabou de ser enviado. */
export const ALREADY_SENT_REPLY =
  "Te enviei esse material logo acima 👆 Se ficou alguma dúvida ou algo não funcionou, me conta que eu te ajudo.";

/** Erro do executor quando o texto da mensagem pronta foi barrado por repetir uma recente. */
export const MESSAGE_MODEL_REPEATED = "não reenviada: igual a uma mensagem recente";

/** Último #reset da conversa (sessão de teste), ou null. */
export async function lastV2ResetAt(conversationId: string): Promise<Date | null> {
  const rows = await db.$queryRawUnsafe<Array<{ at: Date | null }>>(
    `SELECT MAX("createdAt") AS "at" FROM "ai_simple_turn_logs" WHERE "conversationId"=$1 AND "prompt"='reset'`,
    conversationId,
  );
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

/** Ids das mensagens prontas enviadas com sucesso nestes logs de turno. */
export function sentMessageModelIds(rows: Array<{ executedActions: unknown }>): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.executedActions)) continue;
    for (const res of row.executedActions as Array<Record<string, unknown>>) {
      const action = (res?.action ?? {}) as Record<string, unknown>;
      if (res?.ok === true && action.type === "send_message_model" && typeof action.modelId === "string") out.add(action.modelId);
    }
  }
  return out;
}

/** Início da janela: 30 min atrás, ou o último #reset se for mais recente. */
export function resendWindowStart(now: number, lastReset: Date | null): Date {
  const windowStart = now - RESEND_WINDOW_MS;
  return new Date(lastReset ? Math.max(windowStart, lastReset.getTime()) : windowStart);
}

/** Quais destas mensagens prontas já saíram na conversa dentro da janela. */
export async function recentlySentMessageModels(conversationId: string, modelIds: string[]): Promise<Set<string>> {
  if (modelIds.length === 0) return new Set();
  const since = resendWindowStart(Date.now(), await lastV2ResetAt(conversationId));
  const rows = await db.$queryRawUnsafe<Array<{ executedActions: unknown }>>(
    `SELECT "executedActions" FROM "ai_simple_turn_logs" WHERE "conversationId"=$1 AND "createdAt" >= $2 ORDER BY "createdAt" DESC LIMIT 50`,
    conversationId, since,
  );
  const sent = sentMessageModelIds(rows);
  return new Set(modelIds.filter((id) => sent.has(id)));
}
