import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getCallPermissionTemplateName } from "@/lib/call-permission-env";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { classifyWhatsappCallEnd, wasWhatsappCallPickedUp } from "@/lib/whatsapp-call-chat";
import { repairWhatsappCallConsentFromMessages } from "@/services/whatsapp-call-consent-webhook";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/conversations/[id]/calling-context");

/**
 * Resolve o nome do template de Call Permission com fallback em cascata:
 *
 * 1. ENV (`META_WHATSAPP_CALL_PERMISSION_TEMPLATE`) — manda se estiver
 *    configurada (útil para overrides manuais no servidor).
 * 2. Banco (`WhatsAppTemplateConfig`) — qualquer registro cujo nome contenha
 *    `call_permission` (convenção da Meta para templates do tipo
 *    `CALL_PERMISSIONS_REQUEST`). Ordenado pelo mais recente para refletir
 *    atualizações de rótulo/liberação feitas em `/settings/whatsapp-templates`.
 *
 * Retorna `null` quando nada foi encontrado — o chip exibe "Voz indisponível"
 * e o agente vê orientação para cadastrar um template aprovado.
 */
async function resolveCallPermissionTemplate(): Promise<string | null> {
  const fromEnv = getCallPermissionTemplateName();
  if (fromEnv) return fromEnv;
  try {
    const cfg = await prisma.whatsAppTemplateConfig.findFirst({
      where: {
        metaTemplateName: { contains: "call_permission", mode: "insensitive" },
      },
      orderBy: { updatedAt: "desc" },
      select: { metaTemplateName: true },
    });
    return cfg?.metaTemplateName ?? null;
  } catch (e) {
    // Tabela ausente (migration antiga) ou erro transitório — degrada para env.
    log.warn(
      { err: e instanceof Error ? e.message : e },
      "[calling-context] resolveCallPermissionTemplate fallback",
    );
    return null;
  }
}

type RouteContext = { params: Promise<{ id: string }> };

function suggestFromText(content: string | null | undefined): boolean {
  if (!content) return false;
  const t = content.toLowerCase();
  return (
    /\bpode\s+(me\s+)?lig/.test(t) ||
    /\bliga(r|me)?\b/.test(t) ||
    /\bchamad\w*\b/.test(t) ||
    /\bfalar\s+por\s+(voz|telefone|liga)/.test(t) ||
    /\btelefon/.test(t)
  );
}

/**
 * Decide se a conversa tem uma chamada Meta ativa agora.
 *
 * Fontes de imprecisão que já observamos em produção:
 *  1. A Meta às vezes manda `terminate` com um `metaCallId` ligeiramente
 *     diferente do `connect` (prefixo `wacid.` vs numérico puro, etc.) — o
 *     match estrito por ID deixava o chip preso em "Em chamada".
 *  2. Perda de webhook de `terminate` (retries do lado deles, queda de rede)
 *     deixava um `connect` órfão mantendo a chamada ativa para sempre.
 *
 * Regras atuais (mais tolerantes):
 *  - Qualquer `terminate` encerra a chamada ativa, independente do ID.
 *  - Se o último evento é `terminate`, a chamada está encerrada.
 *  - Se o último `connect` tem mais de STALE_CONNECT_MS sem terminate, tratamos
 *    como encerrado (sanity fallback para webhook perdido).
 */
const STALE_CONNECT_MS = 30 * 60 * 1000;

function computeActiveCallId(
  events: {
    metaCallId: string;
    eventKind: string;
    signalingStatus?: string | null;
    createdAt: Date;
  }[],
): string | null {
  const asc = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let active: string | null = null;
  let activeSince: number | null = null;
  for (const e of asc) {
    const sig = (e.signalingStatus ?? "").toUpperCase();
    if (
      e.eventKind === "connect" ||
      (e.eventKind === "signaling" &&
        (sig === "INITIATED" || sig === "RINGING" || sig === "ACCEPTED"))
    ) {
      active = e.metaCallId;
      activeSince = e.createdAt.getTime();
    } else if (e.eventKind === "terminate" || sig === "REJECTED") {
      active = null;
      activeSince = null;
    }
  }
  if (active && activeSince && Date.now() - activeSince > STALE_CONNECT_MS) {
    return null;
  }
  return active;
}

type CallEvRow = {
  metaCallId: string;
  direction: string;
  eventKind: string;
  signalingStatus: string | null;
  terminateStatus: string | null;
  durationSec: number | null;
  createdAt: Date;
};

