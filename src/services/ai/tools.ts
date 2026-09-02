/**
 * Tools disponíveis para agentes de IA.
 *
 * Cada tool é exposta como um objeto do Vercel AI SDK (via helper
 * `tool({...})`). O runner monta o `ToolSet` que vai pro LLM chamando
 * `buildToolSet(ctx, enabledIds)` — com isso apenas as tools que o
 * admin marcou em `AIAgentConfig.enabledTools` ficam disponíveis pra
 * aquele agente específico.
 *
 * Reaproveitamos os services existentes (deals, activities, tags...)
 * em vez de duplicar lógica. Os erros são capturados e devolvidos
 * como `{ ok: false, error }` pra que o LLM possa raciocinar sobre
 * falhas em vez de derrubar a run inteira.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import {
  renderTemplatePreview,
  templateVariablesFromSendComponents,
} from "@/lib/meta-whatsapp/build-template-components";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { enrichTemplateComponentsForFlowSend } from "@/lib/meta-whatsapp/enrich-template-flow";
import { buildOutboundTemplateMessageContent } from "@/lib/whatsapp-outbound-template-label";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";
import { sseBus } from "@/lib/sse-bus";
import { lookupStudent } from "@/services/academic-records";
import { createActivity } from "@/services/activities";
import { notifyDealStageChanged } from "@/services/automation-triggers";
import { createDeal, createDealEvent, updateDeal } from "@/services/deals";
import { executeDistribution } from "@/services/distribution";
import { addTagToContact } from "@/services/tags";
import {
  resolveDepartmentByName,
  resolveDepartmentByKey,
  messageImpliesRematricula,
  messageImpliesOperationalAtendimento,
  executeAcademicDepartmentHandoff,
  enforceAtendimentoIfAcolhimentoBlocked,
} from "@/services/ai/academic-department-routing";
import { closeAiOnlyConversation } from "@/services/ai/academic-closure";
import type { ActivityType, Prisma } from "@prisma/client";

export type RunContext = {
  /// User.id do agente AI (para logar autoria em atividades, deals etc).
  agentUserId: string;
  /// ID do agente (AIAgentConfig.id) — opcional, para auditoria.
  agentId?: string;
  /// Conversa em curso (se aplicável). Quase todas as tools precisam dela
  /// pra enviar mensagens ou abrir ticket.
  conversationId?: string | null;
  /// Contato em curso.
  contactId?: string | null;
  /// Deal em curso (se houver um aberto para este contato).
  dealId?: string | null;
  /// Última mensagem do aluno (para inferir departamento no handoff).
  userMessage?: string | null;
};

function ok<T>(data: T) {
  return { ok: true as const, ...data } as { ok: true } & T;
}
function fail(error: string) {
  return { ok: false as const, error };
}

// ── create_deal ────────────────────────────────────────────────

function createDealTool(ctx: RunContext) {
  return tool({
    description:
      "Cria um novo deal (oportunidade) no primeiro estágio do pipeline padrão, associado ao contato atual. Use quando qualificar um lead novo e quiser registrar a oportunidade.",
    inputSchema: z.object({
      title: z.string().min(3).describe("Título curto do deal, ex: 'Curso de inglês — João Silva'."),
      value: z
        .number()
        .optional()
        .describe("Valor estimado em BRL. Omita se ainda não souber."),
      notes: z
        .string()
        .optional()
        .describe("Observação opcional a ser registrada como primeira atividade do deal."),
    }),
    execute: async ({ title, value, notes }) => {
      try {
        if (!ctx.contactId) return fail("Sem contato associado para criar deal.");
        const defaultPipeline = await prisma.pipeline.findFirst({
          where: { isDefault: true, archivedAt: null },
          include: { stages: { orderBy: { position: "asc" }, take: 1 } },
        });
        const stage = defaultPipeline?.stages[0];
        if (!stage) return fail("Pipeline padrão sem estágios configurados.");
        const deal = await createDeal({
          title,
          value,
          contactId: ctx.contactId,
          stageId: stage.id,
          ownerId: ctx.agentUserId,
        });
        if (notes?.trim()) {
          await createActivity({
            type: "NOTE",
            title: "Nota do agente IA",
            description: notes.trim(),
            completed: true,
            dealId: deal.id,
            contactId: ctx.contactId,
            userId: ctx.agentUserId,
            createdById: ctx.agentUserId,
          }).catch(() => null);
        }
        createDealEvent(deal.id, ctx.agentUserId, "AI_AGENT_ACTION", {
          action: "created_deal",
          agentId: ctx.agentId ?? null,
          title: deal.title,
          value: value ?? null,
        }).catch(() => {});
        return ok({ dealId: deal.id, title: deal.title });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "Falha ao criar deal.");
      }
    },
  });
}

// ── move_stage ─────────────────────────────────────────────────

function moveStageTool(ctx: RunContext) {
  return tool({
    description:
      "Move o deal atual para outro estágio (pode ser em outro funil). Use quando o lead avançar na jornada ou precisar migrar para outro pipeline (ex.: de 'Qualificação' para 'Proposta', ou de 'Vendas' → 'Pós-venda'). Informe `pipelineName` quando o estágio pertence a um funil diferente do atual.",
    inputSchema: z.object({
      stageName: z
        .string()
        .describe("Nome do estágio de destino (match case-insensitive, ex: 'Proposta')."),
      pipelineName: z
        .string()
        .optional()
        .describe(
          "Nome do funil de destino quando diferente do atual (case-insensitive). Se omitido, procura o estágio primeiro no funil atual e, em seguida, entre todos os funis (falha se houver ambiguidade).",
        ),
      reason: z
        .string()
        .optional()
        .describe("Motivo do movimento; vira nota anexada ao deal."),
    }),
    execute: async ({ stageName, pipelineName, reason }) => {
      try {
        if (!ctx.dealId) return fail("Sem deal ativo para mover.");
        const deal = await prisma.deal.findUnique({
          where: { id: ctx.dealId },
          select: { id: true, stageId: true, stage: { select: { pipelineId: true } } },
        });
        if (!deal) return fail("Deal não encontrado.");

        // Resolução do estágio de destino:
        // 1) Com `pipelineName` explícito: procura o funil por nome e o
        //    estágio dentro dele.
        // 2) Sem `pipelineName`: tenta primeiro o funil atual do deal e,
        //    caso não encontre, faz busca global. Ambiguidade global
        //    (mais de um funil com estágio de mesmo nome) falha pedindo
        //    o funil explícito.
        let target: { id: string; name: string; pipelineId: string } | null = null;
        if (pipelineName?.trim()) {
          const pipe = await prisma.pipeline.findFirst({
            where: { name: { equals: pipelineName.trim(), mode: "insensitive" } },
            select: { id: true, name: true },
          });
          if (!pipe) return fail(`Funil "${pipelineName}" não encontrado.`);
          target = await prisma.stage.findFirst({
            where: {
              pipelineId: pipe.id,
              name: { equals: stageName, mode: "insensitive" },
            },
            select: { id: true, name: true, pipelineId: true },
          });
          if (!target)
            return fail(`Estágio "${stageName}" não existe no funil "${pipe.name}".`);
        } else {
          target = await prisma.stage.findFirst({
            where: {
              pipelineId: deal.stage.pipelineId,
              name: { equals: stageName, mode: "insensitive" },
            },
            select: { id: true, name: true, pipelineId: true },
          });
          if (!target) {
            const candidates = await prisma.stage.findMany({
              where: { name: { equals: stageName, mode: "insensitive" } },
              select: {
                id: true,
                name: true,
                pipelineId: true,
                pipeline: { select: { name: true } },
              },
              take: 5,
            });
            if (candidates.length === 0)
              return fail(`Estágio "${stageName}" não existe em nenhum funil.`);
            if (candidates.length > 1) {
              const names = candidates.map((c) => `"${c.pipeline?.name ?? c.pipelineId}"`).join(", ");
              return fail(
                `Estágio "${stageName}" existe em vários funis (${names}). Informe pipelineName.`,
              );
            }
            target = {
              id: candidates[0].id,
              name: candidates[0].name,
              pipelineId: candidates[0].pipelineId,
            };
          }
        }
        await updateDeal(deal.id, { stageId: target.id });
        // Dispara "mudança de fase" quando a IA move o negócio — antes esse
        // caminho só registrava AI_AGENT_ACTION e não acionava automações.
        if (deal.stageId !== target.id) {
          void notifyDealStageChanged(deal.id, deal.stageId, target.id, {
            contactId: ctx.contactId ?? undefined,
            depth: 0,
          });
        }
        createDealEvent(deal.id, ctx.agentUserId, "AI_AGENT_ACTION", {
          action: "moved_stage",
          agentId: ctx.agentId ?? null,
          stageId: target.id,
          stageName: target.name,
          reason: reason?.trim() ?? null,
        }).catch(() => {});
        if (reason?.trim() && ctx.contactId) {
          await createActivity({
            type: "NOTE",
            title: `Movido para ${target.name}`,
            description: reason.trim(),
            completed: true,
            dealId: deal.id,
            contactId: ctx.contactId,
            userId: ctx.agentUserId,
            createdById: ctx.agentUserId,
          }).catch(() => null);
        }
        return ok({ stageId: target.id, stageName: target.name });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "Falha ao mover deal.");
      }
    },
  });
}

// ── add_tag ────────────────────────────────────────────────────

function addTagTool(ctx: RunContext) {
  return tool({
    description:
      "Adiciona uma tag ao contato atual. Se a tag não existir, ela é criada. Útil para segmentar leads por interesse, origem ou qualificação.",
    inputSchema: z.object({
      tagName: z.string().min(1).describe("Nome da tag, ex: 'Interessado em premium'."),
    }),
    execute: async ({ tagName }) => {
      try {
        if (!ctx.contactId) return fail("Sem contato para marcar.");
        const name = tagName.trim();
        if (!name) return fail("Nome de tag vazio.");
        let tag = await prisma.tag.findFirst({
          where: { name: { equals: name, mode: "insensitive" } },
          select: { id: true, name: true },
        });
        if (!tag) {
          tag = await prisma.tag.create({
            data: withOrgFromCtx({ name, color: "#64748b" }),
            select: { id: true, name: true },
          });
        }
        const already = await prisma.tagOnContact.findFirst({
          where: { contactId: ctx.contactId, tagId: tag.id },
          select: { contactId: true },
        });
        if (!already) {
          await addTagToContact(ctx.contactId, tag.id);
        }
        if (ctx.dealId && !already) {
          createDealEvent(ctx.dealId, ctx.agentUserId, "AI_AGENT_ACTION", {
            action: "added_tag",
            agentId: ctx.agentId ?? null,
            tagName: tag.name,
          }).catch(() => {});
        }
        return ok({ tagId: tag.id, tagName: tag.name, alreadyHad: !!already });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "Falha ao marcar tag.");
      }
    },
  });
}

// ── create_activity ────────────────────────────────────────────

const ACTIVITY_TYPES = ["CALL", "EMAIL", "MEETING", "TASK", "NOTE", "WHATSAPP", "OTHER"] as const;

function createActivityTool(ctx: RunContext) {
  return tool({
    description:
      "Registra uma atividade ou follow-up vinculado ao contato/deal atual. Útil para 'ligar amanhã 15h' ou deixar uma nota pro time comercial.",
    inputSchema: z.object({
      type: z.enum(ACTIVITY_TYPES).describe("Tipo (CALL, TASK, NOTE, MEETING...)"),
      title: z.string().min(3),
      description: z.string().optional(),
      scheduledAt: z
        .string()
        .optional()
        .describe("ISO 8601 — ex: '2026-05-01T15:00:00-03:00'. Omita para nota sem data."),
    }),
    execute: async ({ type, title, description, scheduledAt }) => {
      try {
        const activity = await createActivity({
          type: type as ActivityType,
          title,
          description,
          scheduledAt: scheduledAt ?? undefined,
          completed: type === "NOTE",
          contactId: ctx.contactId ?? undefined,
          dealId: ctx.dealId ?? undefined,
          userId: ctx.agentUserId,
          createdById: ctx.agentUserId,
        });
        return ok({ activityId: activity.id });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "Falha ao criar atividade.");
      }
    },
  });
}

// ── send_whatsapp_template ─────────────────────────────────────

function sendWhatsappTemplateTool(ctx: RunContext) {
  return tool({
    description:
      "Envia um template aprovado pela Meta para o contato atual via WhatsApp. Use para reengajar após janela de 24h ou enviar propostas padronizadas. O template deve existir em /templates.",
    inputSchema: z.object({
      templateName: z.string().describe("Nome exato do template aprovado."),
      languageCode: z.string().default("pt_BR").optional(),
      bodyVariables: z
        .array(z.string())
        .optional()
        .describe("Variáveis de {{1}}, {{2}}... do template, em ordem."),
    }),
    execute: async ({ templateName, languageCode, bodyVariables }) => {
      try {
        if (!ctx.contactId) return fail("Sem contato.");
        // Multi-tenancy: resolve o cliente Meta a partir do canal da
        // conversa atual em vez do singleton global. Sem isso, o LLM da
        // org B chamaria sendTemplate pelo numero da Eduit (env vars).
        if (!ctx.conversationId) return fail("Sem conversa ativa.");
        const conv = await prisma.conversation.findUnique({
          where: { id: ctx.conversationId },
          select: {
            organizationId: true,
            channelRef: { select: { config: true } },
          },
        });
        if (!conv) return fail("Conversa não encontrada.");
        const channelConfig = conv.channelRef?.config as
          | Record<string, unknown>
          | null
          | undefined;
        const metaClient = metaClientFromConfig(channelConfig);
        if (!metaClient.configured) return fail("Canal Meta não configurado.");
        const contact = await prisma.contact.findUnique({
          where: { id: ctx.contactId },
          select: { phone: true },
        });
        if (!contact?.phone) return fail("Contato sem telefone.");
        const lc = languageCode ?? "pt_BR";
        let templateGraphId: string | null = null;
        // Capturar `id` aqui para gravar `templateConfigId` no message.create
        // — assim o resolver de Flow inbound identifica corretamente o flow
        // disparado pelo Agente IA quando o cliente responder.
        let tplConfigId: string | null = null;
        let tplBodyPreview: string | null = null;
        let tplCategory: string | null = null;
        try {
          const gidRow = await prisma.whatsAppTemplateConfig.findFirst({
            where: { metaTemplateName: templateName },
            select: { id: true, metaTemplateId: true, bodyPreview: true, category: true },
          });
          templateGraphId = gidRow?.metaTemplateId?.trim() || null;
          tplConfigId = gidRow?.id ?? null;
          tplBodyPreview = gidRow?.bodyPreview?.trim() || null;
          tplCategory = gidRow?.category ?? null;
        } catch {
          /* ignore */
        }
        const baseComponents =
          Array.isArray(bodyVariables) && bodyVariables.length > 0
            ? [
                {
                  type: "body",
                  parameters: bodyVariables.map((text) => ({
                    type: "text" as const,
                    text,
                  })),
                },
              ]
            : undefined;
        const renderedTplBody = tplBodyPreview
          ? renderTemplatePreview(
              tplBodyPreview,
              templateVariablesFromSendComponents(baseComponents),
            ) || tplBodyPreview
          : null;
        const tplChatContent = buildOutboundTemplateMessageContent(
          templateName,
          "generic",
          tplCategory,
          renderedTplBody,
        );
        const enrichSend = await enrichTemplateComponentsForFlowSend(metaClient, {
          templateName,
          languageCode: lc,
          components: baseComponents,
          templateGraphId,
        });
        const res = await metaClient.sendTemplate(
          contact.phone,
          templateName,
          lc,
          enrichSend.components,
        );
        const externalId = res?.messages?.[0]?.id ?? null;
        const saved = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId: ctx.conversationId,
            content: tplChatContent,
            direction: "out",
            messageType: "template",
            senderName: "Agente IA",
            externalId,
            aiAgentUserId: ctx.agentUserId,
            ...(typeof enrichSend.flowToken === "string" && enrichSend.flowToken.trim()
              ? { flowToken: enrichSend.flowToken.trim() }
              : {}),
            ...(tplConfigId ? { templateConfigId: tplConfigId } : {}),
          }),
        });
        await prisma.conversation
          .update({
            where: { id: ctx.conversationId },
            data: {
              lastMessageDirection: "out",
              hasAgentReply: true,
              updatedAt: new Date(),
            },
          })
          .catch(() => null);
        sseBus.publish("new_message", {
          organizationId: conv.organizationId,
          conversationId: ctx.conversationId,
          contactId: ctx.contactId,
          direction: "out",
          content: saved.content,
          timestamp: saved.createdAt,
        });
        return ok({ externalId, templateName });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "Falha ao enviar template.");
      }
    },
  });
}

