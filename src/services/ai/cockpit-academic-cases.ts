/**
 * Lista de casos por KPI do cockpit acadêmico (hoje, fuso SP).
 * Mesmos filtros das contagens em `cockpit-academic.ts`.
 */

import { prismaBase } from "@/lib/prisma-base";
import { IDLE_NUDGE_SIGNATURE } from "@/services/ai/idle-followup";

import { classifyCloseReason } from "@/services/ai/cockpit-academic";

export const ACADEMIC_CASE_KEYS = [
  "spoke_today",
  "attending_now",
  "resolved_solo",
  "closed_by_ai",
  "closed_by_idle",
  "closed_by_student",
  "idle_nudges",
  "returned_after_close",
  "send_failed",
  "handoff_today",
  "handoff_assigned",
  "channel_academic",
  "channel_other",
  "lead_entrada_open",
  "lead_entrada_ai",
] as const;

export type AcademicCaseKey = (typeof ACADEMIC_CASE_KEYS)[number];

export type AcademicCockpitCase = {
  conversationId: string;
  conversationNumber: number | null;
  contactName: string;
  phone: string | null;
};

const LIMIT = 80;

function isCaseKey(v: string): v is AcademicCaseKey {
  return (ACADEMIC_CASE_KEYS as readonly string[]).includes(v);
}

function startOfTodaySaoPaulo(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = parts.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 3, 0, 0));
}

type RawCase = {
  conversation_id: string;
  conversation_number: number | null;
  contact_name: string | null;
  phone: string | null;
};

function mapRows(rows: RawCase[]): AcademicCockpitCase[] {
  const seen = new Set<string>();
  const out: AcademicCockpitCase[] = [];
  for (const r of rows) {
    if (!r.conversation_id || seen.has(r.conversation_id)) continue;
    seen.add(r.conversation_id);
    out.push({
      conversationId: r.conversation_id,
      conversationNumber:
        r.conversation_number == null ? null : Number(r.conversation_number),
      contactName: (r.contact_name ?? "").trim() || "Sem nome",
      phone: r.phone?.trim() || null,
    });
    if (out.length >= LIMIT) break;
  }
  return out;
}

