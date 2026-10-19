/**
 * Inatividade do cliente no agente v2 ("Começo e fim › Cliente sem
 * responder"): depois da última mensagem do agente, até três lembretes e o
 * encerramento. O worker de inatividade do v1 ignora agentes v2 de
 * propósito; sem isto a config existia e nada acontecia — "encerro em 30
 * minutos" e o atendimento seguia aberto.
 * Nenhum domínio de cliente.
 */

import { prismaBase } from "@/lib/prisma-base";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import { buildVariableMap, defaultFormatter, renderMessage } from "@/lib/ai-v2/message-render";
import type { V2AgentConfig, V2FollowUpStep, V2InactivityConfig } from "@/lib/ai-v2/types";
import { getLogger } from "@/lib/logger";
import { asksClient, classifyReply, replyEndingPhrases, withoutReplyEndings } from "./reply-ending";

const log = getLogger("ai-v2.inactivity");

export const NUDGE_MESSAGE_DEFAULT = "Ainda está por aí? Se precisar de algo, é só me responder.";
/** Lembrete depois de um passo a passo. */
export const FOLLOWUP_PROCEDURE_DEFAULT = "Conseguiu fazer? Se travou em algum passo, me conta qual que eu te ajudo.";
/** Lembrete depois de uma pergunta do agente. */
export const FOLLOWUP_QUESTION_DEFAULT = "Ainda está por aí? Fico no aguardo da sua resposta para continuar.";

const MINUTE = 60 * 1000;

/**
 * Depois da mensagem de encerramento: etapa de perdido + motivo, se a config
 * deste agente pedir. Falha aqui não impede o encerramento da conversa.
 */
async function loseIdleDeal(
  config: V2AgentConfig,
  dealId: string | null,
  contactId: string | null,
): Promise<{ stageId: string; lostReason?: string } | null> {
  const cfg = config.inactivity?.lostDeal;
  if (!cfg?.enabled || !cfg.stageId || !dealId) return null;
  try {
    const { prisma } = await import("@/lib/prisma");
    const { updateDeal } = await import("@/services/deals");
    const stage = await prisma.stage.findUnique({
      where: { id: cfg.stageId },
      select: { isLost: true },
    });
    if (!stage?.isLost) return null;
    let lostReason: string | undefined;
    if (cfg.reasonId) {
      const reason = await prisma.lossReason.findFirst({
        where: { id: cfg.reasonId, isActive: true },
        select: { label: true },
      });
      const label = reason?.label?.trim();
      if (label) lostReason = label;
    }
    const before = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { stageId: true, contactId: true },
    });
    await updateDeal(dealId, { stageId: cfg.stageId, ...(lostReason ? { lostReason } : {}) });
    if (before?.stageId !== cfg.stageId) {
      const { notifyDealStageChanged } = await import("@/services/automation-triggers");
      void notifyDealStageChanged(dealId, before?.stageId, cfg.stageId, {
        contactId: contactId ?? before?.contactId,
        depth: 0,
      });
    }
    return { stageId: cfg.stageId, ...(lostReason ? { lostReason } : {}) };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err, dealId },
      "[ai-v2 inatividade] não moveu o negócio para perdido",
    );
    return null;
  }
}
const WINDOW_24H = 24 * 60 * MINUTE;

export type V2IdleKind = "procedure" | "question" | "other";

/**
 * Lembretes valendo, em ordem de prazo, até 3, só os que saem antes do
 * encerramento. Sem lista, o aviso único antigo (`nudgeAfter`) é o lembrete.
 */
export function followUpSteps(cfg: V2InactivityConfig | undefined): V2FollowUpStep[] {
  if (!cfg) return [];
  const closeAfter = Math.max(0, cfg.closeAfter ?? 0);
  const list = (cfg.followUps ?? []).filter((s) => s && s.after > 0);
  const steps = list.length > 0
    ? list
    : (cfg.nudgeAfter ?? 0) > 0
      ? [{ after: cfg.nudgeAfter as number, mode: "fixed" as const, ...(cfg.nudgeMessage ? { message: cfg.nudgeMessage } : {}) }]
      : [];
  return [...steps]
    .sort((a, b) => a.after - b.after)
    .filter((s) => closeAfter === 0 || s.after < closeAfter)
    .slice(0, 3);
}

