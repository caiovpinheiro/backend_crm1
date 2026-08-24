/**
 * Espelha ActivityEvent da conversa no chat (Message event:{action}).
 * Textos curtos — sem prefixo "Evento do sistema".
 */

import { prisma } from "@/lib/prisma";
import {
  formatHumanActorDisplayName,
  isGenericHumanEventActor,
  isReservedEventActorLabel,
} from "@/lib/human-actor-name";
import {
  createConversationEvent,
  type ConversationEventAction,
} from "@/services/conversation-events";

type MirrorInput = {
  type: string;
  entityType?: string;
  entityId?: string;
  conversationId?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  meta?: Record<string, unknown>;
  actor?: { type?: string; label?: string | null } | null;
  actorUserId?: string | null;
};

function statusLabel(raw: string | null | undefined): string {
  switch ((raw ?? "").toUpperCase()) {
    case "OPEN":
      return "Em atendimento";
    case "RESOLVED":
      return "Encerrada";
    case "PENDING":
      return "Pendente";
    case "SNOOZED":
      return "Adiada";
    default:
      return (raw ?? "").trim() || "atualizado";
  }
}

function stripDistributionSuffix(label: string): string {
  return label.replace(/\s*·\s*Distribuição.*$/i, "").trim() || label;
}

function actorTypeOf(input: MirrorInput): string {
  return (input.actor?.type ?? "").toUpperCase();
}

function isHumanActor(input: MirrorInput): boolean {
  const t = actorTypeOf(input);
  if (t === "HUMAN") return true;
  if (t === "AUTOMATION" || t === "AI" || t === "SYSTEM" || t === "INTEGRATION") {
    return false;
  }
  return Boolean(input.actorUserId);
}

async function resolveChatEventActor(input: MirrorInput): Promise<string> {
  const t = actorTypeOf(input);
  const rawLabel = stripDistributionSuffix(input.actor?.label?.trim() ?? "");

  if (t === "AUTOMATION" || t === "AI") {
    if (rawLabel && /ia/i.test(rawLabel)) return "Agente IA";
    return rawLabel || "Agente IA";
  }
  if (t === "SYSTEM" || t === "INTEGRATION") {
    if (rawLabel && !isGenericHumanEventActor(rawLabel)) return rawLabel;
    return "Sistema";
  }

  if (rawLabel && !isGenericHumanEventActor(rawLabel) && !isReservedEventActorLabel(rawLabel)) {
    const formatted = formatHumanActorDisplayName(rawLabel);
    if (formatted) return formatted;
  }

  if (input.actorUserId) {
    const user = await prisma.user.findUnique({
      where: { id: input.actorUserId },
      select: { name: true, email: true, type: true },
    });
    if (user?.type === "AI") return "Agente IA";
    const formatted = formatHumanActorDisplayName(user?.name, user?.email);
    if (formatted) return formatted;
  }

  if (rawLabel && !isGenericHumanEventActor(rawLabel)) return rawLabel;
  return "Agente";
}

function conversationIdOf(input: MirrorInput): string | null {
  if (input.conversationId) return input.conversationId;
  if (input.entityType === "CONVERSATION" && input.entityId) return input.entityId;
  return null;
}

function sameHumanName(actor: string, person: string): boolean {
  if (!actor || !person) return false;
  const a = actor.toLowerCase();
  const p = person.toLowerCase();
  if (a === p) return true;
  const actorShort = formatHumanActorDisplayName(actor).toLowerCase();
  const personShort = formatHumanActorDisplayName(person).toLowerCase();
  if (actorShort && personShort && actorShort === personShort) return true;
  if (actorShort && actorShort === p) return true;
  if (personShort && a === personShort) return true;
  return false;
}

/** Ação do próprio agente (entrou/saiu) vs. terceiro (distribuiu/removeu). */
function isSelfAssigneeAction(
  input: MirrorInput,
  actor: string,
  personName: string,
  personUserIdKey: "fromUserId" | "toUserId",
): boolean {
  const personId = input.meta?.[personUserIdKey];
  if (input.actorUserId && typeof personId === "string" && personId) {
    return input.actorUserId === personId;
  }
  return sameHumanName(actor, personName);
}

