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
import { getVerticalPack } from "@/verticals";

import {
  composeRuntimeOverride,
  fallbackSteeringRules,
  renderSystemPrompt,
} from "@/lib/ai-agents/system-prompt";
import {
  buildAutoClosePromptBlock,
  normalizeAutoClosePolicy,
  normalizeOutputStyle,
  normalizeQualificationQuestions,
} from "@/lib/ai-agents/piloting";
import { getAgentApiKey } from "@/services/ai/agent-key";
import {
  describeConversationIdentity,
  loadConversationIdentity,
} from "@/services/ai/conversation-identity";
import {
  formatCampaignDispatchBlock,
  hydrateOutboundTemplateContent,
  loadLastCampaignDispatchContext,
} from "@/services/ai/campaign-context";
import { formatLocalClockHint } from "@/services/ai/idle-followup";
import { maybeOrchestrateCoordinatorTurn } from "@/services/ai/coordinator-orchestrate";
import {
  formatCoordinatorRoutingBlock,
  formatSpecialistPeerBlock,
  suggestCoordinatorAiAgent,
  type PeerAiAgent,
} from "@/lib/ai-agents/coordinator-route";
import {
  humanQueueContextFromAgent,
  resolveAgentTimezone,
} from "@/services/ai/human-queue-policy";
import {
  formatMessageModelsBlock,
  pickFollowUpMedia,
  retrieveRelevantMessageModels,
  type AgentFaqMedia,
} from "@/services/ai/message-models-retrieval";
import {
  formatExpiredKnowledgeBlock,
  formatRetrievalBlock,
  retrieveAgentKnowledge,
} from "@/services/ai/retrieval";
import {
  buildUnknownAnswerBlock,
  normalizeInboxPolicy,
  normalizeToolConfig,
} from "@/lib/ai-agents/steering";
import {
  behaviorSliceFromAgent,
  hashAgentBehaviorConfig,
} from "@/lib/ai-agents/observability";
import { estimateCost } from "@/lib/ai-agents/pricing";
import {
  DEFAULT_CHAT_MODEL,
  generateWithTools,
} from "@/services/ai/provider";
import { ARCHETYPE_MAP } from "@/lib/ai-agents/archetypes";
import { isTabulationClassifier } from "@/lib/ai-agents/tabulation-classifier";
import { buildToolSet, type RunContext } from "@/services/ai/tools";
import {
  evaluateTransferGate,
  nonsenseGuardReply,
  transferBlockedByGate,
} from "@/services/ai/transfer-gate";
import {
  auditEffectClaims,
  NEUTRAL_EFFECT_FALLBACK,
} from "@/services/ai/effect-claims";
import {
  buildRetrievalQuery,
  trimToRecentSession,
} from "@/services/ai/retrieval-query";
import {
  deriveRunOutcome,
  statusForOutcome,
} from "@/services/ai/run-outcome";
import {
  normalizeToolCallLimits,
  ToolCallGovernor,
} from "@/services/ai/tool-governor";

/**
 * `inbox_test` é o inbound normal rodando com o MODO DE TESTE ligado na
 * conversa (`src/services/ai/test-mode.ts`). É um valor de `source` próprio, e
 * não um flag separado, por dois motivos: o desfecho continua sendo derivado
 * do estado real (nada de outcome inventado para teste) e as métricas do
 * agente filtram por `source`, então o run de teste sai das contas de
 * produção sem ninguém precisar lembrar de excluí-lo.
 */
export type RunSource =
  | "inbox"
  | "inbox_test"
  | "playground"
  | "automation"
  | "api";

/** Limite do tool-loop — NÃO alterar sem decisão explícita (Onda 0 só observa). */
export const AGENT_MAX_STEPS = 8;

