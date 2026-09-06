/**
 * AI Agent Inactivity Worker.
 *
 * 1) Follow-up só-IA:
 *    30 min sem retorno → check-in empático (se janela 24h aberta).
 *    +30 min sem resposta ao check-in (ou 30 min e janela já fechada)
 *    → `closeAiOnlyConversation`. Overrides: `AI_AGENT_IDLE_NUDGE_MS`,
 *    `AI_AGENT_IDLE_CLOSE_AFTER_NUDGE_MS`. 0 no nudge desliga o par.
 *
 * 2) Handoff por inatividade (`inactivityTimerMs > 0`), só se já houve
 *    reply humano. IA-only não vai pra fila de consultor.
 *
 * 3) Retry de inbound sem resposta: aluno escreveu, a IA é a responsável e
 *    ninguém respondeu (debounce perdido em restart). Override:
 *    `AI_AGENT_RETRY_UNANSWERED_MS` (0 desliga).
 *
 * Opt-out do worker inteiro: `AI_AGENT_INACTIVITY_WORKER=0`.
 */


import { prisma } from "@/lib/prisma";
// prismaBase para o $queryRaw cross-tenant da listagem; dispatchOne
// acessa models scoped e precisa rodar em withSystemContext.
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import {
  normalizeBusinessHours,
  renderTemplate,
  type HandoffMode,
} from "@/lib/ai-agents/piloting";
import { getVerticalPack } from "@/verticals";
import {
  IDLE_CLOSE_AFTER_NUDGE_MS,
  IDLE_NUDGE_MS,
  buildIdleNudgeMessage,
  isIdleNudgeContent,
} from "@/services/ai/idle-followup";
import {
  executeAgentHandoff,
  sendAgentMessage,
} from "@/services/ai/piloting-actions";
import { enqueueDistributionStuckInbound } from "@/lib/distribution-execute-queue";
import {
  AI_RETRY_UNANSWERED_MS,
  retryUnansweredAiInbound,
} from "@/services/ai/retry-unanswered-ai-inbound";
import { STUCK_INBOUND_MS } from "@/services/ai/stuck-inbound-distribution";

function academicOps() {
  return getVerticalPack("academic")?.ops ?? {};
}
function attendanceEndedInFarewell(...a: any[]) {
  return academicOps().attendanceEndedInFarewell?.(...a);
}
function closeAiOnlyConversation(...a: any[]) {
  return academicOps().closeAiOnlyConversation?.(...a);
}

const INTERVAL_MS = Number(process.env.AI_AGENT_INACTIVITY_INTERVAL_MS) || 60_000;
const BATCH_SIZE = 50;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

let started = false;

export function startAIAgentInactivityWorker() {
  if (started) return;
  if (process.env.AI_AGENT_INACTIVITY_WORKER === "0") {
    console.info("[ai-inactivity] worker desativado via env");
    return;
  }
  started = true;

  const tick = async () => {
    try {
      await tickOnce();
    } catch (err) {
      console.warn(
        "[ai-inactivity] tick falhou:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  // Primeiro tick depois de 20s pra dar tempo do servidor subir.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), INTERVAL_MS);
  }, 20_000);

  console.info(
    `[ai-inactivity] worker iniciado (tick=${INTERVAL_MS}ms, nudgeMs=${envMs("AI_AGENT_IDLE_NUDGE_MS", IDLE_NUDGE_MS)}, closeAfterNudgeMs=${envMs("AI_AGENT_IDLE_CLOSE_AFTER_NUDGE_MS", IDLE_CLOSE_AFTER_NUDGE_MS)})`,
  );
}

type ExpiredRow = {
  conversation_id: string;
  contact_id: string;
  assigned_to_id: string;
  agent_id: string;
  autonomy_mode: "AUTONOMOUS" | "DRAFT";
  inactivity_timer_ms: number;
  handoff_mode: string;
  handoff_user_id: string | null;
  farewell_message: string | null;
  business_hours: unknown;
  updated_at: Date;
  organization_id: string;
};

type IdleRow = {
  conversation_id: string;
  contact_id: string | null;
  organization_id: string;
  assigned_to_id: string;
  autonomy_mode: "AUTONOMOUS" | "DRAFT";
  last_out_content: string | null;
  last_out_at: Date;
  last_in_content: string | null;
  last_inbound_at: Date | null;
};

async function listIdleAiOnly(now: Date, idleMs: number): Promise<IdleRow[]> {
  if (idleMs <= 0) return [];
  return prismaBase.$queryRaw<IdleRow[]>`
    SELECT
      c.id AS conversation_id,
      c."contactId" AS contact_id,
      c."organizationId" AS organization_id,
      c."assignedToId" AS assigned_to_id,
      a."autonomyMode" AS autonomy_mode,
      last_out.content AS last_out_content,
      last_out."createdAt" AS last_out_at,
      last_in.content AS last_in_content,
      c."lastInboundAt" AS last_inbound_at
    FROM "conversations" c
    JOIN "users" u ON u.id = c."assignedToId"
    JOIN "ai_agent_configs" a ON a."userId" = u.id
    JOIN LATERAL (
      SELECT m.content, m."createdAt"
      FROM messages m
      WHERE m."conversationId" = c.id
        AND m.direction = 'out'
        AND COALESCE(m."isPrivate", false) = false
        AND m."messageType" <> 'note'
      ORDER BY m."createdAt" DESC
      LIMIT 1
    ) last_out ON true
    LEFT JOIN LATERAL (
      SELECT m.content
      FROM messages m
      WHERE m."conversationId" = c.id
        AND m.direction = 'in'
        AND COALESCE(m."isPrivate", false) = false
        AND m."messageType" <> 'note'
      ORDER BY m."createdAt" DESC
      LIMIT 1
    ) last_in ON true
    WHERE u.type = 'AI'
      AND a.active = true
      AND c.status = 'OPEN'
      AND c."hasHumanReply" = false
      AND last_out."createdAt" < (${now}::timestamptz - ((${idleMs})::text || ' milliseconds')::interval)
      -- Aluno não falou depois da última mensagem da IA. Não usamos
      -- lastMessageDirection/hasAgentReply: no lead de entrada essas flags
      -- atrasam ou ficam 'in' e o check-in nunca disparava.
      AND (
        c."lastInboundAt" IS NULL
        OR c."lastInboundAt" <= last_out."createdAt"
      )
    ORDER BY last_out."createdAt" ASC
    LIMIT ${BATCH_SIZE};
  `;
}

function windowOpen(lastInboundAt: Date | null, now: Date): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000;
}