/** Ator de abrir/encerrar: nome humano, Sistema ou Automação — nunca aba/fila. */
function lifecycleActor(input: MirrorInput, actor: string): string {
  const t = actorTypeOf(input);
  if (t === "AUTOMATION" || t === "AI") return "Automação";
  if (t === "SYSTEM" || t === "INTEGRATION") return "Sistema";
  if (isGenericHumanEventActor(actor)) return "Sistema";
  const n = actor.trim().toLowerCase();
  if (n === "agente ia") return "Automação";
  return actor.trim() || "Sistema";
}

function conversationLabel(number: number | null | undefined): string {
  return typeof number === "number" && number > 0 ? `Conversa #${number}` : "Conversa";
}

function mapChatEvent(
  input: MirrorInput,
  actor: string,
  conversationNumber?: number | null,
): { action: ConversationEventAction; text: string; actor: string } | null {
  const type = input.type;
  const from = (input.oldValue ?? "").trim();
  const to = (input.newValue ?? "").trim();
  const meta = (input.meta ?? {}) as Record<string, unknown>;
  const dept =
    (typeof meta.toDepartmentName === "string" && meta.toDepartmentName) ||
    (typeof meta.departmentName === "string" && meta.departmentName) ||
    "";

  switch (type) {
    case "LEAD_DISTRIBUTED": {
      const who = to || actor;
      const dest = dept ? `${dept} → ${who}` : who;
      return {
        action: "distribuicao",
        text: dest ? `Conversa distribuída para ${dest}` : "Conversa distribuída",
        actor: /ia/i.test(actor) ? "Agente IA" : "Sistema",
      };
    }
    case "LEAD_DISTRIBUTION_FAILED":
      // Fila sem elegível: o sweeper reprocessa até alguém entrar.
      // Não espelhar no chat — gerava o mesmo evento a cada ciclo.
      return null;
    case "ASSIGNEE_CHANGED": {
      const fromShort = formatHumanActorDisplayName(from) || from;
      const toShort = formatHumanActorDisplayName(to) || to;
      if (from && to) {
        const dest = dept ? `${toShort} (${dept})` : toShort;
        return {
          action: "transferencia",
          text: `Transferida de ${fromShort} para ${dest}`,
          actor,
        };
      }
      if (!from && to) {
        if (isSelfAssigneeAction(input, actor, to, "toUserId")) {
          return {
            action: "entrada",
            text: `${toShort} entrou na conversa`,
            actor: toShort,
          };
        }
        return {
          action: "atribuicao",
          text: `Atribuída a ${toShort}`,
          actor: actor || "Sistema",
        };
      }
      if (from && !to) {
        if (isSelfAssigneeAction(input, actor, from, "fromUserId")) {
          return {
            action: "saida",
            text: `${fromShort} saiu da conversa`,
            actor: fromShort,
          };
        }
        return {
          action: "saida",
          text: `${fromShort} removida da conversa`,
          actor,
        };
      }
      return null;
    }
    case "CONVERSATION_DEPARTMENT_CHANGED": {
      if (from && to) {
        return {
          action: "transferencia",
          text: `Transferida de ${from} para ${to}`,
          actor,
        };
      }
      if (to) {
        return {
          action: "transferencia",
          text: `Transferida para ${to}`,
          actor,
        };
      }
      return null;
    }
    case "CONVERSATION_CREATED": {
      const who = lifecycleActor(input, actor);
      return {
        action: "entrada",
        text: `${conversationLabel(conversationNumber)} aberta`,
        actor: who,
      };
    }
    case "CONVERSATION_CLOSED": {
      const who = lifecycleActor(input, actor);
      return {
        action: "saida",
        text: `${conversationLabel(conversationNumber)} encerrada`,
        actor: who,
      };
    }
    case "CONVERSATION_REOPENED":
      // Reabrir cria ticket novo (CONVERSATION_CREATED). Não logar "aberta" no antigo.
      if (meta.newConversationId) return null;
      return {
        action: "entrada",
        text: `${conversationLabel(conversationNumber)} aberta`,
        actor: lifecycleActor(input, actor),
      };
    case "CONVERSATION_STATUS_CHANGED": {
      const dest = (to || "").toUpperCase();
      // Encerrar/abrir já têm CONVERSATION_CLOSED / CREATED / REOPENED.
      if (dest === "RESOLVED" || dest === "OPEN") return null;
      return {
        action: "status",
        text: `Status alterado para ${statusLabel(to || type)}`,
        actor,
      };
    }
    case "CONVERSATION_TABULATED": {
      const name =
        (typeof meta.tabulationName === "string" && meta.tabulationName) || to;
      return {
        action: "tabulacao",
        text: name ? `Conversa tabulada: ${name}` : "Conversa tabulada",
        actor,
      };
    }
    case "TAG_ADDED": {
      const name =
        (typeof meta.tagName === "string" && meta.tagName) || to || "tag";
      return { action: "tag", text: `Tag adicionada: ${name}`, actor };
    }
    case "TAG_REMOVED": {
      const name =
        (typeof meta.tagName === "string" && meta.tagName) || to || "tag";
      return { action: "tag", text: `Tag removida: ${name}`, actor };
    }
    case "AI_AGENT_HANDOFF":
      return {
        action: "ia",
        text: "Agente IA transferiu o atendimento",
        actor: "Agente IA",
      };
    default:
      return null;
  }
}

