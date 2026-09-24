/**
 * Diagnóstico de erro do agente a partir do "onde ele errou" marcado na tela
 * de conversas de teste.
 *
 * Um LLM recebe: (1) como o motor v2 funciona, de forma genérica; (2) a
 * configuração publicada do agente, resumida; (3) o turno marcado com o
 * rastro de decisões e os turnos anteriores da conversa; (4) o comentário de
 * quem testou. Devolve a causa provável e o que corrigir — na configuração
 * (com a etapa da tela), no material de consulta, ou no motor (texto pronto
 * para pedir ao dev).
 * Nenhum domínio de cliente: o guia descreve o motor, não um produto.
 */

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { generateWithTools } from "@/services/ai/provider";
import { getAgentApiKey } from "@/services/ai/agent-key";
import { ensureV2AgentSchema } from "./ensure-schema";
import { sourcesFromToolCalls } from "./sources";

/** Como o motor decide cada turno — é o que permite apontar a etapa certa. */
export const V2_ENGINE_GUIDE = `
# Como o motor do agente decide um turno (em ordem)
1. Entrada: mensagens seguidas do cliente viram um turno só (agrupamento de ~1,5 s). Só conversa atribuída ao agente é processada; conversa sem responsável é atribuída ao agente se o atendimento IA da organização estiver ligado e o telefone estiver na lista de teste (quando houver lista).
2. Estado da conversa: etapa (idle → confirming → identifying → active → closed) e dono (agente/pessoa). Depois de encerrar, há uma janela pós-encerramento em que "obrigado"/novas demandas têm comportamento próprio (etapa "Encerrar e classificar").
3. Mídia (áudio/imagem/documento): política por tipo (etapa "Saídas").
4. Regras automáticas (etapa "Regras automáticas"): condições determinísticas (palavras-chave, fora do horário, tag, etapa do negócio, campo, primeira mensagem, sem negócio). Uma regra que casa executa suas ações ANTES do LLM; se a ação é terminal (transferir, encerrar, enviar mensagem) o LLM nem roda. Palavra-chave casa a palavra inteira ou com até 3 letras a mais.
5. Limites de parada (etapa "Saídas"): loop (mesma mensagem repetida), mensagens fora de escopo seguidas, cortesia pós-encerramento. Quando atingidos, bloqueiam a resposta e aplicam a ação configurada.
6. Início da conversa (etapa "Início da conversa"): no primeiro contato envia boas-vindas e confirma a identidade; se não há negócio do cliente, segue "ao não encontrar cadastro" (pedir identificação até N tentativas e transferir, criar negócio, ou transferir).
7. Assunto (etapa "Assuntos"): escolhido por gatilho (palavra da lista "quando" casa com a mensagem) ou, sem gatilho, pelo assunto mais próximo em significado; senão mantém o assunto atual. O assunto traz instruções, ferramentas/ações permitidas, materiais e modelos de mensagem próprios e destino de transferência.
8. Base de conhecimento (etapa "Materiais de consulta"): antes do LLM, busca pelo significado da mensagem nos materiais do assunto + materiais globais e entrega os trechos mais próximos no prompt. Material não liberado (nem global nem no assunto), não publicado, com texto ruim ou que não cobre a pergunta não aparece.
9. LLM: recebe tom e regras globais (etapa "Jeito de falar"), dados do cliente liberados (etapa "O que ele sabe" — só "Ler"/"Citar"), instruções do assunto, trechos da base e o histórico recente. Devolve resposta, decisão de transferir/encerrar, ações e motivo.
10. Ações: só executam se permitidas no assunto (ou nas ferramentas globais sem assunto); modelos de mensagem só da lista liberada. Ações fora do permitido são descartadas.
11. Guarda de saída: remove links de domínios não liberados e dados marcados só como "Ler"; promessa de "volto depois" vira transferência.
12. Envio: a resposta pode ser barrada (conversa não está mais com o agente, anti-repetição de mensagem igual em 5 min, número fora da allowlist, canal desconectado). Modo "sugestão" salva rascunho em vez de enviar.
13. Transferência (etapa "Equipe e horários"): mensagem de transferência + destino (departamento, usuário, regra de distribuição, outro agente).

# Como classificar a correção
- "configuracao": o comportamento seguiu a configuração, mas a configuração não expressa o que o operador quer. Diga a etapa da tela e o ajuste exato (ex.: gatilho a acrescentar, regra a restringir, material a liberar no assunto, instrução do assunto a reescrever).
- "material": a informação certa não existe, está incompleta ou mal escrita no material de consulta. Diga o que o material precisa conter.
- "modelo": configuração e material estavam certos e o LLM ainda assim errou; sugira instrução mais explícita no assunto ou nas regras globais.
- "motor": o motor fez algo que contradiz a própria regra descrita acima (ex.: rastro mostra decisão incoerente com a configuração, passo esperado ausente, resposta barrada sem motivo válido). Escreva em "pedidoParaDev" o pedido ao desenvolvedor com a evidência do rastro.
Baseie-se no rastro: ele mostra, passo a passo, o que o motor decidiu e por quê. Não invente passos que não estão no rastro.
Compare a resposta enviada com "trechosQueOModeloLeu": informação da resposta que não está em nenhum trecho nem nos dados do cliente é invenção do modelo (categoria "modelo" — sugira instrução explícita). Informação errada que está no trecho é problema do material (categoria "material" — diga o que corrigir no texto).
`.trim();

