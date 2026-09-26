/**
 * "Sem material": resposta com fato (número, data, prazo, passo, caminho,
 * link) quando nada nos materiais cobre a mensagem. O modelo completava com
 * o que parecia óbvio. Vale igual para o WhatsApp e a Conversa de teste.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2CRMContext, V2LLMOutput } from "@/lib/ai-v2/types";
import { FACT_IN_SENTENCE } from "./ground-reply";
import { WEAK_MATCH_SIMILARITY } from "./similarity-presets";

/** A resposta afirma algo verificável: número/data/prazo, passos, caminho de tela, link. */
export function statesFacts(reply: string): boolean {
  return (
    FACT_IN_SENTENCE.test(reply) ||
    /^\s*\d+[.)]\s+\S/m.test(reply) ||
    /\S\s*[>→»]\s*\S/.test(reply) ||
    /https?:\/\//i.test(reply)
  );
}

/** A resposta usa um dado do cadastro do cliente (então não é invenção de produto). */
export function mentionsClientData(reply: string, context: V2CRMContext): boolean {
  const text = reply.toLowerCase();
  const values = [context.contact, context.selectedDeal, context.citableContact, context.citableDeal]
    .flatMap((o) => Object.values(o ?? {}))
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map((v) => String(v).trim().toLowerCase())
    .filter((v) => v.length >= 4);
  return values.some((v) => text.includes(v));
}

/** O modelo diz que não tem a informação ("não tenho", "não encontrei", "não consigo confirmar"). */
export function lacksInformation(reply: string): boolean {
  return /\bn[aã]o (?:tenho|encontrei|achei|sei|consigo (?:confirmar|informar|ver|verificar))\b|\bn[aã]o h[aá] (?:essa )?informa|\bsem (?:essa )?informa[cç]/i.test(reply);
}

/** A resposta já avisa a transferência (não vale mandar antes do aviso). */
export function announcesTransfer(reply: string): boolean {
  return /\b(?:transfer|encaminh|chamar (?:algu[eé]m|uma pessoa)|atendente|equipe)\w*/i.test(reply);
}

export type V2PrefetchFact = { searched?: boolean; found?: number; bestSimilarity?: number | null };

/** Nada relevante nos materiais para esta mensagem (buscou e não achou). */
export function nothingRelevantFound(prefetch: V2PrefetchFact | undefined): boolean {
  if (!prefetch?.searched) return false;
  return (prefetch.found ?? 0) === 0 || (prefetch.bestSimilarity ?? 0) < WEAK_MATCH_SIMILARITY;
}

/**
 * Aplica a saída "sem material" quando:
 *  - o modelo consultou e tudo voltou vazio, e não há dado do cliente; ou
 *  - nada relevante nos materiais (pré-busca e consultas do modelo) e a
 *    resposta afirma fatos que não vêm do cadastro do cliente.
 * Muda `output` no lugar. `handoff` diz se transferiu (sem mensagem
 * configurada) ou só respondeu com a mensagem "sem material".
 */
export function applyNoSourceGuard(args: {
  config: V2AgentConfig;
  output: V2LLMOutput;
  context: V2CRMContext;
  toolCalls: Array<{ toolName: string; args?: unknown; result: unknown }> | undefined;
  queriedEmpty: boolean;
  prefetch: V2PrefetchFact | undefined;
}): { applied: boolean; handoff: boolean } {
  const { config, output, context } = args;
  if (output.handoff || output.concluded) return { applied: false, handoff: false };
  const hasClientData = !!context.contact || !!context.selectedDeal;
  const modelQueried = (args.toolCalls ?? []).some((c) => !(c.args as { prefetch?: boolean } | undefined)?.prefetch);
  const modelFound = modelQueried && !args.queriedEmpty;
  const legacy = args.queriedEmpty && !hasClientData;
  const invented =
    (args.queriedEmpty || (nothingRelevantFound(args.prefetch) && !modelFound)) &&
    statesFacts(output.reply) &&
    !mentionsClientData(output.reply, context);
  if (!legacy && !invented) return { applied: false, handoff: false };
  const noSourceMessage = config.fallback?.noSource?.message?.trim();
  if (noSourceMessage) {
    output.handoff = false;
    output.reply = noSourceMessage;
    output.reason = "Nada nos materiais cobre a mensagem (consulta sem resultados) — saída 'sem material de consulta' configurada";
    return { applied: true, handoff: false };
  }
  output.handoff = true;
  output.reply = config.handoff.message;
  output.reason = "Nada nos materiais cobre a mensagem (consulta sem resultados)";
  return { applied: true, handoff: true };
}