const CHAT_MIRROR_TYPES = new Set([
  "LEAD_DISTRIBUTED",
  "ASSIGNEE_CHANGED",
  "CONVERSATION_DEPARTMENT_CHANGED",
  "CONVERSATION_CREATED",
  "CONVERSATION_CLOSED",
  "CONVERSATION_REOPENED",
  "CONVERSATION_STATUS_CHANGED",
  "CONVERSATION_TABULATED",
  "TAG_ADDED",
  "TAG_REMOVED",
  "AI_AGENT_HANDOFF",
]);

/** Espelha no chat. Não lança. Await para o evento existir antes da resposta. */
export async function mirrorConversationChatEvent(
  input: MirrorInput,
): Promise<void> {
  const conversationId = conversationIdOf(input);
  if (!conversationId) return;
  if (!CHAT_MIRROR_TYPES.has(input.type)) return;

  try {
    const actor = await resolveChatEventActor(input);
    let conversationNumber: number | null = null;
    if (
      input.type === "CONVERSATION_CREATED" ||
      input.type === "CONVERSATION_CLOSED" ||
      input.type === "CONVERSATION_REOPENED" ||
      input.type === "CONVERSATION_STATUS_CHANGED"
    ) {
      const conv = await prisma.conversation
        .findUnique({
          where: { id: conversationId },
          select: { number: true },
        })
        .catch(() => null);
      conversationNumber = conv?.number ?? null;
    }
    const mapped = mapChatEvent(input, actor, conversationNumber);
    if (!mapped) return;

    const dedupeStartsWith =
      mapped.action === "distribuicao"
        ? [
            "Conversa distribuída",
            "Conversa enfileirada",
            "Enfileirada em",
            "Enfileirada —",
            "Aguardando consultor",
          ]
        : mapped.action === "ia"
          ? ["Agente IA sugeriu", "Agente IA transferiu", mapped.text.slice(0, 40)]
          : mapped.action === "entrada" && /aberta/.test(mapped.text)
            ? [mapped.text, "Conversa aberta", "Status alterado para Em atendimento"]
            : mapped.action === "saida" && /encerrada/.test(mapped.text)
              ? [mapped.text, "Conversa encerrada", "Status alterado para Encerrada"]
              : [mapped.text.slice(0, 40)];

    await createConversationEvent({
      conversationId,
      action: mapped.action,
      text: mapped.text,
      actor: mapped.actor,
      actorUserId: isHumanActor(input) ? input.actorUserId ?? null : null,
      authorType: mapped.actor === "Agente IA" ? "bot" : "system",
      dedupeStartsWith,
      dedupeWindowMs: mapped.action === "distribuicao" ? 120_000 : 20_000,
    });
  } catch {
    /* espelho não pode derrubar o log principal */
  }
}
