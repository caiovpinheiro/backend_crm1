/**
 * Rede de segurança da distribuição.
 *
 * O aluno escreveu, a IA é a responsável e ninguém respondeu. Cobre falha
 * de LLM/chave, canal fora do ar e qualquer caminho em que o agente fica
 * em silêncio — sem isso o lead fica preso na IA e nunca chega a humano.
 *
 * Roda no `worker-distribution` (`stuck-inbound`). Cron POST e o tick
 * de inatividade só enfileiram o mesmo jobId. GET do cron continua
 * dry-run aqui. Override: `AI_AGENT_STUCK_INBOUND_MS` (0 desliga).
 *
 * Nunca envia mensagem ao aluno: só reatribui / enfileira.
 */

import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";
import { getVerticalPack } from "@/verticals";

function executeAcademicDepartmentHandoff(...args: any[]) {
  const fn = getVerticalPack("academic")?.ops.executeAcademicDepartmentHandoff;
  if (!fn) throw new Error("academic pack unavailable");
  return fn(...args);
}

export const STUCK_INBOUND_MS = 15 * 60 * 1000;

const BATCH_SIZE = 50;
const MAX_LIMIT = 500;

type StuckRow = {
  conversation_id: string;
  conversation_number: number;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  organization_id: string;
  last_inbound_at: Date;
  channel_name: string | null;
  channel_phone: string | null;
  channel_config: unknown;
};

export type StuckInboundOptions = {
  now?: Date;
  /** Tempo mínimo sem resposta para entrar na varredura. 0 desliga. */
  stuckMs?: number;
  /** Só olha inbound dos últimos N ms. 0 = sem limite (padrão). */
  sinceMs?: number;
  limit?: number;
  /** false = dry-run (só lista, não distribui). Padrão true. */
  apply?: boolean;
  organizationId?: string | null;
};

export type StuckInboundItem = {
  conversationNumber: number;
  contact: string;
  phone: string | null;
  lastInboundAt: string | null;
  idleMinutes: number;
  status: "listed" | "distributed" | "queued" | "failed";
  department: string | null;
  assignedTo: string | null;
  reason?: string;
  error?: string;
};

export type StuckInboundResult = {
  apply: boolean;
  stuckMs: number;
  sinceMs: number;
  candidates: number;
  distributed: number;
  queued: number;
  failed: number;
  items: StuckInboundItem[];
};

async function listStuckInbound(args: {
  now: Date;
  stuckMs: number;
  sinceMs: number;
  limit: number;
  organizationId: string;
}): Promise<StuckRow[]> {
  const cutoff = new Date(args.now.getTime() - args.stuckMs);
  // sinceMs = 0 → epoch, ou seja, sem limite inferior de janela.
  const since = new Date(
    args.sinceMs > 0 ? args.now.getTime() - args.sinceMs : 0,
  );
  const org = args.organizationId;

  return prismaBase.$queryRaw<StuckRow[]>`
    SELECT
      c.id AS conversation_id,
      c."number" AS conversation_number,
      c."contactId" AS contact_id,
      ct.name AS contact_name,
      ct.phone AS contact_phone,
      c."organizationId" AS organization_id,
      c."lastInboundAt" AS last_inbound_at,
      ch.name AS channel_name,
      ch."phoneNumber" AS channel_phone,
      ch.config AS channel_config
    FROM "conversations" c
    LEFT JOIN "users" u ON u.id = c."assignedToId"
    LEFT JOIN "ai_agent_configs" a ON a."userId" = u.id
    LEFT JOIN "contacts" ct ON ct.id = c."contactId"
    LEFT JOIN "channels" ch ON ch.id = c."channelId"
    WHERE (
        (u.type = 'AI' AND a.active = true)
        OR c."assignedToId" IS NULL
      )
      AND c.status = 'OPEN'
      AND c."hasHumanReply" = false
      AND c."contactId" IS NOT NULL
      AND c."lastInboundAt" IS NOT NULL
      AND c."lastInboundAt" < ${cutoff}::timestamptz
      AND c."lastInboundAt" >= ${since}::timestamptz
      AND (${org}::text = '' OR c."organizationId" = ${org}::text)
      -- Ninguém respondeu depois da última mensagem do aluno.
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m."conversationId" = c.id
          AND m.direction = 'out'
          AND COALESCE(m."isPrivate", false) = false
          AND m."messageType" <> 'note'
          AND m."createdAt" > c."lastInboundAt"
      )
      -- Já está na fila de espera: a drenagem cuida.
      AND NOT EXISTS (
        SELECT 1 FROM distribution_pending dp
        WHERE dp.status = 'PENDING'
          AND (dp."conversationId" = c.id OR dp."contactId" = c."contactId")
      )
    ORDER BY c."lastInboundAt" ASC
    LIMIT ${args.limit};
  `;
}