export async function getAcademicCockpitCases(args: {
  organizationId: string;
  key: string;
}): Promise<{ key: AcademicCaseKey; title: string; cases: AcademicCockpitCase[] }> {
  if (!isCaseKey(args.key)) {
    throw Object.assign(new Error("KPI inválido"), { status: 400 });
  }
  const orgId = args.organizationId;
  const since = startOfTodaySaoPaulo();
  const key = args.key;

  let rows: RawCase[] = [];

  switch (key) {
    case "spoke_today":
      rows = await prismaBase.$queryRaw<RawCase[]>`
        SELECT DISTINCT ON (c.id)
          c.id AS conversation_id,
          c.number AS conversation_number,
          ct.name AS contact_name,
          ct.phone
        FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        LEFT JOIN contacts ct ON ct.id = c."contactId"
        WHERE c."organizationId" = ${orgId}
          AND m."authorType" = 'bot'
          AND COALESCE(m."isPrivate", false) = false
          AND m."createdAt" >= ${since}
        ORDER BY c.id, m."createdAt" DESC
        LIMIT ${LIMIT}
      `;
      break;

    case "attending_now":
      rows = await prismaBase.$queryRaw<RawCase[]>`
        SELECT
          c.id AS conversation_id,
          c.number AS conversation_number,
          ct.name AS contact_name,
          ct.phone
        FROM conversations c
        JOIN users u ON u.id = c."assignedToId"
        LEFT JOIN contacts ct ON ct.id = c."contactId"
        WHERE c."organizationId" = ${orgId}
          AND c.status = 'OPEN'
          AND u.type = 'AI'
        ORDER BY c."updatedAt" DESC
        LIMIT ${LIMIT}
      `;
      break;

    case "resolved_solo":
    case "closed_by_ai":
    case "closed_by_idle":
    case "closed_by_student": {
      const events = await prismaBase.$queryRaw<
        {
          conversation_id: string | null;
          conversation_number: number | null;
          contact_name: string | null;
          phone: string | null;
          reason: string | null;
        }[]
      >`
        SELECT
          COALESCE(ae."conversationId", c.id) AS conversation_id,
          c.number AS conversation_number,
          ct.name AS contact_name,
          ct.phone,
          COALESCE(ae.meta->>'reason', '') AS reason
        FROM activity_events ae
        LEFT JOIN conversations c ON c.id = ae."conversationId"
        LEFT JOIN contacts ct ON ct.id = COALESCE(ae."contactId", c."contactId")
        WHERE ae."organizationId" = ${orgId}
          AND ae.type = 'CONVERSATION_CLOSED'
          AND ae."occurredAt" >= ${since}
          AND COALESCE(ae.meta->>'action', '') = 'ai_close'
        ORDER BY ae."occurredAt" DESC
        LIMIT 300
      `;
      const want =
        key === "closed_by_idle"
          ? "idle"
          : key === "closed_by_student"
            ? "student"
            : null;
      rows = events
        .filter((e) => (want ? classifyCloseReason(e.reason) === want : true))
        .map((e) => ({
          conversation_id: e.conversation_id ?? "",
          conversation_number: e.conversation_number,
          contact_name: e.contact_name,
          phone: e.phone,
        }));
      break;
    }

    case "idle_nudges":
      rows = await prismaBase.$queryRaw<RawCase[]>`
        SELECT DISTINCT ON (c.id)
          c.id AS conversation_id,
          c.number AS conversation_number,
          ct.name AS contact_name,
          ct.phone
        FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        LEFT JOIN contacts ct ON ct.id = c."contactId"
        WHERE c."organizationId" = ${orgId}
          AND m.direction = 'out'
          AND m."authorType" = 'bot'
          AND m."createdAt" >= ${since}
          AND m.content ILIKE ${"%" + IDLE_NUDGE_SIGNATURE + "%"}
        ORDER BY c.id, m."createdAt" DESC
        LIMIT ${LIMIT}
      `;
      break;

    case "returned_after_close":
      rows = await prismaBase.$queryRaw<RawCase[]>`
        SELECT DISTINCT ON (c2."contactId")
          c2.id AS conversation_id,
          c2.number AS conversation_number,
          ct.name AS contact_name,
          ct.phone
        FROM activity_events ae
        JOIN conversations c2
          ON c2."contactId" = ae."contactId"
         AND c2."organizationId" = ae."organizationId"
         AND c2."createdAt" > ae."occurredAt"
        LEFT JOIN contacts ct ON ct.id = c2."contactId"
        WHERE ae."organizationId" = ${orgId}
          AND ae.type = 'CONVERSATION_CLOSED'
          AND ae."occurredAt" >= ${since}
          AND COALESCE(ae.meta->>'action', '') = 'ai_close'
          AND ae."contactId" IS NOT NULL
        ORDER BY c2."contactId", c2."createdAt" DESC
        LIMIT ${LIMIT}
      `;
      break;

    case "send_failed":
      rows = await prismaBase.$queryRaw<RawCase[]>`
        SELECT DISTINCT ON (c.id)
          c.id AS conversation_id,
          c.number AS conversation_number,
          ct.name AS contact_name,
          ct.phone
        FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        LEFT JOIN contacts ct ON ct.id = c."contactId"
        WHERE c."organizationId" = ${orgId}
          AND m.direction = 'out'
          AND m."authorType" = 'bot'
          AND m."createdAt" >= ${since}
          AND m."sendStatus" IN ('failed', 'error', 'FAILED', 'ERROR')
        ORDER BY c.id, m."createdAt" DESC
        LIMIT ${LIMIT}
      `;
      break;

    case "handoff_today":
    case "handoff_assigned":
      rows = await prismaBase.$queryRaw<RawCase[]>`
        SELECT DISTINCT ON (COALESCE(l."conversationId", l."contactId"))
          COALESCE(l."conversationId", c.id) AS conversation_id,
          c.number AS conversation_number,
          ct.name AS contact_name,
          ct.phone
        FROM distribution_logs l
        LEFT JOIN conversations c ON c.id = l."conversationId"
        LEFT JOIN contacts ct ON ct.id = COALESCE(l."contactId", c."contactId")
        WHERE l."organizationId" = ${orgId}
          AND l.success = true
          AND l."createdAt" >= ${since}
          AND l."triggerSource" ILIKE '%AI_AGENT%'
          AND (${key} <> 'handoff_assigned' OR l.reason = 'ASSIGNED')
        ORDER BY COALESCE(l."conversationId", l."contactId"), l."createdAt" DESC
        LIMIT ${LIMIT}
      `;
      break;

    case "channel_academic":
    case "channel_other":
      rows = await prismaBase.$queryRaw<RawCase[]>`
        SELECT DISTINCT ON (c.id)
          c.id AS conversation_id,
          c.number AS conversation_number,
          ct.name AS contact_name,
          ct.phone
        FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        LEFT JOIN channels ch ON ch.id = COALESCE(m."channelId", c."channelId")
        LEFT JOIN contacts ct ON ct.id = c."contactId"
        WHERE c."organizationId" = ${orgId}
          AND m."authorType" = 'bot'
          AND COALESCE(m."isPrivate", false) = false
          AND m."createdAt" >= ${since}
          AND (
            (${key} = 'channel_academic' AND COALESCE(ch.name, '') ILIKE '%acad%')
            OR (${key} = 'channel_other' AND COALESCE(ch.name, '') NOT ILIKE '%acad%')
          )
        ORDER BY c.id, m."createdAt" DESC
        LIMIT ${LIMIT}
      `;
      break;

    case "lead_entrada_open":
    case "lead_entrada_ai":
      rows = await prismaBase.$queryRaw<RawCase[]>`
        SELECT DISTINCT ON (d."contactId")
          c.id AS conversation_id,
          c.number AS conversation_number,
          ct.name AS contact_name,
          ct.phone
        FROM deals d
        JOIN stages st ON st.id = d."stageId"
        LEFT JOIN conversations c
          ON c."contactId" = d."contactId"
         AND c.status = 'OPEN'
        LEFT JOIN users u ON u.id = c."assignedToId"
        LEFT JOIN contacts ct ON ct.id = d."contactId"
        WHERE d."organizationId" = ${orgId}
          AND d.status = 'OPEN'
          AND (st.slug = 'lead-de-entrada' OR st.name ILIKE 'lead de entrada')
          AND (${key} <> 'lead_entrada_ai' OR u.type = 'AI')
        ORDER BY d."contactId", c."updatedAt" DESC NULLS LAST
        LIMIT ${LIMIT}
      `;
      break;
  }

  return {
    key,
    title: key,
    cases: mapRows(rows),
  };
}
