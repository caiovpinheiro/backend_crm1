/**
 * Execução de um turno com o MODO DE TESTE ligado.
 *
 * Caminho próprio, e curto de propósito. O turno de teste chama exatamente
 * três coisas: avaliação das regras de assunto (função pura), `runAgent` com
 * `source: "inbox_test"` (que simula as ferramentas de efeito) e o envio de
 * texto. Nenhuma delas mexe em `assignedToId`, em `DistributionPending` ou em
 * departamento — o raio de alcance do turno é, por construção, zero.
 *
 * Isso é diferente de "confiar que cada call site checou o modo". O
 * inbox-handler de produção transfere por sete caminhos (regra de assunto,
 * intercepto de pack, mídia sem legenda, falha de run, baixa confiança, tool
 * e reforço pós-resposta), e auditar os sete a cada mudança seria uma
 * garantia que envelhece. Aqui o turno simplesmente não passa por eles.
 *
 * O preço: os interceptos determinísticos do vertical pack não rodam em modo
 * de teste — eles transferem por dentro, e neutralizá-los um a um é que seria
 * frágil.
 */

import { evaluateMessageRules } from "@/lib/ai-agents/message-rules";
import type { InboxPolicy } from "@/lib/ai-agents/steering";
import { debugInfo } from "@/lib/debug-log";
import { parseAgentConfidence } from "@/services/ai/confidence";
import { runAgent } from "@/services/ai/runner";

export type AiTestTurnInput = {
  conversationId: string;
  contactId: string;
  userMessage: string;
  turnId?: string | null;
  agentConfigId: string;
  policy: InboxPolicy;
  /// Envia texto ao operador. O handler já sabe canal, typing e generationId.
  sendText: (text: string) => Promise<void>;
  /// Texto de fila que a produção usaria quando a regra não traz mensagem.
  defaultQueueText: (args: {
    departmentName: string | null;
  }) => Promise<string> | string;
};

export async function runAiTestTurn(input: AiTestTurnInput): Promise<void> {
  const hit = evaluateMessageRules(input.userMessage, input.policy.messageRules);

  // Regra que resolve o turno sem modelo: em produção o LLM também não
  // rodaria. A diferença é só a transferência, que aqui não acontece.
  if (hit && hit.rule.action !== "answer_with_knowledge") {
    const text =
      hit.rule.action === "fixed_reply"
        ? (hit.rule.message ?? "")
        : (hit.rule.message ??
          (await input.defaultQueueText({
            departmentName: hit.rule.department,
          })));
    if (text.trim()) await input.sendText(text);
    logTest("rule_handled", {
      conversationId: input.conversationId,
      rule: hit.rule.label,
      action: hit.rule.action,
    });
    return;
  }

  const result = await runAgent({
    agentId: input.agentConfigId,
    source: "inbox_test",
    userMessage: input.userMessage,
    conversationId: input.conversationId,
    contactId: input.contactId,
    // Sem deal: em modo de teste nada deve casar com um negócio real.
    dealId: null,
    turnId: input.turnId ?? null,
  });

  if (result.status === "FAILED") {
    logTest("run_failed", {
      conversationId: input.conversationId,
      error: result.error ?? "unknown",
    });
    return;
  }

  // O marcador [CONFIANCA:X.X] é interno: o inbox de produção o remove em
  // parseAgentConfidence, e este caminho precisa remover também.
  const reply = parseAgentConfidence(result.text).text.trim();
  if (reply) await input.sendText(reply);

  logTest("answered", {
    conversationId: input.conversationId,
    toolCalls: result.toolCalls.map((c) => c.name),
  });
}

function logTest(event: string, payload: Record<string, unknown>) {
  debugInfo(
    "[ai-test]",
    () => JSON.stringify({ event, ts: new Date().toISOString(), ...payload }),
  );
}