/** De que tipo foi a última mensagem do agente (sem a frase de fecho). */
export function idleKindOf(text: string | null | undefined, config: Pick<V2AgentConfig, "replyEnding" | "themes">): V2IdleKind {
  const t = (text ?? "").trim();
  if (!t) return "other";
  if (classifyReply(t) === "procedure") return "procedure";
  const core = withoutReplyEndings(t, replyEndingPhrases(config));
  return core && asksClient(core) ? "question" : "other";
}

export type V2IdleDecision = { action: "followup"; index: number } | { action: "close" } | { action: "none" };

/**
 * O que fazer com a conversa parada. Prazos em minutos desde `anchorAt` (a
 * última mensagem do agente que não é lembrete). Depois de um lembrete, o
 * encerramento ainda dá ao cliente o intervalo que faltava entre ele e o
 * encerramento. Fora da janela de 24h do WhatsApp não há lembrete (a Meta
 * não entrega), só o encerramento.
 */
export function decideV2Idle(args: {
  inactivity: V2InactivityConfig | undefined;
  anchorAt: Date;
  /** Lembretes já mandados desde `anchorAt`. */
  sent: number;
  lastFollowUpAt: Date | null;
  lastInboundAt: Date | null;
  now: Date;
}): V2IdleDecision {
  const cfg = args.inactivity;
  if (!cfg?.enabled) return { action: "none" };
  const steps = followUpSteps(cfg);
  const closeAfter = Math.max(0, cfg.closeAfter ?? 0);
  const age = (args.now.getTime() - args.anchorAt.getTime()) / MINUTE;
  const sent = Math.min(args.sent, steps.length);
  if (closeAfter > 0 && age >= closeAfter) {
    if (!args.lastFollowUpAt || sent === 0) return { action: "close" };
    const sinceLast = (args.now.getTime() - args.lastFollowUpAt.getTime()) / MINUTE;
    const gap = Math.max(1, closeAfter - steps[sent - 1].after);
    if (sinceLast >= gap) return { action: "close" };
  }
  const canText = !!args.lastInboundAt && args.now.getTime() - args.lastInboundAt.getTime() < WINDOW_24H;
  const next = steps[sent];
  if (next && age >= next.after && canText) return { action: "followup", index: sent };
  return { action: "none" };
}

/** Texto fixo do lembrete (modos "fixo" e "conforme a última mensagem"). */
export function followUpFixedText(step: V2FollowUpStep, kind: V2IdleKind): string {
  if (step.mode === "by_reply" || step.mode === "generated") {
    if (kind === "procedure") return step.procedureMessage?.trim() || FOLLOWUP_PROCEDURE_DEFAULT;
    if (kind === "question") return step.questionMessage?.trim() || FOLLOWUP_QUESTION_DEFAULT;
  }
  return step.message?.trim() || NUDGE_MESSAGE_DEFAULT;
}

/**
 * Lembrete escrito pelo agente vale só se for curto e sem dado: número, data,
 * valor ou link seriam afirmação sem conferência.
 */
export function acceptableGeneratedFollowUp(text: string | null | undefined): string | null {
  const t = (text ?? "").trim().replace(/^["“]|["”]$/g, "").trim();
  if (!t || t.length > 280) return null;
  if (/\d|https?:\/\/|www\./i.test(t)) return null;
  return t;
}

const FOLLOWUP_WRITER_SYSTEM = [
  "Você escreve UMA mensagem curta de acompanhamento para um cliente que parou de responder num atendimento por mensagem.",
  "Até 2 frases, no tom do atendente. Retome o ponto em que a conversa parou: se o atendente mandou passos, pergunte se o cliente conseguiu; se fez uma pergunta, retome a pergunta; se respondeu uma dúvida, pergunte se ficou claro.",
  "Não traga informação nova, não cite números, datas, valores, prazos ou links, não prometa nada e não se despeça.",
  "Responda só com o texto da mensagem.",
].join(" ");

