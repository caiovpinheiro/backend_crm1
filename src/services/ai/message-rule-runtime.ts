/**
 * Execução do próximo passo declarado pelo operador em
 * `inboxPolicy.messageRules`.
 *
 * Avaliação e execução são CÓDIGO: nada aqui pede opinião ao modelo. O
 * handoff usa a capacidade genérica (`executeDepartmentHandoff`), então
 * agente sem `verticalPack` transfere igual — o pack, quando existe, só
 * refina departamento/roster.
 */

import type { MessageRuleHit } from "@/lib/ai-agents/message-rules";
import type { InboxPolicy } from "@/lib/ai-agents/steering";
import { prisma } from "@/lib/prisma";
import { executeDepartmentHandoff } from "@/services/ai/department-handoff";
import { triggerAgentOpeningForContact } from "@/services/ai/piloting-actions";
import {
  assignOwnerToContactClusterTx,
  invalidateBoardsForPipelines,
} from "@/services/deals";
import { addTagToContact } from "@/services/tags";
import type { VerticalPackOps } from "@/verticals/types";

export type MessageRuleOutcome =
  /// O turno segue para o modelo (base de conhecimento). Interceptos
  /// determinísticos NÃO rodam — a regra do operador já decidiu.
  | { kind: "answer_with_knowledge" }
  /// Destino da regra é inválido (id sumido no clone, outro tenant). Não
  /// engole o turno: o handler segue como se a regra não tivesse casado.
  | { kind: "continue" }
  /// A regra resolveu o turno. `interceptName` vai para o run de auditoria.
  | { kind: "handled"; interceptName: string; departmentName?: string | null };

export type MessageRuleDeps = {
  conversationId: string;
  contactId: string | null;
  dealId?: string | null;
  /// Coordenador não consome o turno com assign_owner — o modelo roteia.
  archetype?: string | null;
  policy: InboxPolicy;
  ops?: VerticalPackOps | null;
  /// Envia o aviso ao cliente (o handler sabe typing, delay, generationId).
  sendNotice: (text: string) => Promise<void>;
  /// Texto padrão de fila do agente, quando a regra não traz mensagem.
  /// Recebe o departamento resolvido para o handler escolher a cópia.
  defaultQueueText: (args: {
    departmentName: string | null;
  }) => Promise<string> | string;
};

/**
 * Marca a tag no contato, o que dispara as automações de `tag_added` via
 * `notifyTagAdded`.
 *
 * NÃO cria tag que não existe: tag inventada não é gatilho de automação
 * nenhuma, e o operador ficaria com uma regra que "roda" sem efeito algum.
 * Tag já aplicada também não reaplica — o `tag_added` dispararia de novo a
 * cada mensagem que casasse com a regra.
 *
 * Falha não interrompe o turno: a regra já decidiu o próximo passo, e
 * derrubar o atendimento porque uma tag não existe é pior do que seguir.
 */
async function applyRuleTag(
  tagName: string | null,
  contactId: string | null,
): Promise<void> {
  if (!tagName || !contactId) return;
  try {
    const tag = await prisma.tag.findFirst({
      where: { name: { equals: tagName, mode: "insensitive" } },
      select: { id: true },
    });
    if (!tag) {
      console.error(
        `[ai] regra de mensagem: tag "${tagName}" não existe no CRM — crie a tag antes de usá-la na regra.`,
      );
      return;
    }
    const already = await prisma.tagOnContact.findFirst({
      where: { contactId, tagId: tag.id },
      select: { contactId: true },
    });
    if (already) return;
    await addTagToContact(contactId, tag.id);
  } catch (err) {
    console.error("[ai] regra de mensagem: falha ao marcar tag", err);
  }
}

export async function executeMessageRule(
  hit: MessageRuleHit,
  deps: MessageRuleDeps,
): Promise<MessageRuleOutcome> {
  const { rule } = hit;
  // Tag é campo da regra, não o próximo passo: vale junto de atender,
  // transferir ou atribuir responsável.
  await applyRuleTag(rule.tagName, deps.contactId);

  if (
    deps.archetype === "COORDENADOR" &&
    (rule.action === "transfer_human" || rule.action === "transfer_department")
  ) {
    return { kind: "continue" };
  }

  if (rule.action === "answer_with_knowledge") {
    return { kind: "answer_with_knowledge" };
  }

  if (rule.action === "fixed_reply") {
    await deps.sendNotice(rule.message ?? "");
    return { kind: "handled", interceptName: "message_rule_fixed_reply" };
  }

  if (rule.action === "add_tag") {
    if (rule.message) await deps.sendNotice(rule.message);
    return { kind: "handled", interceptName: "message_rule_add_tag" };
  }

  if (rule.action === "assign_owner") {
    if (deps.archetype === "COORDENADOR") {
      return { kind: "continue" };
    }
    const ownerUserId = rule.ownerUserId;
    const owner = ownerUserId
      ? await prisma.user.findFirst({
          where: { id: ownerUserId },
          select: { id: true, type: true },
        })
      : null;
    if (!owner) {
      console.error("[ai] regra assign_owner: destino ausente nesta org", {
        ruleId: rule.id,
        ownerUserId,
        conversationId: deps.conversationId,
      });
      return { kind: "continue" };
    }
    try {
      const cluster = await prisma.$transaction((tx) =>
        assignOwnerToContactClusterTx(tx, {
          userId: owner.id,
          contactId: deps.contactId,
          conversationId: deps.conversationId,
          dealId: deps.dealId ?? null,
          via: "message_rule",
        }),
      );
      await invalidateBoardsForPipelines(cluster.pipelineIds);
    } catch (err) {
      console.error("[ai] regra assign_owner: falha ao atribuir", {
        ruleId: rule.id,
        ownerUserId: owner.id,
        conversationId: deps.conversationId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { kind: "continue" };
    }
    if (rule.message) {
      await deps.sendNotice(rule.message);
    } else if (owner.type === "AI" && deps.contactId) {
      await triggerAgentOpeningForContact({
        contactId: deps.contactId,
        agentUserId: owner.id,
      }).catch(() => {});
    }
    return { kind: "handled", interceptName: "message_rule_assign_owner" };
  }

  const handoff = await executeDepartmentHandoff({
    conversationId: deps.conversationId,
    contactId: deps.contactId,
    dealId: deps.dealId ?? null,
    departmentName:
      rule.action === "transfer_department" ? rule.department : null,
    reason: `Regra de mensagem "${rule.label}" (posição ${hit.position})`,
    policy: deps.policy,
    ops: deps.ops ?? null,
  });

  const text =
    rule.message ??
    (await deps.defaultQueueText({
      departmentName: handoff.departmentName,
    }));
  if (text) await deps.sendNotice(text);

  return {
    kind: "handled",
    interceptName:
      rule.action === "transfer_department"
        ? "message_rule_transfer_department"
        : "message_rule_transfer_human",
    departmentName: handoff.departmentName,
  };
}
