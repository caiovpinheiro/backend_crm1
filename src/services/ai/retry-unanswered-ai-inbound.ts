/**
 * Rede de segurança da RESPOSTA da IA.
 *
 * O debounce de inbound guarda o timer em memória (`setTimeout` de ~2,5s em
 * `inbound-debounce.ts`). Se o processo reinicia dentro dessa janela — e
 * deploy é frequente — a resposta pendente morre com o container e ninguém
 * reprocessa: a conversa fica na aba do Agente IA com a última mensagem do
 * aluno, para sempre. Mesmo efeito quando o flush estoura exceção antes de
 * chegar ao envio.
 *
 * Aqui varremos exatamente esse estado (última mensagem é do aluno, a IA é a
 * responsável, ninguém respondeu) e reprocessamos pelo caminho normal
 * (`maybeReplyAsAIAgent`), que reavalia TODOS os guardas — autorização,
 * horário, handoff, anti-duplicata. Não montamos mensagem aqui.
 *
 * A distribuição de segurança (`stuck-inbound`, 15 min) segue como último
 * recurso: esta varredura roda antes, para a IA ter a chance de atender em
 * vez de o aluno ir para a fila humana por um restart de container.
 */

import { cache } from "@/lib/cache";
import { prismaBase } from "@/lib/prisma-base";
import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";
import { withSystemContext } from "@/lib/webhook-context";
import { collectUnansweredInboundText } from "@/services/ai/inbound-debounce";

/** Silêncio mínimo antes de reprocessar (o debounce normal leva ~2,5s). */
export const AI_RETRY_UNANSWERED_MS = 3 * 60 * 1000;
/** Além da janela de 24h do WhatsApp não há resposta livre possível. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;
const MAX_LIMIT = 300;
/** Uma tentativa por mensagem pendente — não reenfileira a cada tick. */
const CLAIM_TTL_SEC = 6 * 60 * 60;
const GEN_TTL_SEC = 120;

export type RetryUnansweredOpts = {
  now?: Date;
  /** false = dry-run (só lista). Padrão false. */
  apply?: boolean;
  /** Silêncio mínimo em ms. 0 desliga a varredura. */
  retryMs?: number;
  maxAgeMs?: number;
  limit?: number;
  organizationId?: string | null;
  /** Números de conversa específicos (ops). */
  numbers?: number[];
  /** Ignora o claim de tentativa única (reprocessa mesmo já tentado). */
  force?: boolean;
};

export type RetryUnansweredItem = {
  conversationNumber: number;
  contact: string;
  lastInboundAt: string | null;
  idleMinutes: number;
  status: "listed" | "retried" | "skipped" | "failed";
  reason?: string;
  error?: string;
};

export type RetryUnansweredResult = {
  apply: boolean;
  retryMs: number;
  candidates: number;
  retried: number;
  skipped: number;
  failed: number;
  items: RetryUnansweredItem[];
};