type IdleRow = {
  conversation_id: string;
  organization_id: string;
  contact_id: string;
  contact_name: string | null;
  assigned_to_id: string;
  agent_config_id: string;
  simple_config: unknown;
  channel_kind: "meta" | "baileys";
  theme_id: string | null;
  deal_id: string | null;
  last_out_content: string | null;
  last_out_at: Date;
  last_inbound_at: Date | null;
  idle_follow_up?: { anchorAt?: string; sent?: number; lastAt?: string; kind?: V2IdleKind } | null;
  has_state?: boolean;
  /** Ticket novo depois de um encerramento: o agente perguntou se é algo novo e espera. */
  post_close_asked?: boolean;
};

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe?: (q: string, ...v: unknown[]) => Promise<number>;
};

/**
 * Conversas de agentes v2 com inatividade ligada, abertas, sem resposta de
 * pessoa, com o agente como último a falar e já no prazo mínimo (o menor
 * entre o primeiro lembrete e o encerramento). Fica de fora quem está na fila
 * ou encerrado.
 */
async function listIdleV2(now: Date): Promise<IdleRow[]> {
  return db.$queryRawUnsafe<IdleRow[]>(
    `SELECT c."id" AS conversation_id, c."organizationId" AS organization_id, c."contactId" AS contact_id,
            ct."name" AS contact_name, c."assignedToId" AS assigned_to_id, a."id" AS agent_config_id,
            a."simpleConfig" AS simple_config,
            CASE WHEN ch."provider" = 'BAILEYS_MD' THEN 'baileys' ELSE 'meta' END AS channel_kind,
            s."themeId" AS theme_id,
            COALESCE(s."selectedDealId", (
              SELECT d."id" FROM "deals" d
               WHERE d."contactId" = c."contactId" AND d."status" <> 'LOST'
               ORDER BY d."updatedAt" DESC LIMIT 1
            )) AS deal_id,
            last_out."content" AS last_out_content, last_out."createdAt" AS last_out_at,
            c."lastInboundAt" AS last_inbound_at,
            s."counters"->'idleFollowUp' AS idle_follow_up,
            (s."id" IS NOT NULL) AS has_state,
            (s."stage" = 'closed' AND s."counters"->>'postCloseAsked' = 'true') AS post_close_asked
       FROM "conversations" c
       JOIN "users" u ON u."id" = c."assignedToId" AND u."type" = 'AI'
       JOIN "ai_agent_configs" a ON a."userId" = u."id" AND a."active" = true AND a."engine" = 'simple'
       LEFT JOIN "contacts" ct ON ct."id" = c."contactId"
       LEFT JOIN "channels" ch ON ch."id" = c."channelId"
       LEFT JOIN "ai_simple_conversation_states" s ON s."conversationId" = c."id"
       JOIN LATERAL (
         SELECT m."content", m."createdAt", m."aiAgentUserId" FROM "messages" m
          WHERE m."conversationId" = c."id" AND m."direction" = 'out'
            AND COALESCE(m."isPrivate", false) = false AND m."messageType" <> 'note'
          ORDER BY m."createdAt" DESC LIMIT 1
       ) last_out ON true
      WHERE c."status" = 'OPEN'
        -- A última mensagem enviada é do próprio agente: o timer dele vale.
        -- Pessoa que falou antes no ticket (hasHumanReply) não segura o
        -- encerramento quando a IA voltou a atender e prometeu encerrar; se a
        -- última foi de uma pessoa ou de um fluxo, não encerra.
        AND last_out."aiAgentUserId" = c."assignedToId"
        AND (a."simpleConfig"->'inactivity'->>'enabled') = 'true'
        -- Encerrado fica de fora, menos o ticket novo em que o agente perguntou
        -- "é algo novo?" e o cliente não respondeu: ele ficava aberto para sempre.
        AND (s."id" IS NULL OR (s."owner" <> 'pessoa' AND (s."stage" <> 'closed' OR s."counters"->>'postCloseAsked' = 'true')))
        AND (c."lastInboundAt" IS NULL OR c."lastInboundAt" <= last_out."createdAt")
        AND last_out."createdAt" < $1::timestamptz - make_interval(mins => LEAST(
              COALESCE(NULLIF((a."simpleConfig"->'inactivity'->'followUps'->0->>'after')::int, 0), 1000000),
              COALESCE(NULLIF((a."simpleConfig"->'inactivity'->>'nudgeAfter')::int, 0), 1000000),
              COALESCE(NULLIF((a."simpleConfig"->'inactivity'->>'closeAfter')::int, 0), 1000000)))
      ORDER BY last_out."createdAt" ASC
      LIMIT 300`,
    now,
  );
}