// ── search_products ────────────────────────────────────────────

/**
 * Tool de consulta ao catálogo de produtos/serviços.
 *
 * É a fonte de verdade pro agente responder preço, descrição, SKU,
 * tipo. O system prompt injeta uma política de apresentação (campo
 * `productPolicy` do AIAgentConfig) que orienta COMO o LLM deve
 * expor os dados devolvidos aqui.
 *
 * Busca é TOLERANTE A ACENTOS (normalização NFD) e MULTI-PALAVRA —
 * porque `contains` do Postgres é case-insensitive mas NÃO
 * accent-insensitive, e o LLM frequentemente manda variações
 * ("administracao", "curso de administração", etc.). Nós trazemos
 * os candidatos ativos e filtramos em memória, rankeando por quão
 * bem o termo bate no nome. Custom fields (modalidade, duração,
 * etc.) também entram no haystack pra cobrir perguntas por
 * atributo (ex.: "curso EAD", "4 anos").
 *
 * Sempre devolvemos preço como número + string formatada em BRL —
 * o LLM tende a errar menos usando a versão já formatada.
 */

/** Normaliza string pra busca: lowercase + remove acentos. */
function normalizeForSearch(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function searchProductsTool(_ctx: RunContext) {
  return tool({
    description:
      "Busca produtos, serviços ou cursos no catálogo interno por nome, SKU, descrição ou atributos. Use SEMPRE antes de responder sobre preço, modalidade, duração, características ou disponibilidade — nunca invente esses dados. Busca tolera acentos e múltiplas palavras. Retorna até 5 itens com preço formatado em BRL e campos personalizados (modalidade, carga horária, etc.).",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Termo de busca livre. Ex.: 'Administração', 'curso EAD', 'ABC-001', 'direito presencial'. A busca tolera acentos e procura em nome, SKU, descrição e campos personalizados.",
        ),
      type: z
        .enum(["PRODUCT", "SERVICE"])
        .optional()
        .describe(
          "Filtro opcional pelo tipo. Use 'PRODUCT' para produtos/cursos ou 'SERVICE' para serviços. Omita para buscar em todos.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Máximo de itens a retornar (1-20, padrão 5)."),
    }),
    execute: async ({ query, type, limit }) => {
      try {
        const term = query.trim();
        if (!term) return fail("Busca vazia.");
        const take = Math.min(Math.max(limit ?? 5, 1), 20);

        const where: Prisma.ProductWhereInput = { isActive: true };
        if (type) where.type = type;

        // Traz todos os candidatos ativos (limitado pra não estourar
        // memória em catálogos gigantes). Em catálogos >500 itens
        // vale migrar pra índice pg_trgm + unaccent no Postgres.
        const candidates = await prisma.product.findMany({
          where,
          take: 500,
          orderBy: [{ name: "asc" }],
          include: {
            customValues: {
              include: {
                customField: {
                  select: { id: true, name: true, label: true, type: true },
                },
              },
            },
          },
        });

        const termN = normalizeForSearch(term);
        const words = termN.split(/\s+/).filter((w) => w.length >= 2);

        type WithScore = { product: (typeof candidates)[number]; score: number };
        const scored: WithScore[] = [];

        for (const p of candidates) {
          const nameN = normalizeForSearch(p.name);
          const skuN = normalizeForSearch(p.sku);
          const descN = normalizeForSearch(p.description);
          const cfN = p.customValues
            .map((v) => normalizeForSearch(v.value))
            .join(" ");
          const haystack = `${nameN} ${skuN} ${descN} ${cfN}`;

          // Match principal: termo inteiro aparece em nome/sku (ranking alto)
          // Fallback: TODAS as palavras (>=2 chars) aparecem em qualquer campo
          let score = 0;
          if (termN && nameN.includes(termN)) score = 100;
          else if (termN && skuN.includes(termN)) score = 80;
          else if (
            words.length > 0 &&
            words.every((w) => haystack.includes(w))
          ) {
            // score cresce conforme as palavras baterem no nome especificamente
            score =
              30 +
              words.filter((w) => nameN.includes(w)).length * 10;
          }

          if (score > 0) scored.push({ product: p, score });
        }

        scored.sort((a, b) => b.score - a.score);
        const matched = scored.slice(0, take).map((s) => s.product);

        if (matched.length === 0) {
          return ok({
            query: term,
            total: 0,
            products: [],
            hint:
              "Nenhum produto ativo encontrado para este termo. Não invente dados — diga que vai confirmar com o time e ofereça handoff humano.",
          });
        }

        const fmtBRL = new Intl.NumberFormat("pt-BR", {
          style: "currency",
          currency: "BRL",
        });

        const serialized = matched.map((p) => {
          const priceNum = Number(p.price);
          return {
            id: p.id,
            name: p.name,
            sku: p.sku,
            type: p.type,
            unit: p.unit,
            price: priceNum,
            priceFormatted: fmtBRL.format(priceNum),
            description: p.description ?? null,
            customFields: p.customValues
              .filter((v) => v.value && v.value.trim())
              .map((v) => ({
                name: v.customField.name,
                label: v.customField.label,
                value: v.value,
              })),
          };
        });

        return ok({
          query: term,
          total: serialized.length,
          products: serialized,
        });
      } catch (err) {
        return fail(
          err instanceof Error ? err.message : "Falha ao buscar produtos.",
        );
      }
    },
  });
}