const diagnosisSchema = z.object({
  resumo: z.string(),
  causa: z.string(),
  categoria: z.enum(["configuracao", "material", "modelo", "motor"]),
  correcoes: z
    .array(z.object({ onde: z.string(), oque: z.string() }))
    .optional()
    .default([]),
  pedidoParaDev: z.string().nullable().optional().default(null),
  confianca: z.enum(["alta", "media", "baixa"]).optional().default("media"),
});

export type V2Diagnosis = z.infer<typeof diagnosisSchema>;

export type V2TurnFeedback = {
  comment: string;
  createdAt: string;
  byUserId: string | null;
  diagnosis: V2Diagnosis | null;
  diagnosisError?: string;
};

type TurnLogRow = {
  id: string;
  organizationId: string;
  agentId: string;
  conversationId: string;
  inboundText: string;
  reply: string | null;
  handoff: boolean;
  error: string | null;
  prompt: string;
  llmOutput: unknown;
  executedActions: unknown;
  discardedActions: unknown;
  contextSnapshot: unknown;
  createdAt: Date;
};

const logDb = () =>
  prisma as unknown as {
    aISimpleTurnLog: {
      findFirst: (args: unknown) => Promise<TurnLogRow | null>;
      findMany: (args: unknown) => Promise<TurnLogRow[]>;
      update: (args: unknown) => Promise<unknown>;
    };
  };

/** Configuração em forma legível para o diagnóstico (sem chaves/segredos). */
export function summarizeConfigForDiagnosis(
  config: V2AgentConfig,
  docTitles: Map<string, string>,
): Record<string, unknown> {
  const titles = (ids: string[] | undefined) => (ids ?? []).map((id) => docTitles.get(id) ?? id);
  return {
    tom: config.tone,
    tamanhoResposta: config.responseLength,
    regrasGlobais: config.globalRules,
    modoAutonomia: config.autonomyMode,
    inicio: {
      confirmarIdentidade: config.entry.confirmContact,
      modoConfirmacao: config.entry.confirmationMode,
      semCadastro: config.entry.onDealNotFound,
      tentativasIdentificacao: config.entry.maxAttempts,
    },
    selecaoNegocio: config.dealSelection,
    camposDoCliente: {
      contato: config.contextFields.contact.map((f) => ({ campo: f.label ?? f.key, permissoes: f.permissions })),
      negocio: config.contextFields.deal.map((f) => ({ campo: f.label ?? f.key, permissoes: f.permissions })),
    },
    materiaisGlobais: titles(config.allowedKnowledgeDocIds),
    ferramentasGlobais: config.enabledTools ?? [],
    assuntos: config.themes.map((t) => ({
      nome: t.name,
      gatilhos: t.when,
      exemplos: t.examples,
      instrucoes: t.instructions,
      permitidos: t.allowedTools,
      materiais: titles([...(t.allowedKnowledgeDocIds ?? []), ...(t.knowledgeDocIds ?? [])]),
    })),
    regras: config.rules.map((r) => ({
      nome: r.name,
      ordem: r.order,
      condicoes: r.conditions,
      acoes: r.actions,
    })),
    transferencia: {
      mensagem: config.handoff.message,
      destinoPadrao: config.handoff.defaultDestination,
    },
    limites: config.limits,
    midia: config.media,
    encerramento: {
      janelaPosEncerramentoHoras: config.closure.postCloseWindowHours,
      cortesia: config.closure.courtesyBehavior,
      novaDemanda: config.closure.newDemandBehavior,
      ambiguo: config.closure.ambiguousBehavior,
    },
    sentimento: config.sentiment,
  };
}