function autonomy(config: V2AgentConfig): "AUTONOMOUS" | "DRAFT" {
  return config.autonomyMode === "auto" ? "AUTONOMOUS" : "DRAFT";
}

/**
 * De onde contam os prazos: se a última mensagem enviada é o lembrete que
 * esta passada registrou, vale a âncora gravada; senão a última mensagem é
 * nova e a contagem recomeça dela.
 */
export function idleProgress(row: Pick<IdleRow, "idle_follow_up" | "last_out_at" | "last_out_content">, config: V2AgentConfig): {
  anchorAt: Date;
  sent: number;
  lastFollowUpAt: Date | null;
  kind: V2IdleKind;
} {
  const lastOutAt = new Date(row.last_out_at);
  const f = row.idle_follow_up;
  if (f?.anchorAt && f.lastAt && Math.abs(new Date(f.lastAt).getTime() - lastOutAt.getTime()) < 5000) {
    return { anchorAt: new Date(f.anchorAt), sent: Math.max(0, f.sent ?? 0), lastFollowUpAt: new Date(f.lastAt), kind: f.kind ?? "other" };
  }
  // Sem registro (conversa sem estado): o aviso único antigo ainda é
  // reconhecido pelo texto, como antes.
  const steps = followUpSteps(config.inactivity);
  const lastText = (row.last_out_content ?? "").trim();
  const fixedTexts = steps.map((s) => followUpFixedText(s, "other"));
  const idx = lastText ? fixedTexts.findIndex((t) => t === lastText) : -1;
  if (idx >= 0) {
    const anchorAt = new Date(lastOutAt.getTime() - steps[idx].after * MINUTE);
    return { anchorAt, sent: idx + 1, lastFollowUpAt: lastOutAt, kind: "other" };
  }
  return { anchorAt: lastOutAt, sent: 0, lastFollowUpAt: null, kind: idleKindOf(row.last_out_content, config) };
}

/** Lembrete escrito pelo agente a partir das últimas mensagens; null = usa o texto fixo. */
async function writeFollowUp(config: V2AgentConfig, agentConfigId: string, conversationId: string): Promise<string | null> {
  try {
    const { tryGetAgentApiKey } = await import("@/services/ai/agent-key");
    const apiKey = await tryGetAgentApiKey(agentConfigId).catch(() => null);
    if (!apiKey) return null;
    const rows = await db.$queryRawUnsafe<Array<{ direction: string; content: string | null }>>(
      `SELECT m."direction", m."content" FROM "messages" m
        WHERE m."conversationId" = $1 AND COALESCE(m."isPrivate", false) = false AND m."messageType" <> 'note'
        ORDER BY m."createdAt" DESC LIMIT 8`,
      conversationId,
    );
    const history = rows.reverse().filter((r) => r.content?.trim())
      .map((r) => `${r.direction === "out" ? "Atendente" : "Cliente"}: ${String(r.content).slice(0, 500)}`).join("\n");
    if (!history) return null;
    const { generateWithTools } = await import("@/services/ai/provider");
    const { v2FastAuxModel } = await import("@/lib/ai-v2/models");
    const res = await generateWithTools({
      model: v2FastAuxModel(config.model),
      apiKey,
      system: `${FOLLOWUP_WRITER_SYSTEM}${config.tone ? ` Tom do atendente: ${config.tone}.` : ""}`,
      messages: [{ role: "user", content: `Conversa:\n${history}` }] as never,
      temperature: 0.3,
      maxOutputTokens: 120,
      maxSteps: 1,
    });
    return acceptableGeneratedFollowUp(res.text);
  } catch {
    return null;
  }
}