/** Uma linha por chamada (agrupa sinalização + connect + terminate). */
function buildCompactCallTimeline(events: CallEvRow[]): {
  at: string;
  kind: "call_event";
  label: string;
  metaCallId: string;
}[] {
  const byId = new Map<string, CallEvRow[]>();
  for (const e of events) {
    const list = byId.get(e.metaCallId) ?? [];
    list.push(e);
    byId.set(e.metaCallId, list);
  }
  const rows: { at: string; kind: "call_event"; label: string; metaCallId: string }[] = [];
  for (const [metaCallId, ge] of byId) {
    ge.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const connect = ge.find((x) => x.eventKind === "connect");
    const term = ge.find((x) => x.eventKind === "terminate");
    if (!connect && !term) continue;
    const dirFrom =
      connect?.direction ?? term?.direction ?? ge.find((x) => x.direction)?.direction ?? "UNKNOWN";
    const outbound = dirFrom === "BUSINESS_INITIATED";
    const arrow = outbound ? "Saída" : "Entrada";
    const t = connect?.createdAt ?? term!.createdAt;
    const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(t);
    let suffix = "";
    if (term) {
      const ds = term.durationSec;
      const durShort =
        ds != null && ds > 0
          ? ds >= 60
            ? `${Math.floor(ds / 60)}m${String(ds % 60).padStart(2, "0")}s`
            : `${ds}s`
          : "";
      const pickedUp = wasWhatsappCallPickedUp({
        durationSec: ds,
        signalingStatuses: ge.map((x) => x.signalingStatus),
      });
      const rejected = ge.some((x) => (x.signalingStatus ?? "").toUpperCase() === "REJECTED");
      const outcome = classifyWhatsappCallEnd({
        terminateStatus: term.terminateStatus ?? "",
        pickedUp,
        rejected,
      });
      if (outcome === "completed") suffix = durShort ? ` · ${durShort} · ok` : " · ok";
      else if (outcome === "failed") suffix = " · falhou";
      else suffix = " · não atendida";
    } else {
      suffix = " · ativa";
    }
    rows.push({
      at: t.toISOString(),
      metaCallId,
      kind: "call_event",
      label: `${arrow} · ${time}${suffix}`,
    });
  }
  rows.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return rows;
}

