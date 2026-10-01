import { Prisma } from "@prisma/client";

import { enqueueAutomationJob } from "@/lib/queue";
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import {
  buildSessionExpiryClaimKey,
  getSessionExpiryWindow,
  normalizeHoursBeforeExpiry,
  WHATSAPP_SESSION_WINDOW_MS,
} from "@/services/whatsapp-session-expiry";
import { getLogger } from "@/lib/logger";

const log = getLogger("whatsapp-session-expiry-sweeper");

const INTERVAL_MS =
  Number(process.env.AUTOMATION_SESSION_EXPIRY_INTERVAL_MS) || 60_000;
let started = false;

type SessionCandidate = {
  organizationId: string;
  conversationId: string;
  contactId: string;
  channel: string;
  channelId: string | null;
  lastInboundAt: Date;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export function startWhatsappSessionExpirySweeper(): void {
  if (started || process.env.AUTOMATION_SESSION_EXPIRY_SWEEPER === "0") return;
  started = true;

  const tick = () => {
    void sweepWhatsappSessionExpiryTriggers().catch((error) => {
      log.warn(
        { err: error instanceof Error ? error.message : error },
        "[whatsapp-session-expiry] tick falhou",
      );
    });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS);
  }, 20_000);
  log.info({ tickMs: INTERVAL_MS }, "[whatsapp-session-expiry] sweeper iniciado");
}

export async function sweepWhatsappSessionExpiryTriggers(
  now = new Date(),
): Promise<{ candidates: number; claimed: number }> {
  const automations = await prismaBase.automation.findMany({
    where: { active: true, triggerType: "whatsapp_session_expiring" },
    select: {
      id: true,
      organizationId: true,
      triggerConfig: true,
    },
  });
  const configured = automations
    .map((automation) => {
      const cfg =
        automation.triggerConfig &&
        typeof automation.triggerConfig === "object" &&
        !Array.isArray(automation.triggerConfig)
          ? (automation.triggerConfig as Record<string, unknown>)
          : {};
      return {
        ...automation,
        hoursBeforeExpiry: normalizeHoursBeforeExpiry(cfg.hoursBeforeExpiry),
      };
    })
    .filter(
      (
        automation,
      ): automation is typeof automation & { hoursBeforeExpiry: number } =>
        automation.hoursBeforeExpiry !== null,
    );
  if (configured.length === 0) return { candidates: 0, claimed: 0 };

  const maxHours = Math.max(...configured.map((a) => a.hoursBeforeExpiry));
  const oldestInbound = new Date(now.getTime() - WHATSAPP_SESSION_WINDOW_MS);
  const newestInbound = new Date(
    oldestInbound.getTime() + maxHours * 60 * 60 * 1000,
  );
  const organizationIds = [...new Set(configured.map((a) => a.organizationId))];

  // A sessão atual do produto é por contato + tipo de canal, atravessando
  // tickets. O LATERAL escolhe o ticket Meta mais recente para o contexto.
  //
  // Só as orgs com automação configurada entram, e o corte inferior fica no
  // WHERE (índice `messages(createdAt)`): antes ele estava só no HAVING e o
  // Postgres agregava todas as mensagens de entrada de todas as orgs a cada
  // minuto. Filtrar `m."createdAt" > oldest` antes do GROUP BY dá o mesmo
  // resultado — o MAX de um grupo é > oldest exatamente quando o grupo tem
  // alguma linha > oldest, e nesse caso o MAX das linhas filtradas é o
  // mesmo MAX. O corte superior continua no HAVING: filtrá-lo no WHERE
  // esconderia um inbound mais novo e faria a sessão parecer expirável.
  const candidates = await prismaBase.$queryRaw<SessionCandidate[]>(Prisma.sql`
    WITH sessions AS (
      SELECT
        c."organizationId",
        c."contactId",
        c."channel",
        MAX(m."createdAt") AS "lastInboundAt"
      FROM "conversations" c
      JOIN "messages" m
        ON m."conversationId" = c."id"
       AND m."direction" = 'in'
       AND m."createdAt" > ${oldestInbound}
      WHERE c."organizationId" IN (${Prisma.join(organizationIds)})
        AND c."contactId" IS NOT NULL
        AND LOWER(c."channel") IN ('whatsapp', 'whatsapp_meta', 'meta_whatsapp')
      GROUP BY c."organizationId", c."contactId", c."channel"
      HAVING MAX(m."createdAt") <= ${newestInbound}
    )
    SELECT
      s."organizationId",
      rep."id" AS "conversationId",
      s."contactId",
      s."channel",
      rep."channelId",
      s."lastInboundAt"
    FROM sessions s
    JOIN LATERAL (
      SELECT c2."id", c2."channelId"
      FROM "conversations" c2
      JOIN "channels" ch
        ON ch."id" = c2."channelId"
       AND ch."provider" = 'META_CLOUD_API'
      WHERE c2."organizationId" = s."organizationId"
        AND c2."contactId" = s."contactId"
        AND c2."channel" = s."channel"
      ORDER BY (c2."status" <> 'RESOLVED') DESC, c2."updatedAt" DESC
      LIMIT 1
    ) rep ON TRUE
  `);

  let claimed = 0;
  for (const automation of configured) {
    for (const candidate of candidates) {
      if (candidate.organizationId !== automation.organizationId) continue;
      const window = getSessionExpiryWindow(
        candidate.lastInboundAt,
        automation.hoursBeforeExpiry,
        now,
      );
      if (!window) continue;

      try {
        await prismaBase.automationSessionExpiryClaim.create({
          data: {
            id: buildSessionExpiryClaimKey(
              automation.id,
              candidate.contactId,
              candidate.channel,
              window.lastInboundAt,
            ),
            organizationId: candidate.organizationId,
            automationId: automation.id,
            contactId: candidate.contactId,
            channel: candidate.channel,
            conversationId: candidate.conversationId,
            windowStartedAt: window.lastInboundAt,
            sessionExpiresAt: window.sessionExpiresAt,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }

      claimed++;
      await withSystemContext(candidate.organizationId, () =>
        enqueueAutomationJob({
          automationId: automation.id,
          context: {
            event: "whatsapp_session_expiring",
            contactId: candidate.contactId,
            data: {
              conversationId: candidate.conversationId,
              channel: candidate.channel,
              channelId: candidate.channelId,
              lastInboundAt: window.lastInboundAt.toISOString(),
              sessionExpiresAt: window.sessionExpiresAt.toISOString(),
              hoursBeforeExpiry: automation.hoursBeforeExpiry,
            },
          },
        }),
      );
    }
  }
  return { candidates: candidates.length, claimed };
}