export async function retryUnansweredAiInbound(
  opts: RetryUnansweredOpts = {},
): Promise<RetryUnansweredResult> {
  const now = opts.now ?? new Date();
  const retryMs = opts.retryMs ?? AI_RETRY_UNANSWERED_MS;
  const maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? BATCH_SIZE));
  const apply = opts.apply ?? false;
  const numbers = (opts.numbers ?? []).filter((n) => Number.isFinite(n) && n > 0);

  const result: RetryUnansweredResult = {
    apply,
    retryMs,
    candidates: 0,
    retried: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };
  if (retryMs <= 0) return result;

  const rows = await prismaBase.conversation.findMany({
    where: {
      status: "OPEN",
      // Humano já falou: a conversa é dele, a IA não volta a responder.
      hasHumanReply: false,
      assignedTo: { is: { type: "AI" } },
      lastInboundAt: {
        lt: new Date(now.getTime() - retryMs),
        gte: new Date(now.getTime() - maxAgeMs),
      },
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
      ...(numbers.length ? { number: { in: numbers } } : {}),
    },
    orderBy: { lastInboundAt: "asc" },
    take: limit,
    select: {
      id: true,
      number: true,
      contactId: true,
      organizationId: true,
      lastInboundAt: true,
      contact: { select: { name: true } },
      channelRef: {
        select: {
          name: true,
          phoneNumber: true,
          config: true,
          provider: true,
        },
      },
    },
  });

  for (const row of rows) {
    const lastInboundAt = row.lastInboundAt;
    const contactId = row.contactId;
    if (!lastInboundAt || !contactId) continue;

    // Número aposentado: ninguém atende ali, nem a IA.
    if (
      isRetiredWhatsAppChannel({
        name: row.channelRef?.name ?? null,
        phoneNumber: row.channelRef?.phoneNumber ?? null,
        config: row.channelRef?.config ?? null,
      })
    ) {
      continue;
    }

    const idleMinutes = Math.round(
      (now.getTime() - lastInboundAt.getTime()) / 60_000,
    );
    const base: RetryUnansweredItem = {
      conversationNumber: row.number,
      contact: row.contact?.name ?? "?",
      lastInboundAt: lastInboundAt.toISOString(),
      idleMinutes,
      status: "listed",
    };

    // Alguém respondeu depois da última mensagem do aluno? Então não está
    // sem resposta (o `lastInboundAt` pode estar defasado).
    const answered = await prismaBase.message.findFirst({
      where: {
        conversationId: row.id,
        direction: "out",
        isPrivate: false,
        messageType: { not: "note" },
        createdAt: { gt: lastInboundAt },
      },
      select: { id: true },
    });
    if (answered) continue;

    // Já está na fila de espera de um humano — a drenagem cuida.
    const pending = await prismaBase.distributionPending.findFirst({
      where: {
        status: "PENDING",
        OR: [{ conversationId: row.id }, { contactId }],
      },
      select: { id: true },
    });
    if (pending) continue;

    result.candidates++;

    if (!apply) {
      result.items.push(base);
      continue;
    }

    // Tentativa única por mensagem pendente: sem isso o tick de 60s
    // reprocessaria a mesma conversa indefinidamente.
    const claimKey = `ai:retry-unanswered:${row.id}:${lastInboundAt.getTime()}`;
    if (!opts.force) {
      const claimed = await cache.tryClaim(claimKey, CLAIM_TTL_SEC);
      if (!claimed) {
        result.skipped++;
        result.items.push({ ...base, status: "skipped", reason: "already_tried" });
        continue;
      }
    }

    try {
      const retried = await withSystemContext(
        row.organizationId,
        async () => {
          const userMessage = await collectUnansweredInboundText(row.id);
          if (!userMessage.trim()) {
            // Só áudio/mídia sem texto: quem trata é o caminho de handoff
            // (`stuck-inbound`), não a IA respondendo no vazio.
            return { ok: false as const, reason: "no_text" as const };
          }

          const generationId = `retry-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 10)}`;
          // Assume a geração corrente: um flush antigo que sobreviver em
          // memória é descartado como supersedido em vez de responder duas vezes.
          await cache.set(`ai:gen:${row.id}`, generationId, GEN_TTL_SEC);

          const { maybeReplyAsAIAgent } = await import(
            "@/services/ai/inbox-handler"
          );
          await maybeReplyAsAIAgent({
            conversationId: row.id,
            contactId,
            userMessage,
            channel:
              row.channelRef?.provider === "BAILEYS_MD" ? "baileys" : "meta",
            generationId,
          });
          return { ok: true as const };
        },
        {
          actor: {
            type: "AI",
            label: "Agente IA",
            sublabel: "retry-unanswered",
          },
        },
      );

      if (retried.ok) {
        result.retried++;
        result.items.push({ ...base, status: "retried" });
      } else {
        result.skipped++;
        result.items.push({ ...base, status: "skipped", reason: retried.reason });
      }
    } catch (err) {
      result.failed++;
      result.items.push({
        ...base,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(
        `[ai-retry-unanswered] falha conv=${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (result.retried > 0 || result.failed > 0) {
    console.info(
      `[ai-retry-unanswered] reprocessadas=${result.retried} puladas=${result.skipped} falhas=${result.failed} de ${result.candidates} candidatas`,
    );
  }

  return result;
}