async function processIdleAiOnly(
  now: Date,
): Promise<{ closed: number; nudged: number }> {
  const nudgeMs = envMs("AI_AGENT_IDLE_NUDGE_MS", IDLE_NUDGE_MS);
  const closeMs = envMs(
    "AI_AGENT_IDLE_CLOSE_AFTER_NUDGE_MS",
    IDLE_CLOSE_AFTER_NUDGE_MS,
  );
  if (nudgeMs <= 0) return { closed: 0, nudged: 0 };

  const rows = await listIdleAiOnly(now, Math.min(nudgeMs, closeMs || nudgeMs));
  let closed = 0;
  let nudged = 0;

  for (const row of rows) {
    const isNudge = isIdleNudgeContent(row.last_out_content);
    const ageMs = now.getTime() - new Date(row.last_out_at).getTime();
    const canText = windowOpen(row.last_inbound_at, now);
    // Atendimento já terminou em despedida: perguntar "ainda posso
    // ajudar?" reabre uma conversa encerrada. Encerra direto.
    const endedInFarewell =
      !isNudge &&
      attendanceEndedInFarewell({
        lastAgentText: row.last_out_content,
        lastStudentText: row.last_in_content,
      });

    const shouldClose =
      endedInFarewell ||
      (isNudge && ageMs >= closeMs) ||
      (!isNudge && !canText && ageMs >= nudgeMs);
    const shouldNudge =
      !isNudge && !endedInFarewell && canText && ageMs >= nudgeMs;

    try {
      if (shouldClose) {
        const result = await withSystemContext(row.organization_id, () =>
          closeAiOnlyConversation({
            conversationId: row.conversation_id,
            contactId: row.contact_id,
            reason: endedInFarewell
              ? "IA: atendimento concluído na despedida"
              : isNudge
                ? "IA: sem resposta ao check-in de 30 min"
                : "IA: 30 min sem retorno e janela 24h fechada",
          }),
        );
        if (result.closed) closed++;
        continue;
      }
      if (shouldNudge && row.contact_id && row.assigned_to_id) {
        const sent = await withSystemContext(row.organization_id, () =>
          sendAgentMessage({
            conversationId: row.conversation_id,
            contactId: row.contact_id!,
            agentUserId: row.assigned_to_id,
            autonomyMode: row.autonomy_mode,
            text: buildIdleNudgeMessage(),
            kind: "text",
          }),
        );
        if (sent.status === "sent") {
          nudged++;
        } else {
          console.warn(
            `[ai-inactivity] check-in não enviado conv=${row.conversation_id} status=${sent.status}` +
              ("reason" in sent ? ` reason=${sent.reason}` : ""),
          );
        }
      }
    } catch (err) {
      console.error(
        `[ai-inactivity] falha idle conv=${row.conversation_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (closed > 0 || nudged > 0) {
    console.info(
      `[ai-inactivity] tick — check-ins=${nudged} encerradas=${closed}`,
    );
  }
  return { closed, nudged };
}

export async function tickOnce(now: Date = new Date()) {
  const { closed } = await processIdleAiOnly(now);

  // Aluno escreveu e a IA nunca respondeu (timer do debounce morreu num
  // restart de container, ou o flush estourou). Reprocessa ANTES da
  // distribuição de segurança, pra IA atender em vez de jogar o aluno na
  // fila humana por causa de um deploy. `AI_AGENT_RETRY_UNANSWERED_MS=0` desliga.
  let retried = 0;
  try {
    const retryMs = envMs(
      "AI_AGENT_RETRY_UNANSWERED_MS",
      AI_RETRY_UNANSWERED_MS,
    );
    const r = await retryUnansweredAiInbound({ now, apply: true, retryMs });
    retried = r.retried;
  } catch (err) {
    console.warn(
      "[ai-inactivity] retry de inbound sem resposta falhou:",
      err instanceof Error ? err.message : err,
    );
  }

  // Aluno esperando resposta da IA há tempo demais → mesmo job do cron
  // (`dsi-stuck-inbound`) no worker-distribution. Dedup evita SQL duplo.
  try {
    const queued = await enqueueDistributionStuckInbound({
      apply: true,
      stuckMs: envMs("AI_AGENT_STUCK_INBOUND_MS", STUCK_INBOUND_MS),
    });
    if (!queued) {
      console.warn(
        "[ai-inactivity] stuck-inbound não enfileirado (Redis/fila down)",
      );
    }
  } catch (err) {
    console.warn(
      "[ai-inactivity] enqueue stuck-inbound falhou:",
      err instanceof Error ? err.message : err,
    );
  }

  // Worker cross-tenant: varre TODAS as orgs. Usa prismaBase para que
  // o extension nao tente escopar ou exigir RequestContext. O JOIN
  // traz conversations.organizationId para montar withSystemContext
  // por linha.
  const rows = await prismaBase.$queryRaw<ExpiredRow[]>`
    SELECT
      c.id AS conversation_id,
      c."contactId" AS contact_id,
      c."assignedToId" AS assigned_to_id,
      c."organizationId" AS organization_id,
      a.id AS agent_id,
      a."autonomyMode" AS autonomy_mode,
      a."inactivityTimerMs" AS inactivity_timer_ms,
      a."inactivityHandoffMode" AS handoff_mode,
      a."inactivityHandoffUserId" AS handoff_user_id,
      a."inactivityFarewellMessage" AS farewell_message,
      a."businessHours" AS business_hours,
      c."updatedAt" AS updated_at
    FROM "conversations" c
    JOIN "users" u ON u.id = c."assignedToId"
    JOIN "ai_agent_configs" a ON a."userId" = u.id
    WHERE u.type = 'AI'
      AND a.active = true
      AND a."inactivityTimerMs" > 0
      AND c.status = 'OPEN'
      AND c."hasHumanReply" = true
      AND c."lastMessageDirection" = 'out'
      AND c."hasAgentReply" = true
      AND c."updatedAt" < (${now}::timestamptz - (a."inactivityTimerMs" || ' ms')::interval)
    ORDER BY c."updatedAt" ASC
    LIMIT ${BATCH_SIZE};
  `;

  let handed = 0;
  for (const row of rows) {
    try {
      await withSystemContext(row.organization_id, () => dispatchOne(row));
      handed++;
    } catch (err) {
      console.error(
        `[ai-inactivity] falha processando conv=${row.conversation_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (handed > 0) {
    console.info(`[ai-inactivity] tick concluído — transferidas=${handed}`);
  }
  return { processed: rows.length, handed, closed, retried };
}

async function dispatchOne(row: ExpiredRow) {
  // Respeita horário de atendimento: se está fora do expediente,
  // não transfere (o humano não estaria disponível mesmo). Volta no
  // próximo tick dentro do horário.
  const businessHours = normalizeBusinessHours(row.business_hours);
  if (businessHours?.enabled) {
    const { isWithinBusinessHours } = await import("@/lib/ai-agents/piloting");
    if (!isWithinBusinessHours(businessHours)) return;
  }

  // Busca o deal aberto (se existir) — necessário pra handoff
  // KEEP_OWNER e pro evento de deal.
  const openDeal = await prisma.deal.findFirst({
    where: { contactId: row.contact_id, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, stage: { select: { name: true } } },
  });

  // Envia farewell (se configurada) antes do handoff pra cliente
  // ter contexto de que vai passar pra humano.
  if (row.farewell_message?.trim()) {
    const contact = await prisma.contact.findUnique({
      where: { id: row.contact_id },
      select: { name: true },
    });
    const text = renderTemplate(row.farewell_message, {
      contactName: contact?.name ?? null,
      dealTitle: openDeal?.title ?? null,
      stageName: openDeal?.stage?.name ?? null,
    });
    await sendAgentMessage({
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      agentUserId: row.assigned_to_id,
      autonomyMode: row.autonomy_mode,
      text,
      kind: "farewell",
    }).catch((e) => {
      console.warn("[ai-inactivity] farewell falhou:", e);
    });
  }

  const mode: HandoffMode =
    row.handoff_mode === "SPECIFIC_USER" ||
    row.handoff_mode === "UNASSIGN" ||
    row.handoff_mode === "KEEP_OWNER"
      ? (row.handoff_mode as HandoffMode)
      : "KEEP_OWNER";

  await executeAgentHandoff({
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    dealId: openDeal?.id ?? null,
    agentId: row.agent_id,
    agentUserId: row.assigned_to_id,
    mode,
    specificUserId: row.handoff_user_id,
    reason: `Cliente ficou ${Math.round(row.inactivity_timer_ms / 60_000)} min sem responder — handoff automático.`,
  });
}