/**
 * Aceita a forma legada `(now, stuckMs)` usada pelo worker e a forma
 * com opções usada pela rota de ops.
 */
export async function distributeStuckInbound(
  arg?: Date | StuckInboundOptions,
  legacyStuckMs?: number,
): Promise<StuckInboundResult> {
  const opts: StuckInboundOptions =
    arg === undefined || arg instanceof Date
      ? { now: arg, stuckMs: legacyStuckMs }
      : arg;

  const now = opts.now ?? new Date();
  const stuckMs = opts.stuckMs ?? STUCK_INBOUND_MS;
  const sinceMs = Math.max(0, opts.sinceMs ?? 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? BATCH_SIZE));
  const apply = opts.apply ?? true;

  const empty: StuckInboundResult = {
    apply,
    stuckMs,
    sinceMs,
    candidates: 0,
    distributed: 0,
    queued: 0,
    failed: 0,
    items: [],
  };
  if (stuckMs <= 0) return empty;

  const rows = await listStuckInbound({
    now,
    stuckMs,
    sinceMs,
    limit,
    organizationId: opts.organizationId?.trim() || "",
  });

  const items: StuckInboundItem[] = [];
  let distributed = 0;
  let queued = 0;
  let failed = 0;

  for (const row of rows) {
    // Número aposentado: não desatribui nem enfileira — ninguém atende ali.
    if (
      isRetiredWhatsAppChannel({
        name: row.channel_name,
        phoneNumber: row.channel_phone,
        config: row.channel_config,
      })
    ) {
      continue;
    }

    const idleMinutes = Math.round(
      (now.getTime() - new Date(row.last_inbound_at).getTime()) / 60_000,
    );
    const base: StuckInboundItem = {
      conversationNumber: row.conversation_number,
      contact: row.contact_name ?? "?",
      phone: row.contact_phone,
      lastInboundAt: new Date(row.last_inbound_at).toISOString(),
      idleMinutes,
      status: "listed",
      department: null,
      assignedTo: null,
    };

    if (!apply) {
      items.push(base);
      continue;
    }

    try {
      const result = await withSystemContext(row.organization_id, () =>
        executeAcademicDepartmentHandoff({
          conversationId: row.conversation_id,
          contactId: row.contact_id,
          reason: `IA sem responder há ${idleMinutes} min — distribuição de segurança`,
        }),
      );
      const assigned =
        result.distribution?.success && result.distribution.selectedUserId
          ? (result.distribution.selectedUserName ?? "atribuído")
          : null;
      if (assigned) {
        distributed++;
      } else {
        queued++;
      }
      items.push({
        ...base,
        status: assigned ? "distributed" : "queued",
        department: result.departmentName,
        assignedTo: assigned,
        reason: result.distribution?.reason,
      });
    } catch (err) {
      failed++;
      items.push({
        ...base,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(
        `[ai-stuck-inbound] falha conv=${row.conversation_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (distributed > 0 || queued > 0) {
    console.info(
      `[ai-stuck-inbound] distribuídas=${distributed} enfileiradas=${queued} de ${items.length} candidatas`,
    );
  }

  return {
    apply,
    stuckMs,
    sinceMs,
    candidates: items.length,
    distributed,
    queued,
    failed,
    items,
  };
}