function compactTurn(row: TurnLogRow, withSources = false): Record<string, unknown> {
  const snap = (row.contextSnapshot ?? {}) as Record<string, unknown>;
  const out = (row.llmOutput ?? null) as Record<string, unknown> | null;
  return {
    // Só no turno marcado: é o que permite dizer "isto não está nos
    // trechos" (invenção) em vez de culpar o material.
    ...(withSources ? { trechosQueOModeloLeu: sourcesFromToolCalls(snap.toolCalls) } : {}),
    quando: row.createdAt,
    cliente: row.inboundText,
    respostaEnviada: row.reply,
    transferiu: row.handoff,
    erro: row.error,
    etapa: snap.stage,
    motivoDoModelo: out?.reason ?? null,
    rastro: snap.trace ?? [],
    acoesDescartadas: row.discardedActions,
  };
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export async function diagnoseV2Turn(args: {
  organizationId: string;
  agentId: string;
  logId: string;
  comment: string;
  userId: string | null;
}): Promise<V2TurnFeedback> {
  await ensureV2AgentSchema().catch(() => undefined);
  const comment = args.comment.trim();
  if (!comment) throw new Error("Descreva onde o agente errou.");

  const row = await logDb().aISimpleTurnLog.findFirst({
    where: { id: args.logId, organizationId: args.organizationId, agentId: args.agentId },
  });
  if (!row) throw new Error("Turno não encontrado.");

  const previous = await logDb().aISimpleTurnLog.findMany({
    where: { organizationId: args.organizationId, conversationId: row.conversationId, createdAt: { lt: row.createdAt } },
    orderBy: { createdAt: "desc" },
    take: 6,
  });

  const agentRow = await (prisma as unknown as {
    aIAgentConfig: {
      findFirst: (args: unknown) => Promise<{ simpleConfig: unknown; model?: string | null } | null>;
    };
  }).aIAgentConfig.findFirst({
    where: { id: args.agentId, organizationId: args.organizationId },
    select: { simpleConfig: true },
  });
  if (!agentRow?.simpleConfig) throw new Error("Agente sem configuração publicada.");
  const config = normalizeV2Config(agentRow.simpleConfig);

  const docs = await (prisma as unknown as {
    aIAgentKnowledgeDoc: { findMany: (args: unknown) => Promise<Array<{ id: string; title: string }>> };
  }).aIAgentKnowledgeDoc.findMany({
    where: { agentId: args.agentId, organizationId: args.organizationId },
    select: { id: true, title: true },
  });
  const docTitles = new Map(docs.map((d) => [d.id, d.title]));

  const payload = {
    comentarioDeQuemTestou: comment,
    turnoMarcado: compactTurn(row, true),
    turnosAnteriores: previous.reverse().map(compactTurn),
    configuracaoDoAgente: summarizeConfigForDiagnosis(config, docTitles),
    materiaisExistentes: docs.map((d) => d.title),
  };

  const system = [
    "Você diagnostica erros de um agente de atendimento por IA para quem o configura. Responda em português do Brasil, de forma direta.",
    V2_ENGINE_GUIDE,
    "# Saída",
    "Responda APENAS um objeto JSON:",
    JSON.stringify({
      resumo: "o que aconteceu no turno, em 1-2 frases",
      causa: "por que aconteceu, apontando o passo do rastro",
      categoria: "configuracao | material | modelo | motor",
      correcoes: [{ onde: "etapa da tela (ou 'material: <título>')", oque: "ajuste exato" }],
      pedidoParaDev: "texto pronto para o desenvolvedor quando categoria = motor; senão null",
      confianca: "alta | media | baixa",
    }),
  ].join("\n\n");

  let diagnosis: V2Diagnosis | null = null;
  let diagnosisError: string | undefined;
  try {
    const apiKey = await getAgentApiKey(args.agentId);
    const result = await generateWithTools({
      model: config.model,
      apiKey,
      system,
      messages: [{ role: "user", content: JSON.stringify(payload) }] as any,
      temperature: 0.2,
      maxOutputTokens: 1500,
      maxSteps: 1,
    });
    const parsed = diagnosisSchema.safeParse(parseJson(result.text));
    if (parsed.success) diagnosis = parsed.data;
    else diagnosisError = "O diagnóstico não veio no formato esperado.";
  } catch (err) {
    diagnosisError = err instanceof Error ? err.message : String(err);
  }

  const feedback: V2TurnFeedback = {
    comment,
    createdAt: new Date().toISOString(),
    byUserId: args.userId,
    diagnosis,
    ...(diagnosisError ? { diagnosisError } : {}),
  };
  await logDb().aISimpleTurnLog.update({
    where: { id: row.id },
    data: { feedback },
    select: { id: true },
  });
  return feedback;
}