/** Uma passada: manda lembretes e encerra o que venceu. */
export async function processIdleV2(now: Date = new Date()): Promise<{ nudged: number; closed: number }> {
  const rows = await listIdleV2(now);
  let nudged = 0;
  let closed = 0;
  if (rows.length === 0) return { nudged, closed };
  const { withSystemContext } = await import("@/lib/webhook-context");
  const { sendV2TextMessage, v2HumanBehavior } = await import("./actions");
  const { closeState } = await import("./engine");
  const { logV2Turn } = await import("./log");
  const { runWithV2Trace, traceStep } = await import("./trace");
  const { getV2ThemeById } = await import("./themes");

  for (const row of rows) {
    let config: V2AgentConfig;
    try {
      config = normalizeV2Config(row.simple_config);
    } catch {
      continue;
    }
    const inactivity = config.inactivity;
    // Pergunta pós-encerramento sem resposta: o atendimento anterior já foi
    // encerrado (com despedida); no prazo de encerramento, só fecha o ticket
    // novo — sem lembrete, sem mensagem, sem mexer no negócio.
    if (row.post_close_asked) {
      const closeAfter = inactivity?.closeAfter ?? 0;
      if (!closeAfter || now.getTime() - new Date(row.last_out_at).getTime() < closeAfter * MINUTE) continue;
      try {
        await withSystemContext(row.organization_id, () =>
          runWithV2Trace(async () => {
            traceStep("inatividade", `Pergunta pós-encerramento sem resposta há ${closeAfter} min → fecha o ticket sem mensagem`);
            await closeState(
              row.organization_id, row.conversation_id, row.agent_config_id, row.deal_id ?? undefined, config, undefined,
              "inactivity", row.contact_id, {}, getV2ThemeById(config, row.theme_id ?? undefined),
            );
            closed++;
            await logV2Turn({
              organizationId: row.organization_id,
              conversationId: row.conversation_id,
              agentId: row.agent_config_id,
              inboundText: "",
              crmContext: { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } },
              prompt: "inactivity",
              executedActions: [],
              discardedActions: [],
              handoff: false,
              closed: true,
              latencyMs: 0,
              inputTokens: 0,
              outputTokens: 0,
              owner: "agente",
              stage: "closed",
            });
          }),
        );
      } catch (err) {
        log.warn({ conv: row.conversation_id, err: err instanceof Error ? err.message : err }, "[ai-v2 inatividade] falhou");
      }
      continue;
    }
    const vars = buildVariableMap(config.variables, null, null, { id: row.contact_id, name: row.contact_name ?? "" });
    const progress = idleProgress(row, config);
    const decision = decideV2Idle({
      inactivity,
      anchorAt: progress.anchorAt,
      sent: progress.sent,
      lastFollowUpAt: progress.lastFollowUpAt,
      lastInboundAt: row.last_inbound_at ? new Date(row.last_inbound_at) : null,
      now,
    });
    if (decision.action === "none") continue;
    try {
      await withSystemContext(row.organization_id, () =>
        runWithV2Trace(async () => {
          const send = (text: string) =>
            sendV2TextMessage({
              conversationId: row.conversation_id,
              contactId: row.contact_id,
              agentUserId: row.assigned_to_id,
              text,
              channel: row.channel_kind,
              autonomyMode: autonomy(config),
              humanBehavior: v2HumanBehavior(config),
            });
          let reply: string | undefined;
          let lostMove: { stageId: string; lostReason?: string } | null = null;
          if (decision.action === "followup") {
            const step = followUpSteps(inactivity)[decision.index];
            const minutes = Math.round((now.getTime() - progress.anchorAt.getTime()) / MINUTE);
            const mode = step.mode ?? "fixed";
            let text = renderMessage(followUpFixedText(step, progress.kind), vars, defaultFormatter());
            if (mode === "generated") {
              const written = await writeFollowUp(config, row.agent_config_id, row.conversation_id);
              if (written) text = written;
              else traceStep("inatividade", "Lembrete escrito pelo agente indisponível ou com dado → texto padrão");
            }
            traceStep("inatividade", `Cliente sem responder há ${minutes} min → lembrete ${decision.index + 1} (${mode === "fixed" ? "texto fixo" : mode === "by_reply" ? "conforme a última mensagem" : "escrito pelo agente"})`);
            if ((await send(text)).sent) {
              reply = text;
              nudged++;
              await saveProgress(row, {
                anchorAt: progress.anchorAt.toISOString(),
                sent: decision.index + 1,
                kind: progress.kind,
              }, now);
            }
          } else {
            traceStep("inatividade", `Cliente sem responder há ${inactivity?.closeAfter} min → encerramento`);
            const closeText = inactivity?.closeMessage?.trim() ? renderMessage(inactivity.closeMessage, vars, defaultFormatter()) : "";
            const canText = !!row.last_inbound_at && now.getTime() - new Date(row.last_inbound_at).getTime() < WINDOW_24H;
            if (closeText && canText && (await send(closeText)).sent) reply = closeText;
            lostMove = await loseIdleDeal(config, row.deal_id, row.contact_id);
            if (lostMove) {
              traceStep("inatividade", `Negócio movido para perdido${lostMove.lostReason ? ` · motivo ${lostMove.lostReason}` : ""}`);
            }
            await closeState(
              row.organization_id, row.conversation_id, row.agent_config_id, row.deal_id ?? undefined, config, undefined,
              "inactivity", row.contact_id, {}, getV2ThemeById(config, row.theme_id ?? undefined),
            );
            closed++;
          }
          // Aparece no relatório de ações e nas conversas de teste.
          await logV2Turn({
            organizationId: row.organization_id,
            conversationId: row.conversation_id,
            agentId: row.agent_config_id,
            inboundText: "",
            crmContext: { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } },
            prompt: "inactivity",
            ...(reply ? { reply } : {}),
            executedActions: lostMove
              ? [{ action: { type: "move_stage", stageId: lostMove.stageId, ...(lostMove.lostReason ? { lostReason: lostMove.lostReason } : {}) }, ok: true }]
              : [],
            discardedActions: [],
            handoff: false,
            ...(decision.action === "close" ? { closed: true } : {}),
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            owner: "agente",
            stage: decision.action === "close" ? "closed" : "active",
          });
        }),
      );
    } catch (err) {
      log.warn(
        { conv: row.conversation_id, err: err instanceof Error ? err.message : err },
        "[ai-v2 inatividade] falhou",
      );
    }
  }
  if (nudged + closed > 0) log.info({ lembretes: nudged, encerradas: closed }, "[ai-v2 inatividade] resumo");
  return { nudged, closed };
}