// ── transfer_to_human ──────────────────────────────────────────

function transferToHumanTool(ctx: RunContext) {
  return tool({
    description:
      "Transfere a conversa para um consultor humano via Distribuição Inteligente. " +
      "Use SOMENTE quando: o aluno pedir humano/consultor, for retenção, ou você NÃO puder " +
      "continuar atendendo com segurança (sem base nas refs / confiança baixa). " +
      "Se você puder orientar o aluno, NÃO chame esta tool — responda você. " +
      "Quando chamar, a distribuição EXECUTA de verdade; confirme ao aluno que um consultor vai ajudar. " +
      "Prefira `departmentName` (Acolhimento / Retenção / Atendimento). Se omitir, o sistema infere.",
    inputSchema: z.object({
      reason: z
        .string()
        .describe(
          "Motivo curto do handoff, para o atendente ler (ex: 'Cliente pediu cancelar matrícula').",
        ),
      departmentName: z
        .string()
        .optional()
        .describe(
          "Acolhimento | Retenção | Atendimento (ou Atendimento - SAC).",
        ),
    }),
    execute: async ({ reason, departmentName }) => {
      try {
        if (!ctx.conversationId) return fail("Sem conversa ativa.");
        // Chamou a tool = decidiu não seguir atendendo → distribui de fato.
        // "Atender primeiro" é orientação de QUANDO chamar, não um bloqueio aqui.
        const result = await executeAcademicDepartmentHandoff({
          conversationId: ctx.conversationId,
          contactId: ctx.contactId,
          dealId: ctx.dealId,
          departmentName: departmentName ?? null,
          userMessage: ctx.userMessage ?? null,
          reason,
        });
        if (ctx.contactId) {
          await createActivity({
            type: "NOTE",
            title: "Transferência IA → humano",
            description: [
              reason,
              result.departmentName
                ? `Dept: ${result.departmentName}`
                : null,
              result.distribution?.selectedUserName
                ? `Atribuído: ${result.distribution.selectedUserName}`
                : result.distribution?.reason
                  ? `Distribuição: ${result.distribution.reason}`
                  : null,
            ]
              .filter(Boolean)
              .join(" | "),
            completed: true,
            contactId: ctx.contactId,
            dealId: ctx.dealId ?? undefined,
            userId: ctx.agentUserId,
            createdById: ctx.agentUserId,
          }).catch(() => null);
        }
        sseBus.publish(
          result.distribution?.selectedUserId
            ? "conversation_assigned"
            : "conversation_unassigned",
          {
            organizationId: getOrgIdOrNull(),
            conversationId: ctx.conversationId,
            contactId: ctx.contactId,
            assignedToId: result.distribution?.selectedUserId ?? null,
            reason,
          },
        );
        if (ctx.dealId) {
          createDealEvent(ctx.dealId, ctx.agentUserId, "AI_AGENT_ACTION", {
            action: "transferred_to_human",
            agentId: ctx.agentId ?? null,
            reason,
            departmentId: result.departmentId,
            departmentName: result.departmentName,
            selectedUserId: result.distribution?.selectedUserId ?? null,
          }).catch(() => {});
        }
        const queuedWaiting =
          result.distribution?.reason === "NO_ELIGIBLE_RESPONSIBLE" ||
          result.distribution?.reason === "NO_DEPARTMENT";
        return ok({
          transferred: true,
          departmentName: result.departmentName,
          assigned: Boolean(result.distribution?.success),
          assignedTo: result.distribution?.selectedUserName ?? null,
          distributionReason: result.distribution?.reason ?? null,
          queuedWaiting,
          hint: queuedWaiting
            ? "Lead na fila (sem consultor elegível agora). Avise UMA vez com empatia: já registrou o pedido. Fora do expediente (antes das 8h/9h ou a partir das 18h30) diga que o atendimento humano retoma no horário (seg–sex 8h–19h, sáb 9h–16h). Dentro do expediente: NÃO diga 'ninguém disponível' nem 'em breve' — diga que a equipe continua quando puder. Ofereça continuar ajudando. NÃO repita."
            : undefined,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "Falha ao transferir.");
      }
    },
  });
}

// ── transfer_to_department ─────────────────────────────────────

function transferToDepartmentTool(ctx: RunContext) {
  return tool({
    description:
      "Roteia a conversa atual para um departamento (ex.: 'Acolhimento', 'Retenção', 'Atendimento - SAC') com base no assunto do aluno. NÃO tira a conversa do agente — apenas define o departamento responsável, que é usado pela Distribuição Inteligente para escolher o consultor certo. Chame ANTES de `execute_distribution` quando souber a área; o `execute_distribution` subsequente preserva o departamento já definido aqui. Match do nome é case-insensitive.",
    inputSchema: z.object({
      departmentName: z
        .string()
        .min(1)
        .describe(
          "Nome do departamento de destino (ex.: 'Acolhimento', 'Retenção', 'Atendimento - SAC').",
        ),
    }),
    execute: async ({ departmentName }) => {
      try {
        if (!ctx.conversationId) return fail("Sem conversa ativa para rotear.");
        const name = departmentName.trim();
        if (!name) return fail("Nome de departamento vazio.");

        // Últimas inbound — rematrícula / operacional forçam Atendimento
        // (mesmo se o LLM mandar Acolhimento).
        const recentIn = await prisma.message.findMany({
          where: {
            conversationId: ctx.conversationId,
            direction: "in",
            isPrivate: false,
          },
          orderBy: { createdAt: "desc" },
          take: 6,
          select: { content: true },
        });
        const inboundBlob = recentIn.map((m) => m.content ?? "").join("\n");
        let dept =
          messageImpliesRematricula(inboundBlob) ||
          messageImpliesOperationalAtendimento(inboundBlob)
            ? await resolveDepartmentByKey("atendimento")
            : null;
        if (!dept) dept = await resolveDepartmentByName(name);
        if (!dept)
          return fail(
            `Departamento "${name}" não encontrado. Use Acolhimento, Retenção ou Atendimento.`,
          );
        dept = await enforceAtendimentoIfAcolhimentoBlocked({
          contactId: ctx.contactId,
          dept,
        });
        if (!dept)
          return fail(
            `Departamento "${name}" não encontrado. Use Acolhimento, Retenção ou Atendimento.`,
          );
        await prisma.conversation.update({
          where: { id: ctx.conversationId },
          data: { departmentId: dept.id, updatedAt: new Date() },
        });
        if (ctx.dealId) {
          createDealEvent(ctx.dealId, ctx.agentUserId, "AI_AGENT_ACTION", {
            action: "transferred_to_department",
            agentId: ctx.agentId ?? null,
            departmentId: dept.id,
            departmentName: dept.name,
          }).catch(() => {});
        }
        return ok({ departmentId: dept.id, departmentName: dept.name });
      } catch (err) {
        return fail(
          err instanceof Error ? err.message : "Falha ao rotear departamento.",
        );
      }
    },
  });
}

// ── execute_distribution ───────────────────────────────────────

function executeDistributionTool(ctx: RunContext) {
  return tool({
    description:
      "Aciona a Distribuição Inteligente para atribuir a conversa/negócio a um consultor humano. O motor escolhe automaticamente quem recebe (menor fila, dentro do departamento roteado, respeitando horário e disponibilidade) — você NÃO escolhe a pessoa. Se souber a área, chame `transfer_to_department` antes (ou informe `departmentName` aqui). Se ninguém estiver disponível, o lead entra na fila de espera e será redistribuído depois. Use quando o caso precisar de um atendente humano.",
    inputSchema: z.object({
      departmentName: z
        .string()
        .optional()
        .describe(
          "Departamento-alvo (opcional). Se omitido, usa o departamento já roteado na conversa. Ex.: 'Retenção'.",
        ),
      reason: z
        .string()
        .optional()
        .describe("Motivo curto do encaminhamento, para registro."),
    }),
    execute: async ({ departmentName, reason }) => {
      try {
        if (!ctx.contactId && !ctx.dealId)
          return fail("Sem contato/negócio para distribuir.");

        // Se a conversa está na IA, usa o handoff acadêmico (limpa assignee +
        // dept + reassign). Evita early-return "ASSIGNED" mantendo a IA.
        if (ctx.conversationId) {
          const conv = await prisma.conversation.findUnique({
            where: { id: ctx.conversationId },
            select: { assignedTo: { select: { type: true } } },
          });
          if (conv?.assignedTo?.type === "AI") {
            // Tool chamada = handoff intencional. Não adiar (evita promessa
            // "vou conectar" sem fila real).
            const handoff = await executeAcademicDepartmentHandoff({
              conversationId: ctx.conversationId,
              contactId: ctx.contactId ?? null,
              dealId: ctx.dealId,
              departmentName: departmentName ?? null,
              userMessage: ctx.userMessage ?? null,
              reason: reason ?? "execute_distribution via IA",
            });
            const queuedWaiting =
              handoff.distribution?.reason === "NO_ELIGIBLE_RESPONSIBLE" ||
              handoff.distribution?.reason === "NO_DEPARTMENT";
            return ok({
              assigned: Boolean(handoff.distribution?.success),
              assignedTo: handoff.distribution?.selectedUserName ?? null,
              assignedUserId: handoff.distribution?.selectedUserId ?? null,
              departmentName: handoff.departmentName,
              reason: handoff.distribution?.reason ?? null,
              queuedWaiting,
              hint: queuedWaiting
                ? "Lead na fila (sem consultor elegível agora). Avise UMA vez com empatia: já registrou o pedido. Fora do expediente (antes das 8h/9h ou a partir das 18h30) diga que o atendimento humano retoma no horário (seg–sex 8h–19h, sáb 9h–16h). Dentro do expediente: NÃO diga 'ninguém disponível' nem 'em breve' — diga que a equipe continua quando puder. Ofereça continuar ajudando. NÃO repita."
                : undefined,
            });
          }
        }

        let departmentId: string | null = null;
        if (departmentName?.trim()) {
          const dept = await resolveDepartmentByName(departmentName);
          if (!dept)
            return fail(`Departamento "${departmentName}" não encontrado.`);
          departmentId = dept.id;
          if (ctx.conversationId) {
            await prisma.conversation.update({
              where: { id: ctx.conversationId },
              data: { departmentId: dept.id, updatedAt: new Date() },
            });
          }
        }

        const result = await executeDistribution({
          dealId: ctx.dealId ?? null,
          contactId: ctx.contactId ?? null,
          conversationId: ctx.conversationId ?? null,
          triggerSource: "AI_AGENT",
          departmentId,
          reassign: true,
        });

        if (ctx.dealId) {
          createDealEvent(ctx.dealId, ctx.agentUserId, "AI_AGENT_ACTION", {
            action: "executed_distribution",
            agentId: ctx.agentId ?? null,
            success: result.success,
            reason: result.reason,
            selectedUserId: result.selectedUserId,
            note: reason?.trim() ?? null,
          }).catch(() => {});
        }

        if (result.success) {
          return ok({
            assigned: true,
            assignedTo: result.selectedUserName,
            assignedUserId: result.selectedUserId,
          });
        }
        // Não é erro de execução — é resultado de negócio (sem elegível, etc.).
        return ok({
          assigned: false,
          reason: result.reason,
          hint:
            result.reason === "NO_ELIGIBLE_RESPONSIBLE"
              ? "Lead na fila (sem consultor elegível agora). Avise UMA vez com empatia: já registrou o pedido. Fora do expediente (antes das 8h/9h ou a partir das 18h30) diga que o atendimento humano retoma no horário (seg–sex 8h–19h, sáb 9h–16h). Dentro do expediente: NÃO diga 'ninguém disponível' nem 'em breve' — diga que a equipe continua quando puder. Ofereça continuar ajudando. NÃO repita."
              : result.reason === "NO_DEPARTMENT"
                ? "A conversa não está em um departamento com distribuição automática. Chame `transfer_to_department` primeiro."
                : "Distribuição não realizada. Considere transferir para humano manualmente.",
        });
      } catch (err) {
        return fail(
          err instanceof Error ? err.message : "Falha ao executar distribuição.",
        );
      }
    },
  });
}

// ── consultar_matricula ────────────────────────────────────────

/**
 * Mensagem padrão de transferência quando o aluno pede dado pessoal específico.
 * Mantida no código para consistência (o agente deve reproduzi-la ao transferir).
 */
const MATRICULA_TRANSFER_MESSAGE =
  "Para garantir a segurança dos seus dados, vou te transferir para um de nossos consultores, que poderá confirmar essas informações com você. Só um instante, por favor. 🙂";

const MATRICULA_POLITICA =
  "USO INTERNO — NÃO DIVULGUE. Use estes dados apenas como contexto para entender a situação do aluno e atender melhor. NUNCA repita ou confirme ao aluno dados pessoais/acadêmicos específicos (situação da matrícula, curso, polo, série, documentos, financeiro). Se o aluno pedir informação específica sobre a própria situação/dados, responda EXATAMENTE com a mensagem de transferência e acione transfer_to_human. NÃO acione distribuição automática sem o aluno pedir humano.";

function consultarMatriculaTool(ctx: RunContext) {
  return tool({
    description:
      "Consulta, para USO INTERNO do agente, o contexto acadêmico do aluno em conversa (curso, polo, série, situação da matrícula, ciclo) a partir do relatório de matriculados. Serve para você ENTENDER a situação do aluno e rotear/atender melhor — NÃO para repassar esses dados a ele. O casamento é automático por telefone/e-mail do contato. Regra de segurança: se o aluno pedir informação específica sobre os próprios dados/situação, NÃO responda com os dados — envie a mensagem de transferência e encaminhe para um consultor humano. Passe `cpf` apenas se o aluno informar o CPF no chat e o telefone/e-mail não localizar.",
    inputSchema: z.object({
      cpf: z
        .string()
        .optional()
        .describe(
          "CPF informado pelo aluno no chat (opcional). Só use se o telefone/e-mail não localizar a matrícula.",
        ),
    }),
    execute: async ({ cpf }) => {
      try {
        const orgId = getOrgIdOrNull();
        if (!orgId) return fail("Sem organização no contexto.");
        if (!ctx.contactId) return fail("Sem contato associado à conversa.");

        const contact = await prisma.contact.findUnique({
          where: { id: ctx.contactId },
          select: { phone: true, email: true, name: true },
        });
        if (!contact) return fail("Contato não encontrado.");

        // Casamento amplo (telefone + e-mail + CPF informado) para maximizar a
        // chance de ter contexto — sem risco de vazamento, pois o agente NÃO
        // divulga estes dados ao aluno (uso interno + transferência segura).
        const records = await lookupStudent(orgId, {
          phone: contact.phone,
          email: contact.email,
          cpf: cpf?.trim() || null,
        });

        if (records.length === 0) {
          return ok({
            found: false,
            politica: MATRICULA_POLITICA,
            transferMessage: MATRICULA_TRANSFER_MESSAGE,
            hint: "Sem contexto de matrícula para este contato. Atenda normalmente; se o aluno pedir dado específico da situação dele, envie a mensagem de transferência e encaminhe para um consultor humano.",
          });
        }

        const matriculas = records.map((r) => ({
          nome: r.nome,
          curso: r.curso,
          polo: r.polo,
          serie: r.serie,
          ciclo: r.ciclo,
          situacao: r.situacao,
          tipoMatricula: r.tipoMatricula,
          instituicao: r.instituicao,
          dataMatricula: r.dataMatricula
            ? r.dataMatricula.toISOString().slice(0, 10)
            : null,
        }));
        const ativo = records.some((r) =>
          ["EM CURSO", "ATIVO", "CURSANDO"].some((s) =>
            (r.situacao ?? "").toUpperCase().includes(s),
          ),
        );

        return ok({
          found: true,
          politica: MATRICULA_POLITICA,
          transferMessage: MATRICULA_TRANSFER_MESSAGE,
          nome: records[0]?.nome ?? contact.name,
          ativo,
          totalMatriculas: matriculas.length,
          matriculas,
        });
      } catch (err) {
        return fail(
          err instanceof Error ? err.message : "Falha ao consultar matrícula.",
        );
      }
    },
  });
}

// ── close_conversation ─────────────────────────────────────────

function closeConversationTool(ctx: RunContext) {
  return tool({
    description:
      "Encerra a conversa atual SOMENTE se o atendimento foi só da IA (nenhum humano respondeu ainda). Dispara a automação de Encerramento do CRM. Use quando o aluno pedir para encerrar/finalizar, agradecer de forma conclusiva ('muito grata', 'obrigada por toda ajuda') depois de já ter sido atendido, ou disser que volta depois/à noite e em seguida agradecer. NÃO use se já houver consultor humano na conversa. NÃO use só porque o aluno disse que vai estudar à noite — nesse caso confirme e continue; encerre no agradecimento seguinte.",
    inputSchema: z.object({
      reason: z
        .string()
        .optional()
        .describe("Motivo curto do encerramento (ex.: 'Aluno pediu para encerrar')."),
    }),
    execute: async ({ reason }) => {
      try {
        if (!ctx.conversationId) return fail("Sem conversa ativa.");
        const result = await closeAiOnlyConversation({
          conversationId: ctx.conversationId,
          contactId: ctx.contactId ?? null,
          reason: reason ?? "close_conversation via IA",
        });
        if (!result.closed) {
          return fail(
            result.reason === "HAS_HUMAN_REPLY"
              ? "Já houve resposta humana — não posso encerrar por aqui. Transfira ou deixe o consultor encerrar."
              : result.reason === "NOT_AI_ASSIGNEE"
                ? "A conversa não está com a IA — não encerro."
                : result.reason === "ALREADY_CLOSED"
                  ? "Conversa já encerrada."
                  : `Não foi possível encerrar (${result.reason}).`,
          );
        }
        return ok({
          closed: true,
          hint: "Conversa encerrada e automação Encerramento acionada. Confirme ao aluno em uma frase curta.",
        });
      } catch (err) {
        return fail(
          err instanceof Error ? err.message : "Falha ao encerrar conversa.",
        );
      }
    },
  });
}

// ── ToolSet builder ────────────────────────────────────────────

// Usamos `any` pro Tool porque cada tool tem um inputSchema e output
// diferentes; o ToolSet do AI SDK aceita tools heterogêneas, mas
// TypeScript não consegue inferir isso automaticamente sem este cast.
type AnyTool = ReturnType<typeof tool<any, any>>;

const FACTORY_MAP: Record<string, (ctx: RunContext) => AnyTool> = {
  create_deal: createDealTool,
  move_stage: moveStageTool,
  add_tag: addTagTool,
  create_activity: createActivityTool,
  search_products: searchProductsTool,
  send_whatsapp_template: sendWhatsappTemplateTool,
  transfer_to_department: transferToDepartmentTool,
  execute_distribution: executeDistributionTool,
  consultar_matricula: consultarMatriculaTool,
  transfer_to_human: transferToHumanTool,
  close_conversation: closeConversationTool,
};

export function buildToolSet(ctx: RunContext, enabledIds: string[]): ToolSet {
  const set: Record<string, AnyTool> = {};
  for (const id of enabledIds) {
    const factory = FACTORY_MAP[id];
    if (factory) set[id] = factory(ctx);
  }
  return set as ToolSet;
}

export const AVAILABLE_TOOL_IDS = Object.keys(FACTORY_MAP);