export {
  fallbackSteeringRules,
  renderSystemPrompt,
  type RenderArgs,
} from "@/lib/ai-agents/system-prompt";

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
  /// `at` só existe no histórico carregado do banco e serve para recortar a
  /// query de recuperação na conversa contígua — quem passa histórico na mão
  /// (playground) manda um bloco só e não precisa do corte.
  history?: Array<{
    role: "user" | "assistant";
    content: string;
    at?: Date | null;
  }>;
  /// `ConversationTurn.id` que originou o run (Turn Manager). Só gravado
  /// no `AIAgentRun` — não altera o comportamento do agente.
  turnId?: string | null;
  /// Sobrescreve `enabledTools` do agente neste run (classificador via
  /// automação injeta `tabulate_conversation` mesmo se o admin criou o
  /// agente com outro arquétipo).
  enabledTools?: string[];
  /// Obriga o modelo a chamar `tabulate_conversation` (run silencioso).
  forceTabulateTool?: boolean;
  /// Quantas mensagens do histórico carregar. Default `MAX_HISTORY`.
  historyLimit?: number;
  /// Só mensagens a partir deste instante (Tabulador: janela do dia).
  historySince?: Date;
  /// Recursão do orquestrador: o especialista não re-roteia.
  skipCoordinatorOrchestration?: boolean;
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
  routing?: {
    by: "orchestrator_code" | "tool";
    fromAgentId: string;
    toAgentId: string;
    reason?: string;
  };
  /// Tutorial do modelo interno casado — o inbox envia depois do texto.
  followUpMedia?: AgentFaqMedia[];
  error?: string;
};

export const MAX_HISTORY = 10;

