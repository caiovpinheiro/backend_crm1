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
import { isContactAllowedForAi } from "@/services/ai/phone-allowlist";

export const DEFAULT_AI_DEBOUNCE_MS = 2500;
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
  console.info(
    "[ai-attend]",
    JSON.stringify({ event, ts: new Date().toISOString(), ...payload }),
  );
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
 * moveConversationAssignee, farewell do inbox-handler, `ai_only_close`
 * do vertical academic) ficam cobertos sem mudar nenhum deles.
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
      console.error("[ai-attend] invalidateOpenTurns falhou", {
        conversationId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  logAi("debounce_cancelled", { conversationId, reason, hadPending: Boolean(slot) });
}

/**
 * Agenda resposta do agente com debounce renovável.
 */
export async function scheduleAiReply(
  input: ScheduleAiReplyInput,
): Promise<void> {
  if (input.eligible === false) return;
  if (!input.userMessage?.trim() && !input.messageId) return;

  // Allowlist (default aberto em produção). Se restricted, bloqueia.
  try {
    const allowed = await isContactAllowedForAi(input.contactId);
    if (!allowed) {
      logAi("debounce_skip_allowlist", {
        conversationId: input.conversationId,
        contactId: input.contactId,
      });
      return;
    }
  } catch (e) {
    console.error("[ai] phone allowlist check failed — blocking reply", e);
    return;
  }

  const claimed = await claimInboundMessageForAi(input.messageId);
  if (!claimed) return;

  const orgId = getOrgIdOrNull();
  const ctx = (await import("@/lib/request-context")).getRequestContext();
  const userId = ctx?.userId ?? "system";

  const generationId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await cache.set(`ai:gen:${input.conversationId}`, generationId, GEN_TTL_SEC);

  let slot = pendingByConversation.get(input.conversationId);
  if (slot?.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }

  const messageIds = [
    ...(slot?.messageIds ?? []),
    ...(input.messageId ? [input.messageId] : []),
  ];

  slot = {
    generationId,
    timer: null,
    orgId,
    userId,
    contactId: input.contactId,
    channel: input.channel,
    messageIds,
  };
  pendingByConversation.set(input.conversationId, slot);

  const delayMs = await resolveDebounceMs();
  logAi("debounce_scheduled", {
    conversationId: input.conversationId,
    contactId: input.contactId,
    channel: input.channel,
    generationId,
    delayMs,
    pendingMessages: messageIds.length,
  });

  if (delayMs === 0) {
    await flushDebounce(input.conversationId, generationId);
    return;
  }

  slot.timer = setTimeout(() => {
    void flushDebounce(input.conversationId, generationId);
  }, delayMs);

  if (typeof slot.timer === "object" && slot.timer && "unref" in slot.timer) {
    try {
      slot.timer.unref();
    } catch {
      /* ignore */
    }
  }
}

async function flushDebounce(
  conversationId: string,
  generationId: string,
): Promise<void> {
  const slot = pendingByConversation.get(conversationId);
  if (!slot || slot.generationId !== generationId) {
    logAi("debounce_stale", { conversationId, generationId });
    return;
  }
  pendingByConversation.delete(conversationId);

  const currentGen = await cache.get<string>(`ai:gen:${conversationId}`);
  if (currentGen && currentGen !== generationId) {
    logAi("debounce_superseded", {
      conversationId,
      generationId,
      currentGen,
    });
    return;
  }

  const run = async () => {
    const started = Date.now();
    const batchText = await collectUnansweredInboundText(conversationId);
    if (!batchText.trim()) {
      logAi("debounce_empty_batch", { conversationId, generationId });
      return;
    }

    const channel =
      slot.channel === "messaging" ? "meta" : slot.channel;

    const { maybeReplyAsAIAgent } = await import("@/services/ai/inbox-handler");
    await maybeReplyAsAIAgent({
      conversationId,
      contactId: slot.contactId,
      userMessage: batchText,
      channel,
      generationId,
      inboundMessageIds: slot.messageIds,
    });

    logAi("debounce_flushed", {
      conversationId,
      generationId,
      channel: slot.channel,
      durationMs: Date.now() - started,
      messageCount: slot.messageIds.length,
    });
  };

  try {
    if (slot.orgId) {
      await runWithContext(
        {
          organizationId: slot.orgId,
          userId: slot.userId,
          isSuperAdmin: false,
          actor: {
            type: "AI",
            label: "Agente IA",
            sublabel: "inbound-debounce",
          },
        },
        run,
      );
    } else {
      await run();
    }
  } catch (err) {
    console.error("[ai-attend] flushDebounce failed", {
      conversationId,
      generationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Depois de atribuir/transferir no inbox para um User type=AI: responde
 * inbound sem resposta, ou manda a saudação se o aluno ainda não falou.
 * Fire-and-forget — o HTTP do assign não espera o LLM.
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
        const conv = await prisma.conversation.findUnique({
          where: { id: args.conversationId },
          select: { assignedToId: true },
        });
        if (!conv?.assignedToId) return;
        const { triggerAgentOpeningForContact } = await import(
          "@/services/ai/piloting-actions"
        );
        await triggerAgentOpeningForContact({
          contactId: args.contactId,
          agentUserId: conv.assignedToId,
          channel: "meta",
        });
      } catch (e) {
        console.error("[ai-attend] kickAiAfterInboxAssign failed", e);
      }
    };
    if (ctx) {
      await runWithContext(ctx, run);
      return;
    }
    await run();
  })();
}

/**
 * Concatena mensagens inbound do cliente desde a última outbound
 * (humano/bot), em ordem cronológica.
 */
export async function collectUnansweredInboundText(
  conversationId: string,
): Promise<string> {
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
    },
  });

  const parts: string[] = [];
  for (const m of inbound) {
    if (m.authorType === "bot" || m.authorType === "system") continue;
    if (m.messageType === "note") continue;
    const t = (m.content ?? "").trim();
    if (t) parts.push(t);
  }
  return parts.join("\n");
}