/**
 * Grava quantos lembretes saíram e quando (a hora da mensagem enviada, para
 * a próxima passada reconhecer que a última mensagem é o lembrete).
 */
async function saveProgress(row: IdleRow, progress: { anchorAt: string; sent: number; kind: V2IdleKind }, now: Date): Promise<void> {
  if (!row.has_state || !db.$executeRawUnsafe) return;
  try {
    const last = await db.$queryRawUnsafe<Array<{ createdAt: Date }>>(
      `SELECT m."createdAt" FROM "messages" m WHERE m."conversationId" = $1 AND m."direction" = 'out' ORDER BY m."createdAt" DESC LIMIT 1`,
      row.conversation_id,
    );
    const lastAt = last?.[0]?.createdAt ? new Date(last[0].createdAt) : now;
    await db.$executeRawUnsafe(
      `UPDATE "ai_simple_conversation_states"
          SET "counters" = jsonb_set(COALESCE("counters", '{}'::jsonb), '{idleFollowUp}', $2::jsonb, true)
        WHERE "conversationId" = $1`,
      row.conversation_id,
      JSON.stringify({ ...progress, lastAt: lastAt.toISOString() }),
    );
  } catch (err) {
    log.warn({ conv: row.conversation_id, err: err instanceof Error ? err.message : err }, "[ai-v2 inatividade] não gravou o lembrete");
  }
}
