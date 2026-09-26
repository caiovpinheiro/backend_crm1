/**
 * Inatividade do cliente no agente v2 ("Começo e fim › Cliente sem
 * responder"): depois da última mensagem do agente, um aviso opcional e o
 * encerramento. O worker de inatividade do v1 ignora agentes v2 de
 * propósito; sem isto a config existia e nada acontecia — "encerro em 30
 * minutos" e o atendimento seguia aberto.
 * Nenhum domínio de cliente.
 */

import { prismaBase } from "@/lib/prisma-base";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import { buildVariableMap, defaultFormatter, renderMessage } from "@/lib/ai-v2/message-render";
import type { V2AgentConfig, V2InactivityConfig } from "@/lib/ai-v2/types";

export const NUDGE_MESSAGE_DEFAULT = "Ainda está por aí? Se precisar de algo, é só me responder.";

const MINUTE = 60 * 1000;
const WINDOW_24H = 24 * 60 * MINUTE;

export type V2IdleDecision = "nudge" | "close" | "none";

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * O que fazer com a conversa parada. Prazos em minutos desde a última
 * mensagem do agente; depois do aviso, o encerramento conta do aviso o que
 * falta (closeAfter − nudgeAfter). Fora da janela de 24h do WhatsApp não há
 * aviso (a Meta não entrega), só o encerramento.
 */
export function decideV2Idle(args: {
  inactivity: V2InactivityConfig | undefined;
  lastOutAt: Date;
  lastOutText: string | null;
  /** Aviso como foi enviado (já com as variáveis). */
  nudgeText: string;
  lastInboundAt: Date | null;
  now: Date;
}): V2IdleDecision {
  const cfg = args.inactivity;
  if (!cfg?.enabled) return "none";
  const closeAfter = Math.max(0, cfg.closeAfter ?? 0);
  const nudgeAfter = Math.max(0, cfg.nudgeAfter ?? 0);
  const useNudge = nudgeAfter > 0 && (closeAfter === 0 || nudgeAfter < closeAfter);
  const age = (args.now.getTime() - args.lastOutAt.getTime()) / MINUTE;
  const lastIsNudge = useNudge && !!args.lastOutText && fold(args.lastOutText) === fold(args.nudgeText);
  if (lastIsNudge) return closeAfter > 0 && age >= Math.max(1, closeAfter - nudgeAfter) ? "close" : "none";
  if (closeAfter > 0 && age >= closeAfter) return "close";
  const canText = !!args.lastInboundAt && args.now.getTime() - args.lastInboundAt.getTime() < WINDOW_24H;
  if (useNudge && age >= nudgeAfter && canText) return "nudge";
  return "none";
}

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
};

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
};

/**
 * Conversas de agentes v2 com inatividade ligada, abertas, sem resposta de
 * pessoa, com o agente como último a falar e já no prazo mínimo (o menor
 * entre aviso e encerramento). Fica de fora quem está na fila ou encerrado.
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
            c."lastInboundAt" AS last_inbound_at
       FROM "conversations" c
       JOIN "users" u ON u."id" = c."assignedToId" AND u."type" = 'AI'
       JOIN "ai_agent_configs" a ON a."userId" = u."id" AND a."active" = true AND a."engine" = 'simple'
       LEFT JOIN "contacts" ct ON ct."id" = c."contactId"
       LEFT JOIN "channels" ch ON ch."id" = c."channelId"
       LEFT JOIN "ai_simple_conversation_states" s ON s."conversationId" = c."id"
       JOIN LATERAL (
         SELECT m."content", m."createdAt" FROM "messages" m
          WHERE m."conversationId" = c."id" AND m."direction" = 'out'
            AND COALESCE(m."isPrivate", false) = false AND m."messageType" <> 'note'
          ORDER BY m."createdAt" DESC LIMIT 1
       ) last_out ON true
      WHERE c."status" = 'OPEN'
        AND c."hasHumanReply" = false
        AND (a."simpleConfig"->'inactivity'->>'enabled') = 'true'
        AND (s."id" IS NULL OR (s."owner" <> 'pessoa' AND s."stage" <> 'closed'))
        AND (c."lastInboundAt" IS NULL OR c."lastInboundAt" <= last_out."createdAt")
        AND last_out."createdAt" < $1::timestamptz - make_interval(mins => LEAST(
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

/** Uma passada: avisa e encerra o que venceu. */
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
    const vars = buildVariableMap(config.variables, null, null, { id: row.contact_id, name: row.contact_name ?? "" });
    const nudgeText = renderMessage(inactivity?.nudgeMessage?.trim() || NUDGE_MESSAGE_DEFAULT, vars, defaultFormatter());
    const decision = decideV2Idle({
      inactivity,
      lastOutAt: new Date(row.last_out_at),
      lastOutText: row.last_out_content,
      nudgeText,
      lastInboundAt: row.last_inbound_at ? new Date(row.last_inbound_at) : null,
      now,
    });
    if (decision === "none") continue;
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
          if (decision === "nudge") {
            traceStep("inatividade", `Cliente sem responder há ${inactivity?.nudgeAfter} min → aviso`);
            if ((await send(nudgeText)).sent) {
              reply = nudgeText;
              nudged++;
            }
          } else {
            traceStep("inatividade", `Cliente sem responder há ${inactivity?.closeAfter} min → encerramento`);
            const closeText = inactivity?.closeMessage?.trim() ? renderMessage(inactivity.closeMessage, vars, defaultFormatter()) : "";
            const canText = !!row.last_inbound_at && now.getTime() - new Date(row.last_inbound_at).getTime() < WINDOW_24H;
            if (closeText && canText && (await send(closeText)).sent) reply = closeText;
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
            executedActions: [],
            discardedActions: [],
            handoff: false,
            ...(decision === "close" ? { closed: true } : {}),
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            owner: "agente",
            stage: decision === "close" ? "closed" : "active",
          });
        }),
      );
    } catch (err) {
      console.warn(`[ai-v2 inatividade] conv=${row.conversation_id}:`, err instanceof Error ? err.message : err);
    }
  }
  if (nudged + closed > 0) console.info(`[ai-v2 inatividade] avisos=${nudged} encerradas=${closed}`);
  return { nudged, closed };
}