// Bug 27/abr/26: usavamos `auth()` direto. Consultas em conversation/
// whatsappCallEvent/whatsAppTemplateConfig dependem da Prisma extension
// multi-tenant, que exige RequestContext ativo. Migrado para withOrgContext.
export async function GET(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
   try {
    const { id } = await context.params;
    const denied = await requireConversationAccess(session, id);
    if (denied) return denied;

    const conv = await prisma.conversation.findUnique({
      where: { id },
      select: {
        channel: true,
        contactId: true,
        whatsappCallConsentStatus: true,
        whatsappCallConsentUpdatedAt: true,
      },
    });
    if (!conv) {
      return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
    }

    // Raw query para colunas novas (migration pode ainda não ter sido aplicada em todos os envs).
    // Defesa em profundidade: requireConversationAccess ja validou o id contra a org,
    // mas adicionamos organizationId aqui pra alinhar com RLS quando ativarmos.
    let consentType: "TEMPORARY" | "PERMANENT" | null = null;
    let consentExpiresAt: Date | null = null;
    try {
      const orgIdFilter = session.user.organizationId ?? "__no_org__";
      const rows = (await prisma.$queryRaw`
        SELECT
          "whatsappCallConsentType"::text AS "consentType",
          "whatsappCallConsentExpiresAt" AS "consentExpiresAt"
        FROM "conversations"
        WHERE "id" = ${id}
          AND "organizationId" = ${orgIdFilter}
      `) as Array<{ consentType: string | null; consentExpiresAt: Date | string | null }>;
      const row = rows[0];
      if (row) {
        consentType =
          row.consentType === "PERMANENT" || row.consentType === "TEMPORARY"
            ? row.consentType
            : null;
        consentExpiresAt = row.consentExpiresAt
          ? new Date(row.consentExpiresAt as Date | string)
          : null;
      }
    } catch (err) {
      // migration ainda não rodou — segue sem os campos novos (cliente cai no fallback 7d)
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[calling-context] type/expiresAt ausente (migration pendente)",
      );
    }

    // Timeline com "✅ Cliente aceitou" mas coluna ainda REQUESTED/NONE
    // (reenvio de template zerava o opt-in; webhook duplicado pulava o grant).
    if (conv.channel === "whatsapp") {
      try {
        const repaired = await repairWhatsappCallConsentFromMessages(id);
        if (repaired) {
          const fresh = await prisma.conversation.findUnique({
            where: { id },
            select: {
              whatsappCallConsentStatus: true,
              whatsappCallConsentUpdatedAt: true,
            },
          });
          if (fresh) {
            conv.whatsappCallConsentStatus = fresh.whatsappCallConsentStatus;
            conv.whatsappCallConsentUpdatedAt = fresh.whatsappCallConsentUpdatedAt;
          }
          try {
            const orgIdFilter = session.user.organizationId ?? "__no_org__";
            const rows = (await prisma.$queryRaw`
              SELECT
                "whatsappCallConsentType"::text AS "consentType",
                "whatsappCallConsentExpiresAt" AS "consentExpiresAt"
              FROM "conversations"
              WHERE "id" = ${id}
                AND "organizationId" = ${orgIdFilter}
            `) as Array<{ consentType: string | null; consentExpiresAt: Date | string | null }>;
            const row = rows[0];
            if (row) {
              consentType =
                row.consentType === "PERMANENT" || row.consentType === "TEMPORARY"
                  ? row.consentType
                  : null;
              consentExpiresAt = row.consentExpiresAt
                ? new Date(row.consentExpiresAt as Date | string)
                : null;
            }
          } catch {
            /* segue com o que já tínhamos */
          }
        }
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          "[calling-context] repair consent",
        );
      }
    }

    // Consentimento é do contato (Meta), não do ticket. Ticket resolvido
    // vizinho pode ter GRANTED enquanto este ainda está NONE.
    if (
      conv.channel === "whatsapp" &&
      conv.contactId &&
      conv.whatsappCallConsentStatus !== "GRANTED"
    ) {
      const sibling = await prisma.conversation.findFirst({
        where: {
          contactId: conv.contactId,
          channel: "whatsapp",
          whatsappCallConsentStatus: "GRANTED",
          id: { not: id },
        },
        orderBy: { whatsappCallConsentUpdatedAt: "desc" },
        select: {
          id: true,
          whatsappCallConsentStatus: true,
          whatsappCallConsentUpdatedAt: true,
        },
      });
      if (sibling) {
        conv.whatsappCallConsentStatus = sibling.whatsappCallConsentStatus;
        conv.whatsappCallConsentUpdatedAt = sibling.whatsappCallConsentUpdatedAt;
        try {
          const orgIdFilter = session.user.organizationId ?? "__no_org__";
          const rows = (await prisma.$queryRaw`
            SELECT
              "whatsappCallConsentType"::text AS "consentType",
              "whatsappCallConsentExpiresAt" AS "consentExpiresAt"
            FROM "conversations"
            WHERE "id" = ${sibling.id}
              AND "organizationId" = ${orgIdFilter}
          `) as Array<{ consentType: string | null; consentExpiresAt: Date | string | null }>;
          const row = rows[0];
          if (row) {
            consentType =
              row.consentType === "PERMANENT" || row.consentType === "TEMPORARY"
                ? row.consentType
                : null;
            consentExpiresAt = row.consentExpiresAt
              ? new Date(row.consentExpiresAt as Date | string)
              : null;
          }
        } catch {
          /* segue com fallback 7d */
        }
      }
    }

    if (conv.channel !== "whatsapp") {
      const templateName = await resolveCallPermissionTemplate();
      return NextResponse.json({
        channel: conv.channel,
        consentStatus: null,
        consentUpdatedAt: null,
        consentType: null,
        consentExpiresAt: null,
        permissionTemplateConfigured: !!templateName,
        envCallPermissionTemplate: templateName,
        activeCallMetaId: null,
        suggestCallPermission: false,
        timeline: [],
      });
    }

    const [events, lastInbound] = await Promise.all([
      prisma.whatsappCallEvent.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "desc" },
        take: 60,
        select: {
          metaCallId: true,
          direction: true,
          eventKind: true,
          signalingStatus: true,
          terminateStatus: true,
          durationSec: true,
          createdAt: true,
        },
      }),
      prisma.message.findFirst({
        where: { conversationId: id, direction: "in" },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      }),
    ]);

    const activeCallMetaId = computeActiveCallId(events);

    const timeline: {
      at: string;
      kind: "call_event" | "consent";
      label: string;
      metaCallId?: string;
    }[] = buildCompactCallTimeline(events);

    if (conv.whatsappCallConsentUpdatedAt) {
      timeline.push({
        at: conv.whatsappCallConsentUpdatedAt.toISOString(),
        kind: "consent",
        label:
          conv.whatsappCallConsentStatus === "REQUESTED"
            ? "Opt-in · pedido enviado"
            : conv.whatsappCallConsentStatus === "GRANTED"
              ? "Opt-in · permitido"
              : conv.whatsappCallConsentStatus === "EXPIRED"
                ? "Opt-in · expirado"
                : conv.whatsappCallConsentStatus === "DENIED"
                  ? "Opt-in · recusado"
                  : "Opt-in · atualizado",
      });
      timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    }

    const templateName = await resolveCallPermissionTemplate();

    return NextResponse.json({
      channel: conv.channel,
      consentStatus: conv.whatsappCallConsentStatus,
      consentUpdatedAt: conv.whatsappCallConsentUpdatedAt?.toISOString() ?? null,
      consentType,
      consentExpiresAt: consentExpiresAt?.toISOString() ?? null,
      permissionTemplateConfigured: !!templateName,
      envCallPermissionTemplate: templateName,
      activeCallMetaId,
      suggestCallPermission:
        conv.whatsappCallConsentStatus === "NONE" && suggestFromText(lastInbound?.content),
      timeline,
    });
   } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao carregar contexto de chamada." }, { status: 500 });
   }
  });
}