export async function runAgent(args: RunArgs): Promise<RunResult> {
  /// Modo de teste do inbox. Único lugar onde o runner precisa saber disso —
  /// daqui em diante é `ctx.testMode` (bloqueio das tools) e o tratamento da
  /// auditoria de efeito mais abaixo.
  const testMode = args.source === "inbox_test";
  const agent = await prisma.aIAgentConfig.findUnique({
    where: { id: args.agentId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!agent) throw new Error("Agente não encontrado.");
  if (!agent.active) throw new Error("Agente inativo.");

  if (!args.skipCoordinatorOrchestration) {
    const orchestrated = await maybeOrchestrateCoordinatorTurn({
      runArgs: args,
      agent,
      runNested: (next) => runAgent(next),
    });
    if (orchestrated) return orchestrated;
  }

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

  const classifierRun = isTabulationClassifier({
    archetype: agent.archetype,
    enabledTools: args.enabledTools ?? agent.enabledTools,
    name: agent.user?.name,
  });

  const configHash = hashAgentBehaviorConfig(behaviorSliceFromAgent(agent));

  const run = await prisma.aIAgentRun.create({
    data: withOrgFromCtx({
      agentId: agent.id,
      source: args.source,
      conversationId: args.conversationId ?? null,
      contactId: args.contactId ?? null,
      turnId: args.turnId ?? null,
      status: "RUNNING" as const,
      configHash,
      llmInvoked: true,
      interceptsFired: [] as unknown as Prisma.InputJsonValue,
      stepCountReached: false,
    }),
  });

  try {
    // Chave OpenAI do agente (obrigatória — CRM multi-tenant, sem chave
    // global). Lança aqui → cai no catch e o run vira FAILED com mensagem
    // acionável ("cadastre a chave na tela do agente").
    const agentApiKey = await getAgentApiKey(agent.id);

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

    const deal =
      !classifierRun && args.dealId
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

    const timedHistory =
      args.history ??
      (await loadHistoryFromConversation(
        args.conversationId ?? null,
        args.historyLimit,
        args.historySince,
      ));
    // O modelo continua lendo a janela inteira; o `at` é só para recortar a
    // busca, e não pode vazar para as `ModelMessage` do provider.
    const history = timedHistory.map(({ role, content }) => ({
      role,
      content,
    }));

    // Só o trecho contíguo: depois de meia hora de silêncio o assunto virou
    // outro. Sem esse corte, pergunta morta de horas antes entrava na query e
    // afundava o documento que respondia a pergunta de agora.
    const priorUserMessages = trimToRecentSession(timedHistory)
      .filter((m) => m.role === "user")
      .map((m) => m.content);

    const inboxPolicyForRun = normalizeInboxPolicy(
      agent.inboxPolicy,
      agent.verticalPack,
    );

    if (!classifierRun) {
      const nonsense = nonsenseGuardReply(
        args.userMessage,
        priorUserMessages,
        inboxPolicyForRun,
      );
      if (nonsense) {
        await prisma.aIAgentRun.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED",
            outcome: "ANSWERED",
            llmInvoked: false,
            finishedAt: new Date(),
            interceptsFired: ["nonsense_guard"] as unknown as Prisma.InputJsonValue,
          },
        }).catch(() => null);
        return {
          runId: run.id,
          text: nonsense,
          status: "COMPLETED",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          autonomyMode: agent.autonomyMode,
          toolCalls: [],
        };
      }
    }

    // RAG em TODO turno. A query sai da mensagem atual + últimas mensagens
    // do cliente: com só a mensagem atual, continuações curtas ("ok", "Não
    // fez ainda?") não recuperavam nada e o turno respondia sem base.
    const knowledge = classifierRun
      ? { chunks: [], expired: [] }
      : await retrieveAgentKnowledge(
          agent.id,
          buildRetrievalQuery({
            userMessage: args.userMessage,
            priorUserMessages,
          }),
          agentApiKey,
          4,
        ).catch((err) => {
          console.warn(`[ai] RAG falhou, seguindo sem contexto: ${err}`);
          return { chunks: [], expired: [] };
        });
    const retrievedChunks = knowledge.chunks;
    const noRetrievalContext = retrievedChunks.length === 0;
    const retrievalBlock = formatRetrievalBlock(retrievedChunks);

    const qualificationQuestions = normalizeQualificationQuestions(
      agent.qualificationQuestions,
    );
    const outputStyle = normalizeOutputStyle(agent.outputStyle);

    const pack = getVerticalPack(agent.verticalPack);
    // Nome da instituição, URLs e roster do tenant: resolvidos ANTES de
    // qualquer texto de prompt do pack, que é montado de forma síncrona.
    await pack?.loadTenantConfig?.().catch(() => null);
    const packOps = pack?.ops ?? {};
    // Hints/ops de vertical: só quando o agente tem pack (não hardcoded academic).
    // Classificador não recebe pack/deal/campanha — classifica só pelas mensagens.
    const hasPack = Boolean(pack) && !classifierRun;
    // Modelos internos (tela Internos) como fonte de RAG. Era ligado por
    // `pack?.id === "academic"`, o que escondia a base do time de qualquer
    // agente genérico. Agora é configuração (default true no pack academic).
    const useMessageModelsRag =
      !classifierRun && inboxPolicyForRun.useMessageModels;
    const expiredKnowledgeBlock = formatExpiredKnowledgeBlock(
      knowledge.expired,
      inboxPolicyForRun.knowledgeExpiredInstruction,
    );
    // O que o operador escreve é absoluto. Com "Regras de atendimento"
    // preenchido, nem o texto canônico do pack nem os hints de runtime
    // (polos, prova, portal, senha, primeiro acesso, certificado) entram
    // somados: vale só o que está no agente. Campo vazio cai no pacote
    // inteiro. Tools, roteamento de departamento e interceptos seguem
    // valendo nos dois casos.
    const hasOwnRules = Boolean(agent.steeringRules?.trim());
    const packText = hasPack && !hasOwnRules;
    const retrievedModels = useMessageModelsRag
      ? await retrieveRelevantMessageModels(args.userMessage, 3).catch(
          (err) => {
            console.warn(
              `[ai] modelos internos RAG falhou, seguindo sem: ${err}`,
            );
            return [];
          },
        )
      : [];
    const messageModelsBlock = useMessageModelsRag
      ? formatMessageModelsBlock(retrievedModels)
      : "";
    const followUpMedia = pickFollowUpMedia(retrievedModels);
    // Últimos turnos: "quero sim" herda o assunto (portal/AVA) da pergunta anterior.
    const recentContextForHint = history
      .slice(-4)
      .map((m) => m.content)
      .join("\n");
    const portalAccessHint = packText
      ? (packOps.formatCanonicalPortalAccessHint?.(
          args.userMessage,
          recentContextForHint,
        ) ?? "")
      : "";
    const campaignCtx = classifierRun
      ? null
      : await loadLastCampaignDispatchContext(
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
    const examsOnlineOnly = hasPack
      ? await getOrgSettingBool("ai.exams.onlineOnly", true).catch(() => true)
      : true;
    const examAccessHint = packText
      ? (packOps.formatExamAccessHint?.(
          args.userMessage,
          [recentContextForHint, campaignCtx?.body ?? ""]
            .filter(Boolean)
            .join("\n"),
          examsOnlineOnly,
        ) ?? "")
      : "";
    const poloAddressesHint = packText
      ? (packOps.formatPoloAddressesHint?.(
          args.userMessage,
          recentContextForHint,
        ) ?? "")
      : "";
    const certificateHint = packText
      ? (packOps.formatParticipationCertificateHint?.(
          args.userMessage,
          [recentContextForHint, campaignCtx?.body ?? ""]
            .filter(Boolean)
            .join("\n"),
        ) ?? "")
      : "";
    const firstAccessHint = packText
      ? (packOps.formatFirstAccessHint?.(
          args.userMessage,
          recentContextForHint,
        ) ?? "")
      : "";
    const passwordResetHint = packText
      ? (packOps.formatPasswordResetHint?.(
          args.userMessage,
          recentContextForHint,
        ) ?? "")
      : "";
    const clockHint = hasPack ? formatLocalClockHint() : "";
    const runtimeTools = [...(args.enabledTools ?? agent.enabledTools)];
    const tabulationCatalog =
      runtimeTools.includes("tabulate_conversation") ||
      runtimeTools.includes("list_tabulations")
        ? await (async () => {
            const { loadTabulationCatalogForConversation } = await import(
              "@/services/ai/tabulation-classify"
            );
            return loadTabulationCatalogForConversation({
              organizationId: agent.organizationId,
              conversationId: args.conversationId ?? null,
            });
          })().catch(() => "")
        : "";
    const retrievalWithModels = [
      retrievalBlock,
      expiredKnowledgeBlock,
      messageModelsBlock,
      portalAccessHint,
      examAccessHint,
      poloAddressesHint,
      certificateHint,
      firstAccessHint,
      passwordResetHint,
      campaignDispatchBlock,
      clockHint,
      tabulationCatalog,
    ]
      .filter(Boolean)
      .join("\n");
    const steeringRules =
      agent.steeringRules?.trim() ||
      (packText
        ? fallbackSteeringRules(agent.archetype, agent.verticalPack)
        : "");
    const curriculumRules = packText
      ? (pack?.constants.curriculumTceRules ?? "")
      : "";
    const examModalityRules = packText
      ? (packOps.academicExamModalityRules?.(examsOnlineOnly) ?? "")
      : "";
    // Alcance da tool de cadastro. Preso ao turno em que a tool existe:
    // regra sobre ferramenta desligada é ruído no prompt. Vem por aqui e não
    // pelo texto canônico do pack porque o `steeringRules` salvo do agente
    // pode estar defasado — e aí o texto canônico não chega ao prompt.
    const enrollmentScopeRules =
      packText &&
      (pack?.extraTools ?? []).some((t) => runtimeTools.includes(t.id))
        ? (pack?.constants.enrollmentScopeRules ?? "")
        : "";
    // Gate de transferência avaliado UMA vez, com o mesmo input que as
    // tools vão usar: o prompt não pode instruir o que a tool vai recusar.
    const transferGate = evaluateTransferGate({
      verticalPack: agent.verticalPack,
      userMessage: args.userMessage,
      priorUserMessages,
      inboxPolicy: inboxPolicyForRun,
    });

    // Quem já foi identificado continua identificado, mesmo que tenha sido
    // outro agente a confirmar: o run só recebe o histórico de mensagens, e
    // sem este bloco cada transferência recomeçava a interrogar a pessoa.
    const conversationIdentity = classifierRun
      ? null
      : await loadConversationIdentity(args.conversationId);

    // O override salvo é descartado quando é a cópia velha das mesmas
    // regras que já entram por `steeringRules` — senão o mesmo documento
    // ia duas vezes para o prompt, em versões divergentes.
    const runtimeOverride = classifierRun
      ? null
      : composeRuntimeOverride({
          savedOverride: agent.systemPromptOverride,
          steeringRules,
          blocks: [
            buildUnknownAnswerBlock(inboxPolicyForRun, {
              transferBlocked: transferBlockedByGate(transferGate),
            }),
            describeConversationIdentity(conversationIdentity),
            // Sem este bloco o LLM não sabia o modo de encerramento: em "off"
            // ele ainda tentava `close_conversation` e levava erro da tool.
            buildAutoClosePromptBlock(
              normalizeAutoClosePolicy(agent.autoClosePolicy),
            ),
            examModalityRules,
            curriculumRules,
            enrollmentScopeRules,
            inboxPolicyForRun.announceAiTransfer
              ? inboxPolicyForRun.announceAiTransferMessage?.trim()
                ? `## Transferência entre agentes IA
Avise o contato com este texto (substitua {{target_agent}} pelo nome do destino):
${inboxPolicyForRun.announceAiTransferMessage.trim()}
O CRM também envia esse aviso; não invente outra frase.`
                : `## Transferência entre agentes IA
Avise em UMA frase curta via noticeMessage da tool. O destino é outro agente IA — não diga "setor" nem fila humana.`
              : `## Transferência entre agentes IA
NÃO avise o contato que vai transferir. Chame a tool e pare. Não escreva "vou te encaminhar". A troca de dono é silenciosa.`,
          ],
        });

    const [org, peerRows] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: agent.organizationId },
        select: { name: true },
      }),
      classifierRun || typeof prisma.aIAgentConfig.findMany !== "function"
        ? Promise.resolve(
            [] as Array<{
              id: string;
              archetype: string | null;
              inboxPolicy: unknown;
              user: { name: string | null } | null;
            }>,
          )
        : prisma.aIAgentConfig.findMany({
            where: {
              organizationId: agent.organizationId,
              active: true,
            },
            select: {
              id: true,
              archetype: true,
              inboxPolicy: true,
              user: { select: { name: true } },
            },
          }),
    ]);
    const peers: PeerAiAgent[] = peerRows.map((row) => ({
      id: row.id,
      name: row.user?.name?.trim() || "Agente",
      archetype: row.archetype,
      routingScope: normalizeInboxPolicy(row.inboxPolicy, agent.verticalPack)
        .routingScope,
    }));
    const coordinatorRoutingBlock =
      agent.archetype === "COORDENADOR"
        ? formatCoordinatorRoutingBlock({
            peers,
      suggested: suggestCoordinatorAiAgent(
            args.userMessage,
            peers,
            agent.verticalPack,
          ),
          })
        : null;
    const specialistPeerBlock =
      agent.archetype &&
      agent.archetype !== "COORDENADOR" &&
      agent.archetype !== "TABULACAO" &&
      agent.archetype !== "ENCERRAMENTO"
        ? formatSpecialistPeerBlock(agent.id, peers)
        : null;

    const classifierContact = classifierRun
      ? contact
        ? {
            ...contact,
            email: null,
            phone: null,
            tags: [] as typeof contact.tags,
          }
        : null
      : contact;

    const systemPrompt = renderSystemPrompt({
      template: classifierRun
        ? ARCHETYPE_MAP.TABULACAO.systemPromptTemplate
        : agent.systemPromptTemplate,
      override: runtimeOverride,
      productPolicy: agent.productPolicy,
      archetype: classifierRun ? "TABULACAO" : agent.archetype,
      hasProductSearch: runtimeTools.includes("search_products"),
      hasEnrollmentLookup: (getVerticalPack(agent.verticalPack)?.extraTools ?? []).some(
        (t) => runtimeTools.includes(t.id),
      ),
      hasCrmFieldSearch: runtimeTools.includes("search_crm_records"),
      tone: agent.tone,
      language: agent.language,
      autonomyMode: agent.autonomyMode,
      contact: classifierContact,
      deal,
      retrievalBlock: retrievalWithModels,
      qualificationQuestions,
      outputStyle,
      timezone: resolveAgentTimezone(
        humanQueueContextFromAgent({
          inboxPolicy: inboxPolicyForRun,
          businessHours: agent.businessHours,
        }),
      ),
      coordinatorRoutingBlock,
      specialistPeerBlock,
      templateVars: {
        agent_name: agent.user?.name ?? null,
        company_name: org?.name ?? null,
        deal_products: null,
        last_human_interaction: null,
      },
    });

    await prisma.aIAgentRun.update({
      where: { id: run.id },
      data: { systemPromptSnapshot: systemPrompt },
    });

    const ctx: RunContext = {
      agentUserId: agent.userId,
      agentId: agent.id,
      conversationId: args.conversationId ?? null,
      contactId: args.contactId ?? null,
      dealId: args.dealId ?? null,
      userMessage: args.userMessage,
      priorUserMessages,
      verticalPack: agent.verticalPack ?? null,
      inboxPolicy: inboxPolicyForRun,
      autoClosePolicy: normalizeAutoClosePolicy(agent.autoClosePolicy),
      testMode,
      organizationId: agent.organizationId,
      archetype: agent.archetype,
      agentName: agent.user?.name ?? null,
      peerAiAgentNames: peers
        .filter((p) => p.id !== agent.id)
        .map((p) => p.name),
    };

    const governor = new ToolCallGovernor(
      normalizeToolCallLimits({
        maxToolCallsPerRun: agent.maxToolCallsPerRun,
        maxRepeatsPerTool: agent.maxRepeatsPerTool,
      }),
    );
    const toolSet = buildToolSet(
      ctx,
      runtimeTools,
      normalizeToolConfig(agent.toolConfig),
      governor,
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

    // `maxSteps` agora existe de fato no banco; o cast antigo escondia que
    // a coluna nunca havia sido criada. 0 = usa o default do código.
    const maxSteps =
      agent.maxSteps > 0 ? agent.maxSteps : AGENT_MAX_STEPS;

    const result = await generateWithTools({
      model: agent.model || DEFAULT_CHAT_MODEL,
      apiKey: agentApiKey,
      system: systemPrompt,
      messages,
      tools: Object.keys(toolSet).length > 0 ? toolSet : undefined,
      temperature: agent.temperature,
      maxOutputTokens: agent.maxTokens,
      maxSteps,
      toolChoice:
        args.forceTabulateTool && runtimeTools.includes("tabulate_conversation")
          ? { type: "tool", toolName: "tabulate_conversation" }
          : undefined,
    });

    const stepCountReached = result.steps >= maxSteps;
    if (stepCountReached) {
      console.warn("[ai] maxSteps reached", {
        agentId: agent.id,
        conversationId: args.conversationId ?? null,
        steps: result.steps,
        maxSteps,
      });
    }

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

    // Guarda determinística: o modelo prometia ao cliente transferências que
    // a tool tinha recusado. Compara o texto com o resultado real e descarta
    // a resposta quando ela afirma efeito que não aconteceu.
    const effectAudit = auditEffectClaims({
      text: result.text,
      toolCalls: result.toolCalls,
    });
    // Em modo de teste "não aconteceu" é o comportamento CORRETO — a
    // ferramenta foi deliberadamente não executada — então a auditoria deixa
    // de ser guardrail e vira diagnóstico: continua rodando e continua
    // listando os efeitos afirmados, mas não troca o texto por
    // `NEUTRAL_EFFECT_FALLBACK` nem marca a resposta como descartada. Trocar
    // seria esconder do operador exatamente o que ele foi ver: a resposta que
    // o cliente receberia. A auditoria de produção fica intacta.
    const claimBlocked = effectAudit.blocked && !testMode;
    const selfUserId = agent.userId;
    const aiHandoffAway = result.toolCalls.some((c) => {
      const payload = c.result;
      if (!payload || typeof payload !== "object") return false;
      if ((payload as { ok?: unknown }).ok === false) return false;
      const isAiTool =
        c.toolName === "transfer_to_ai_agent" ||
        (c.toolName === "transfer_conversation" &&
          c.args &&
          typeof c.args === "object" &&
          !Array.isArray(c.args) &&
          (c.args as { target?: unknown }).target === "ai_agent");
      if (!isAiTool) return false;
      // Destino pelo id que a tool resolveu, não pelo nome que o modelo
      // escreveu: nome é editável, acentuado e pode repetir entre agentes —
      // com dois "Atendimento" a comparação por nome dizia "é você mesmo" e
      // engolia a fala de um handoff que aconteceu de verdade.
      const destUserId = String(
        (payload as { targetAgentUserId?: unknown }).targetAgentUserId ?? "",
      ).trim();
      if (!destUserId) return (payload as { assigned?: unknown }).assigned === true;
      return destUserId !== selfUserId;
    });
    // O modelo escreve "vou te encaminhar" mesmo com o interruptor desligado.
    // Aviso oficial: tool envia em produção. Aqui só devolvemos texto no
    // replay/teste (tool simulada) quando o interruptor está ligado.
    // Transferência para o PRÓPRIO agente não é troca de dono — não zera a fala.
    let finalText = claimBlocked ? NEUTRAL_EFFECT_FALLBACK : result.text;
    if (!claimBlocked && aiHandoffAway) {
      if (!inboxPolicyForRun.announceAiTransfer) {
        finalText = "";
      } else if (testMode) {
        const call = result.toolCalls.find(
          (c) =>
            c.toolName === "transfer_to_ai_agent" ||
            c.toolName === "transfer_conversation",
        );
        const args =
          call?.args && typeof call.args === "object" && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>)
            : {};
        const dest = String(
          args.agentName ?? args.name ?? "o especialista",
        ).trim();
        const canned = inboxPolicyForRun.announceAiTransferMessage?.trim();
        finalText = canned
          ? canned.replaceAll("{{target_agent}}", dest)
          : String(args.noticeMessage ?? "").trim() ||
            `Vou te passar para ${dest}, que segue com você daqui.`;
      } else {
        finalText = "";
      }
    }
    if (claimBlocked) {
      console.warn("[ai] resposta descartada — efeito afirmado sem execução", {
        agentId: agent.id,
        conversationId: args.conversationId ?? null,
        unsupported: effectAudit.unsupported,
      });
      await prisma.aIAgentMessage.create({
        data: withOrgFromCtx({
          runId: run.id,
          role: "system",
          content: `[guardrail] resposta descartada: afirmou ${effectAudit.unsupported.join(", ")} sem ferramenta bem-sucedida`,
          toolData: {
            unsupported: effectAudit.unsupported,
            achieved: effectAudit.achieved,
            discardedText: result.text.slice(0, 1000),
          } as Prisma.InputJsonValue,
        }),
      }).catch(() => null);
    }

    const costUsd = estimateCost(
      agent.model,
      result.inputTokens,
      result.outputTokens,
    );

    // Outcome derivado do ESTADO FINAL: relê a atribuição da conversa depois
    // das tools. O código antigo olhava só o NOME da tool chamada e gravava
    // HANDOFF em 26 runs cuja conversa continuou com a IA.
    const finalAssigneeType = args.conversationId
      ? (
          await prisma.conversation.findUnique({
            where: { id: args.conversationId },
            select: { assignedTo: { select: { type: true } } },
          })
        )?.assignedTo?.type ?? null
      : null;

    const outcome = deriveRunOutcome({
      toolCalls: result.toolCalls,
      finalAssigneeType,
      limitReached: stepCountReached || governor.limitHit,
      noRetrievalContext,
      // Sem isto, resposta vazia ou barrada pelo guardrail ainda era gravada
      // como ANSWERED. Quem confirma a entrega de fato é o inbox
      // (`markRunResponseDiscarded`).
      responseText: finalText,
      responseDiscarded: claimBlocked,
    });
    const status: RunResult["status"] = statusForOutcome(outcome);

    if (governor.limitHit || governor.replays > 0) {
      console.warn("[ai] tetos de tool acionados", {
        agentId: agent.id,
        conversationId: args.conversationId ?? null,
        ...governor.stats(),
      });
    }

    await prisma.aIAgentRun.update({
      where: { id: run.id },
      data: {
        status,
        outcome,
        handoffReason:
          outcome === "HANDOFF_COMPLETED"
            ? "tool_transfer"
            : outcome === "HANDOFF_QUEUED"
              ? "tool_transfer_queued"
              : null,
        errorMessage:
          outcome === "RESPONSE_DISCARDED"
            ? claimBlocked
              ? `[descartada] effect_claim_blocked: afirmou ${effectAudit.unsupported.join(", ")} sem ferramenta bem-sucedida`
              : "[descartada] empty_reply: modelo devolveu resposta vazia"
            : null,
        responsePreview: finalText.slice(0, 500),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd,
        finishedAt: new Date(),
        systemPromptSnapshot: systemPrompt,
        configHash,
        llmInvoked: true,
        stepCountReached,
      },
    });

    return {
      runId: run.id,
      text: finalText,
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
      followUpMedia: status === "COMPLETED" ? followUpMedia : [],
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
  take = MAX_HISTORY,
  since?: Date,
): Promise<
  Array<{ role: "user" | "assistant"; content: string; at: Date | null }>
> {
  if (!conversationId) return [];
  const msgs = await prisma.message.findMany({
    where: {
      conversationId,
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(take, 1), 80),
    select: {
      content: true,
      direction: true,
      messageType: true,
      templateConfigId: true,
      senderName: true,
      createdAt: true,
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
        at: m.createdAt ?? null,
      };
    }),
  );
  return hydrated;
}
