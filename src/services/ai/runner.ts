/**
 * Runner principal do agente de IA.
 *
 * Um "run" é uma invocação completa do agente respondendo a um ponto
 * de entrada (inbox, playground, step de automation). Resolve o
 * contexto (contato/deal/conversa/histórico), monta system prompt,
 * chama o LLM com tool-loop e persiste trace + custo.
 *
 * Fluxo:
 *   1. Carrega agente + config. Aplica check de autonomia/cap diário.
 *   2. Monta histórico dos últimos N turns (user ↔ assistant).
 *   3. Renderiza system prompt (template + overrides + variáveis do
 *      contato).
 *   4. Chama `generateWithTools` com o tool-loop (até 8 passos).
 *   5. Persiste `AIAgentRun` + `AIAgentMessage` (trace) + custo.
 *
 * Quem **envia a mensagem pro cliente** é quem chamou o runner (o
 * webhook ou o playground). O runner só devolve o texto final e
 * indica se houve handoff.
 */

import type { AIAgentAutonomy, Prisma } from "@prisma/client";

import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { runWithActor } from "@/lib/request-context";
import { estimateCost } from "@/lib/ai-agents/pricing";
import {
  normalizeOutputStyle,
  normalizeQualificationQuestions,
  type OutputStyle,
  type QualificationQuestion,
} from "@/lib/ai-agents/piloting";
import { DEFAULT_CHAT_MODEL, generateWithTools } from "@/services/ai/provider";
import {
  ACADEMIC_ATENDIMENTO_RULES,
  ACADEMIC_CONFIDENCE_RULES,
  ACADEMIC_MEDIA_CAPABILITY_RULES,
  ACADEMIC_CURRICULUM_TCE_RULES,
  academicExamModalityRules,
  formatCanonicalPortalAccessHint,
  formatExamAccessHint,
  formatParticipationCertificateHint,
  formatPoloAddressesHint,
} from "@/lib/ai-agents/academic-atendimento-prompt";
import {
  formatCampaignDispatchBlock,
  hydrateOutboundTemplateContent,
  loadLastCampaignDispatchContext,
} from "@/services/ai/campaign-context";
import { formatLocalClockHint } from "@/services/ai/idle-followup";
import {
  formatMessageModelsBlock,
  retrieveRelevantMessageModels,
} from "@/services/ai/message-models-retrieval";
import {
  formatRetrievalBlock,
  retrieveRelevantChunks,
} from "@/services/ai/retrieval";
import {
  normalizeInboxPolicy,
  normalizeToolConfig,
} from "@/lib/ai-agents/steering";
import { buildToolSet, type RunContext } from "@/services/ai/tools";

export type RunSource = "inbox" | "playground" | "automation" | "api";

export type RunArgs = {
  agentId: string;
  source: RunSource;
  /// Conteúdo do usuário (cliente). No playground é livre; no inbox
  /// é a última mensagem recebida.
  userMessage: string;
  conversationId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  /// Turns anteriores (para manter contexto). Se omitido e tiver
  /// conversationId, o runner busca automaticamente as últimas 10.
  history?: Array<{ role: "user" | "assistant"; content: string }>;
};

export type RunResult = {
  runId: string;
  text: string;
  status: "COMPLETED" | "FAILED" | "HANDOFF";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  autonomyMode: AIAgentAutonomy;
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  error?: string;
};

const MAX_HISTORY = 10;

/**
 * Regras de atendimento usadas quando `AIAgentConfig.steeringRules`
 * está vazio (agentes criados antes da pilotagem pelo CRM). Uma vez
 * que o consultor salva as regras na tela, o banco manda — inclusive
 * nos blocos de mídia/confiança, que passam a ser editáveis.
 */
export function fallbackSteeringRules(archetype: string): string {
  if (archetype !== "ATENDIMENTO") return "";
  return [
    ACADEMIC_ATENDIMENTO_RULES,
    ACADEMIC_CURRICULUM_TCE_RULES,
    ACADEMIC_MEDIA_CAPABILITY_RULES,
    ACADEMIC_CONFIDENCE_RULES,
  ].join("\n\n");
}

