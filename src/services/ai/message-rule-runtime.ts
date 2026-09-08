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
import { executeDepartmentHandoff } from "@/services/ai/department-handoff";
import type { VerticalPackOps } from "@/verticals/types";

export type MessageRuleOutcome =
  /// O turno segue para o modelo (base de conhecimento). Interceptos
  /// determinísticos NÃO rodam — a regra do operador já decidiu.
  | { kind: "answer_with_knowledge" }
  /// A regra resolveu o turno. `interceptName` vai para o run de auditoria.
  | { kind: "handled"; interceptName: string; departmentName?: string | null };

export type MessageRuleDeps = {
  conversationId: string;
  contactId: string | null;
  dealId?: string | null;
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

export async function executeMessageRule(
  hit: MessageRuleHit,
  deps: MessageRuleDeps,
): Promise<MessageRuleOutcome> {
  const { rule } = hit;

  if (rule.action === "answer_with_knowledge") {
    return { kind: "answer_with_knowledge" };
  }

  if (rule.action === "fixed_reply") {
    await deps.sendNotice(rule.message ?? "");
    return { kind: "handled", interceptName: "message_rule_fixed_reply" };
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
