/**
 * Debounce de mensagens inbound para o Agente IA — CAMINHO LEGADO.
 *
 * APOSENTADO pelo `turn-manager.ts` (Fase 1 do runtime de IA). Com
 * `AI_TURN_MANAGER=1` os 3 ingests chamam `onInboundMessageForAi` e
 * `scheduleAiReply` não é mais alcançado; com a flag desligada (default)
 * este arquivo continua sendo o caminho de produção. NÃO existem dois
 * debounces ativos ao mesmo tempo — o entrypoint novo é quem decide, e é
 * ele que delega para cá no modo legado.
 *
 * Continuam vivos e compartilhados pelos dois modos:
 *   - `claimInboundMessageForAi` (claim Redis por messageId)
 *   - `collectUnansweredInboundText` (batch de inbound sem resposta)
 *   - `cancelAiReplyDebounce` (agora também invalida turnos)
 *

 * Agrupa mensagens consecutivas do cliente (timer renovável) e garante
 * que só a última geração válida dispare `maybeReplyAsAIAgent`.
 *
 * Sem migration: estado em Redis (via `cache`) + Map in-memory para timers
 * no processo. Multi-réplica: generationId + claim por messageId.
 */

import { cache } from "@/lib/cache";
import {
  getOrgIdOrNull,
  getRequestContext,
  runWithContext,
} from "@/lib/request-context";
import { getOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";

/** Teto temporal do lote de mensagens não respondidas, em minutos. */
const DEFAULT_INBOUND_BATCH_WINDOW_MINUTES = 15;
import { isContactAllowedForAi } from "@/services/ai/phone-allowlist";
import { getLogger } from "@/lib/logger";

const log = getLogger("ai.inbound-debounce");

/** 2500ms cortava quem digita no celular: uma pausa de 3s no meio da */
/** frase e o agente respondia a pergunta pela metade. */
export const DEFAULT_AI_DEBOUNCE_MS = 5000;
const MSG_CLAIM_TTL_SEC = 600;
const GEN_TTL_SEC = 120;

type PendingSlot = {
  generationId: string;
  timer: ReturnType<typeof setTimeout> | null;
  orgId: string | null;
  userId: string;
  contactId: string;
  channel: "meta" | "baileys" | "messaging";
  messageIds: string[];
};

const pendingByConversation = new Map<string, PendingSlot>();

export type ScheduleAiReplyInput = {
  conversationId: string;
  contactId: string;
  /** ID da Message persistida (claim anti-duplicata). */
  messageId?: string | null;
  /** Texto da mensagem atual (fallback se batch vazio). */
  userMessage: string;
  channel: "meta" | "baileys" | "messaging";
  /** Quando false, não agenda (ex.: mensagem de sistema). */
  eligible?: boolean;
};

function logAi(event: string, payload: Record<string, unknown>) {
  log.info({ event, ...payload }, `[ai-attend] ${event}`);
}

async function resolveDebounceMs(): Promise<number> {
  try {
    const raw = await getOrgSetting("ai.inboundDebounceMs");
    if (raw) {
      const n = Number.parseInt(raw, 10);
      // Piso 1500ms: debounce 0 gera 1 resposta por bolha (triplica "vou te conectar").
      if (Number.isFinite(n) && n >= 0 && n <= 30_000) {
        return Math.max(1500, n);
      }
    }
  } catch {
    /* fora de RequestContext */
  }
  return DEFAULT_AI_DEBOUNCE_MS;
}

/**
 * Claim de mensagem inbound (webhook repetido / multi-pod).
 * Sem messageId, sempre permite (texto-only paths).
 */
export async function claimInboundMessageForAi(
  messageId: string | null | undefined,
): Promise<boolean> {
  if (!messageId) return true;
  const ok = await cache.tryClaim(`ai:msg-claim:${messageId}`, MSG_CLAIM_TTL_SEC);
  if (!ok) {
    logAi("msg_claim_blocked", { messageId });
  }
  return ok;
}

/**
 * Cancela debounce pendente (humano assumiu / enviou mensagem).
 * Sempre invalida generationId no cache (multi-réplica / pós-flush).
 *
 * Ponto ÚNICO de cancelamento: além do timer local e do generationId,
 * invalida os `ConversationTurn` acumulando da conversa. Todos os call
 * sites atuais (POST /messages, actions/assignee, halt-inbound-burst,
 * moveConversationAssignee) ficam cobertos sem mudar nenhum deles.
 */
export function cancelAiReplyDebounce(
  conversationId: string,
  reason: string,
): void {
  const slot = pendingByConversation.get(conversationId);
  if (slot?.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  if (slot) {
    pendingByConversation.delete(conversationId);
  }
  void cache.del(`ai:gen:${conversationId}`);
  // Import dinâmico: turn-manager importa este módulo (claim + coletor de
  // texto), então o estático fecharia ciclo.
  void import("@/services/ai/turn-manager")
    .then(({ invalidateOpenTurns }) =>
      invalidateOpenTurns(conversationId, reason),
    )
    .catch((err) => {
      log.error(
        { conversationId, reason, err: err instanceof Error ? err.message : String(err) },
        "[ai-attend] invalidateOpenTurns falhou",
      );
    });
  logAi("debounce_cancelled", { conversationId, reason, hadPending: Boolean(slot) });
}

/**
 * Depois de atribuir a conversa a um agente de IA pela caixa de entrada:
 * se há mensagem do cliente sem resposta, abre o turno com ela.
 */
export function kickAiAfterInboxAssign(args: {
  conversationId: string;
  contactId: string;
}): void {
  // Captura o ALS agora: o assign HTTP já pode ter encerrado quando o
  // primeiro `await` abaixo roda, e o prisma scoped explode sem org.
  const ctx = getRequestContext();
  void (async () => {
    const run = async () => {
      try {
        const text = await collectUnansweredInboundText(args.conversationId);
        if (text.trim()) {
          // Passa pelo entrypoint compartilhado: com AI_TURN_MANAGER=1 isso
          // abre um turno em vez de armar o timer local. Sem isso, o assign
          // ao agente IA seria um SEGUNDO debounce rodando em paralelo com
          // o Turn Manager.
          const { onInboundMessageForAi } = await import(
            "@/services/ai/turn-manager"
          );
          await onInboundMessageForAi({
            conversationId: args.conversationId,
            contactId: args.contactId,
            userMessage: text,
            channel: "meta",
          });
          return;
        }
        // Sem mensagem pendente: o agente fala na próxima mensagem do cliente.
      } catch (e) {
        log.error({ err: e }, "[ai-attend] kickAiAfterInboxAssign failed");
      }
    };
    if (ctx) {
      await runWithContext(ctx, run);
      return;
    }
    await run();
  })();
}

async function resolveInboundBatchWindowMinutes(_conversationId: string): Promise<number> {
  return DEFAULT_INBOUND_BATCH_WINDOW_MINUTES;
}

/**
 * Concatena mensagens inbound do cliente desde a última outbound
 * (humano/bot), em ordem cronológica.
 *
 * Tem TETO TEMPORAL. Sem ele um "oi" às 16:43 arrastava mensagens de 16:13
 * para o mesmo turno: o agente respondia perguntas velhas e um lote antigo
 * casava com palavra-chave, disparando transferência indevida. A janela é
 * ancorada na mensagem mais NOVA do lote (não em `now`), porque o worker
 * pode processar o turno minutos depois de o cliente escrever.
 */
export async function collectUnansweredInboundText(
  conversationId: string,
  opts?: { windowMinutes?: number },
): Promise<string> {
  const windowMinutes =
    opts?.windowMinutes ??
    (await resolveInboundBatchWindowMinutes(conversationId));

  const lastOut = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: "out",
      isPrivate: false,
      messageType: { not: "note" },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  const inbound = await prisma.message.findMany({
    where: {
      conversationId,
      direction: "in",
      ...(lastOut ? { createdAt: { gt: lastOut.createdAt } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: 30,
    select: {
      content: true,
      authorType: true,
      messageType: true,
      createdAt: true,
    },
  });

  const fromClient = inbound.filter(
    (m) =>
      m.authorType !== "bot" &&
      m.authorType !== "system" &&
      m.messageType !== "note" &&
      (m.content ?? "").trim().length > 0,
  );

  const newest = fromClient[fromClient.length - 1]?.createdAt;
  const cutoff =
    windowMinutes > 0 && newest
      ? newest.getTime() - windowMinutes * 60_000
      : null;

  const parts: string[] = [];
  for (const m of fromClient) {
    if (cutoff !== null && m.createdAt.getTime() < cutoff) continue;
    parts.push((m.content ?? "").trim());
  }
  return parts.join("\n");
}