export async function runAgent(args: RunArgs): Promise<RunResult> {
  const agent = await prisma.aIAgentConfig.findUnique({
    where: { id: args.agentId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!agent) throw new Error("Agente não encontrado.");
  if (!agent.active) throw new Error("Agente inativo.");

  // Todo o restante roda como ator AI — qualquer logEvent disparado por
  // tool calls (move_stage, add_tag, transfer_to_human, etc.) sai
  // imputado ao agente IA em vez do humano da sessao que originou.
  return runWithActor(
    {
      type: "AI",
      label: agent.user?.name ?? "IA",
      ref: agent.id,
    },
    async () => {

  if (agent.dailyTokenCap > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const usage = await prisma.aIAgentRun.aggregate({
      where: { agentId: agent.id, createdAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    const used =
      (usage._sum.inputTokens ?? 0) + (usage._sum.outputTokens ?? 0);
    if (used >= agent.dailyTokenCap) {
      throw new Error(
        `Cap diário de tokens atingido (${used}/${agent.dailyTokenCap}).`,
      );
    }
  }

  const run = await prisma.aIAgentRun.create({
    data: withOrgFromCtx({
      agentId: agent.id,
      source: args.source,
      conversationId: args.conversationId ?? null,
      contactId: args.contactId ?? null,
      status: "RUNNING" as const,
    }),
  });

  try {
    const contact = args.contactId
      ? await prisma.contact.findUnique({
          where: { id: args.contactId },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            lifecycleStage: true,
            tags: { include: { tag: { select: { name: true } } } },
          },
        })
      : null;

    const deal = args.dealId
      ? await prisma.deal.findUnique({
          where: { id: args.dealId },
          include: {
            stage: {
              select: {
                name: true,
                pipelineId: true,
                pipeline: { select: { name: true } },
              },
            },
          },
        })
      : null;

    const history =
      args.history ??
      (await loadHistoryFromConversation(args.conversationId ?? null));

    // RAG: busca trechos da base de conhecimento do agente relevantes
    // pra mensagem atual. Se não houver docs, retorna [] rapidamente.
    const retrievedChunks = await retrieveRelevantChunks(
      agent.id,
      args.userMessage,
      4,
    ).catch((err) => {
      console.warn(`[ai] RAG falhou, seguindo sem contexto: ${err}`);
      return [];
    });
    const retrievalBlock = formatRetrievalBlock(retrievedChunks);

    const qualificationQuestions = normalizeQualificationQuestions(
      agent.qualificationQuestions,
    );
    const outputStyle = normalizeOutputStyle(agent.outputStyle);

    const isAcademicAttendance = agent.archetype === "ATENDIMENTO";
    // Modelos internos do CRM (tela Internos) — só ATENDIMENTO; denylist
    // de retenção fica em message-models-retrieval.
    const messageModelsBlock = isAcademicAttendance
      ? formatMessageModelsBlock(
          await retrieveRelevantMessageModels(args.userMessage, 3).catch(
            (err) => {
              console.warn(
                `[ai] modelos internos RAG falhou, seguindo sem: ${err}`,
              );
              return [];
            },
          ),
        )
      : "";
    // Últimos turnos: "quero sim" herda o assunto (portal/AVA) da pergunta anterior.
    const recentContextForHint = history
      .slice(-4)
      .map((m) => m.content)
      .join("\n");
    const portalAccessHint = isAcademicAttendance
      ? formatCanonicalPortalAccessHint(args.userMessage, recentContextForHint)
      : "";
    const campaignCtx = await loadLastCampaignDispatchContext(
      args.conversationId ?? null,
      args.contactId ?? null,
    ).catch((err) => {
      console.warn(`[ai] contexto de campanha falhou: ${err}`);
      return null;
    });
    const campaignDispatchBlock = formatCampaignDispatchBlock(campaignCtx);
    // Fato da operação: toda prova é online. Se um dia voltar a existir
    // prova presencial, a org grava `ai.exams.onlineOnly=false` em
    // `PUT /api/settings/org` — sem deploy. Falha de contexto/org cai no
    // default seguro (online).
    const examsOnlineOnly = isAcademicAttendance
      ? await getOrgSettingBool("ai.exams.onlineOnly", true).catch(() => true)
      : true;
    const examAccessHint = isAcademicAttendance
      ? formatExamAccessHint(
          args.userMessage,
          [recentContextForHint, campaignCtx?.body ?? ""]
            .filter(Boolean)
            .join("\n"),
          examsOnlineOnly,
        )
      : "";
    const poloAddressesHint = isAcademicAttendance
      ? formatPoloAddressesHint(args.userMessage, recentContextForHint)
      : "";
    const certificateHint = isAcademicAttendance
      ? formatParticipationCertificateHint(
          args.userMessage,
          [recentContextForHint, campaignCtx?.body ?? ""]
            .filter(Boolean)
            .join("\n"),
        )
      : "";
    const clockHint = isAcademicAttendance ? formatLocalClockHint() : "";
    const retrievalWithModels = [
      retrievalBlock,
      messageModelsBlock,
      portalAccessHint,
      examAccessHint,
      poloAddressesHint,
      certificateHint,
      campaignDispatchBlock,
      clockHint,
    ]
      .filter(Boolean)
      .join("\n");

    const runtimeTools = agent.enabledTools;
    const steeringRules =
      agent.steeringRules?.trim() || fallbackSteeringRules(agent.archetype);
    const runtimeOverride =
      [
        agent.systemPromptOverride?.trim(),
        steeringRules,
        isAcademicAttendance ? academicExamModalityRules(examsOnlineOnly) : "",
        isAcademicAttendance ? ACADEMIC_CURRICULUM_TCE_RULES : "",
      ]
        .filter(Boolean)
        .join("\n\n") || null;

    const systemPrompt = renderSystemPrompt({
      template: agent.systemPromptTemplate,
      override: runtimeOverride,
      productPolicy: agent.productPolicy,
      hasProductSearch: runtimeTools.includes("search_products"),
      hasEnrollmentLookup: runtimeTools.includes("consultar_matricula"),
      tone: agent.tone,
      language: agent.language,
      autonomyMode: agent.autonomyMode,
      contact,
      deal,
      retrievalBlock: retrievalWithModels,
      qualificationQuestions,
      outputStyle,
    });

    const ctx: RunContext = {
      agentUserId: agent.userId,
      agentId: agent.id,
      conversationId: args.conversationId ?? null,
      contactId: args.contactId ?? null,
      dealId: args.dealId ?? null,
      userMessage: args.userMessage,
      inboxPolicy: normalizeInboxPolicy(agent.inboxPolicy),
    };

    const toolSet = buildToolSet(
      ctx,
      runtimeTools,
      normalizeToolConfig(agent.toolConfig),
    );

    const messages: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [
      ...history,
      { role: "user", content: args.userMessage },
    ];

    await prisma.aIAgentMessage.create({
      data: withOrgFromCtx({ runId: run.id, role: "system", content: systemPrompt }),
    });
    await prisma.aIAgentMessage.create({
      data: withOrgFromCtx({ runId: run.id, role: "user", content: args.userMessage }),
    });

    const result = await generateWithTools({
      model: agent.model || DEFAULT_CHAT_MODEL,
      system: systemPrompt,
      messages,
      tools: Object.keys(toolSet).length > 0 ? toolSet : undefined,
      temperature: agent.temperature,
      maxOutputTokens: agent.maxTokens,
      maxSteps: 8,
    });

    for (const call of result.toolCalls) {
      await prisma.aIAgentMessage.create({
        data: withOrgFromCtx({
          runId: run.id,
          role: "tool",
          toolName: call.toolName,
          content: "",
          toolData: {
            args: call.args ?? null,
            result: call.result ?? null,
          } as Prisma.InputJsonValue,
        }),
      });
    }
    if (result.text) {
      await prisma.aIAgentMessage.create({
        data: withOrgFromCtx({ runId: run.id, role: "assistant", content: result.text }),
      });
    }

    const costUsd = estimateCost(
      agent.model,
      result.inputTokens,
      result.outputTokens,
    );

    const hadTransfer = result.toolCalls.some((c) =>
      [
        "transfer_to_human",
        "transfer_to_department",
        "execute_distribution",
      ].includes(c.toolName),
    );
    const status: RunResult["status"] = hadTransfer ? "HANDOFF" : "COMPLETED";

    await prisma.aIAgentRun.update({
      where: { id: run.id },
      data: {
        status,
        handoffReason: hadTransfer ? "tool_transfer" : null,
        responsePreview: result.text.slice(0, 500),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd,
        finishedAt: new Date(),
      },
    });

    return {
      runId: run.id,
      text: result.text,
      status,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd,
      autonomyMode: agent.autonomyMode,
      toolCalls: result.toolCalls.map((c) => ({
        name: c.toolName,
        args: c.args,
        result: c.result,
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.aIAgentRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        errorMessage: message.slice(0, 500),
        finishedAt: new Date(),
      },
    }).catch(() => null);
    return {
      runId: run.id,
      text: "",
      status: "FAILED",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      autonomyMode: "DRAFT",
      toolCalls: [],
      error: message,
    };
  }
    },
  ) as Promise<RunResult>;
}

async function loadHistoryFromConversation(
  conversationId: string | null,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  if (!conversationId) return [];
  const msgs = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY,
    select: {
      content: true,
      direction: true,
      messageType: true,
      templateConfigId: true,
      senderName: true,
    },
  });
  const chronological = msgs.reverse().filter((m) => !!m.content);
  const hydrated = await Promise.all(
    chronological.map(async (m) => {
      const raw = m.content ?? "";
      const content =
        m.direction === "out"
          ? await hydrateOutboundTemplateContent({
              content: raw,
              messageType: m.messageType,
              templateConfigId: m.templateConfigId,
              senderName: m.senderName,
            })
          : raw;
      return {
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        content,
      };
    }),
  );
  return hydrated;
}
type RenderArgs = {
  template: string;
  override: string | null;
  productPolicy: string | null;
  hasProductSearch: boolean;
  hasEnrollmentLookup: boolean;
  tone: string;
  language: string;
  autonomyMode: AIAgentAutonomy;
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    lifecycleStage: string | null;
    tags: Array<{ tag: { name: string } }>;
  } | null;
  deal: {
    title: string;
    value: unknown;
    stage: {
      name: string;
      pipeline?: { name: string } | null;
    } | null;
  } | null;
  retrievalBlock: string;
  qualificationQuestions: QualificationQuestion[];
  outputStyle: OutputStyle;
};

function renderSystemPrompt(args: RenderArgs): string {
  const lines: string[] = [];
  lines.push(args.template);
  lines.push("");
  lines.push(`Idioma: ${args.language}. Tom: ${args.tone}.`);

  if (args.autonomyMode === "DRAFT") {
    lines.push(
      "IMPORTANTE: você está em modo RASCUNHO. Sua resposta será revisada por um humano antes de ser enviada. Seja conciso.",
    );
  }

  if (args.contact) {
    lines.push("");
    lines.push("CONTATO:");
    if (args.contact.name) lines.push(`- Nome: ${args.contact.name}`);
    if (args.contact.email) lines.push(`- Email: ${args.contact.email}`);
    if (args.contact.phone) lines.push(`- Telefone: ${args.contact.phone}`);
    if (args.contact.lifecycleStage)
      lines.push(`- Estágio do ciclo: ${args.contact.lifecycleStage}`);
    const tags = args.contact.tags
      .map((t) => t.tag.name)
      .filter(Boolean);
    if (tags.length) lines.push(`- Tags: ${tags.join(", ")}`);
  }

  if (args.deal) {
    lines.push("");
    lines.push("DEAL ATUAL:");
    lines.push(`- Título: ${args.deal.title}`);
    if (args.deal.value) lines.push(`- Valor: R$ ${String(args.deal.value)}`);
    if (args.deal.stage?.pipeline?.name)
      lines.push(`- Funil: ${args.deal.stage.pipeline.name}`);
    if (args.deal.stage) lines.push(`- Estágio: ${args.deal.stage.name}`);
    lines.push(
      "- Funil/Estágio é só contexto. NÃO transfira só por causa do funil — atenda primeiro; use departamento certo só quando for distribuir de verdade.",
    );
  }

  // Só lembra da tool se ela estiver ligada no CRM — desligar a tool e
  // continuar pedindo que o agente a chame gerava alucinação de matrícula.
  if (args.hasEnrollmentLookup) {
    lines.push("");
    lines.push(
      "Lembrete: chame `consultar_matricula` cedo no atendimento para personalizar com o relatório de matriculados.",
    );
  }

  if (args.override?.trim()) {
    lines.push("");
    lines.push("INSTRUÇÕES ESPECÍFICAS:");
    lines.push(args.override.trim());
  }

  if (args.outputStyle === "conversational") {
    lines.push("");
    lines.push("ESTILO DE RESPOSTA (regra dura):");
    lines.push(
      "- Você está escrevendo no WhatsApp. Responda como atendente humano, em texto corrido. Nunca use listas com bullets, tabelas, cabeçalhos em markdown, ou frases template tipo 'Aqui estão os detalhes:'.",
    );
    lines.push(
      "- PROIBIDO: formato de ficha técnica como '*Curso:* X', '*Modalidade:* Y', '*Duração:* Z' com ícones/emojis por linha. Isso soa robótico.",
    );
    lines.push(
      "- Use no máximo 1–2 emojis discretos na mensagem inteira, e só se combinar com o tom.",
    );
    lines.push(
      "- Prefira 1 a 4 frases curtas. Pode terminar com UMA pergunta curta **só se** ainda faltar um dado para ajudar.",
    );
    lines.push(
      "- Se o aluno já pediu o passo a passo/site/link ou disse sim/pode ser/envie: ENTREGUE a orientação (com link das refs se houver). NÃO termine de novo perguntando se ele quer as instruções.",
    );
    lines.push(
      "- PROIBIDO prometer ou fingir envio de vídeo/arquivo (ex.: 'vou te enviar o vídeo', '[Envio do vídeo]'). Sem URL nas refs, só texto; com URL, cole o link.",
    );
  }

  if (args.qualificationQuestions.length > 0) {
    lines.push("");
    lines.push(
      "QUALIFICAÇÃO — informações que você DEVE coletar antes de encerrar a conversa ou transferir para humano:",
    );
    for (const q of args.qualificationQuestions) {
      const hint = q.hint ? ` (formato: ${q.hint})` : "";
      lines.push(`- ${q.question}${hint}`);
    }
    lines.push(
      "Regras: não peça tudo de uma vez. Vá coletando naturalmente no fluxo da conversa, uma pergunta por vez quando fizer sentido. NÃO chame `transfer_to_human` enquanto tiver informação pendente dessa lista, salvo se o cliente pedir explicitamente pra falar com atendente ou demonstrar irritação.",
    );
  }

  if (args.hasProductSearch) {
    lines.push("");
    lines.push("CONSULTA DE PRODUTOS — regras obrigatórias:");
    lines.push(
      "- Sempre que o cliente mencionar um produto, curso, serviço, preço ou característica, chame `search_products` ANTES de responder. Nunca invente preço, duração, modalidade ou condição.",
    );
    lines.push(
      "- Se a busca não encontrar, diga naturalmente que vai confirmar com o time e ofereça transferir pra um atendente. Não force uma resposta.",
    );
    lines.push("");
    lines.push("COMO APRESENTAR O PRODUTO (MUITO IMPORTANTE):");
    lines.push(
      "- Responda como um atendente humano no WhatsApp, não como uma ficha técnica. O objetivo é avançar a conversa, não cuspir dados.",
    );
    lines.push(
      "- PROIBIDO: listas com bullets de atributos (ex.: '*Nome:* ... *Preço:* ... *Duração:* ...'), markdown pesado, frases como 'Aqui estão os detalhes:'. Isso assusta o cliente e soa robótico.",
    );
    lines.push(
      "- Responda em 1 a 3 frases curtas, em texto corrido, misturando as informações naturalmente. Ex.: 'O curso de Administração é EAD, dura 4 anos (8 semestres) e sai por R$ 145 por mês — e agora ainda tem 45% de desconto ativo. Quer que eu te ajude a seguir com a inscrição?'",
    );
    lines.push(
      "- Sempre termine com UMA única pergunta curta que faça a conversa avançar (ex.: 'quer que eu te mande o link de inscrição?', 'faz sentido pra você começar em que mês?'). Evite múltiplas perguntas na mesma mensagem.",
    );
    lines.push(
      "- Só detalhe (em texto corrido, ainda sem bullets) mais atributos se o cliente pedir explicitamente. Em dúvida, mostre o essencial e pergunte o que mais ele quer saber.",
    );
    lines.push(
      "- Use no máximo 1 emoji discreto quando fizer sentido pelo tom configurado. Não repita emojis.",
    );
    lines.push(
      "- Dados técnicos da tool (`priceFormatted`, `customFields`, etc.) servem como FONTE, não como TEMPLATE de saída. Transforme em fala natural.",
    );
    if (args.productPolicy?.trim()) {
      lines.push("");
      lines.push("POLÍTICA ADICIONAL DE APRESENTAÇÃO DE PRODUTOS (do operador):");
      lines.push(args.productPolicy.trim());
    }
  }

  if (args.retrievalBlock) {
    lines.push(args.retrievalBlock);
  }

  return lines.join("\n");
}
