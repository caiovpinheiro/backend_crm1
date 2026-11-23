/**
 * Servidor MCP (Streamable HTTP, stateless). Um `McpServer` por requisição
 * com o principal já autenticado: sem sessão em memória, escala
 * horizontalmente e a revogação vale na próxima requisição.
 *
 * Toda ferramenta passa por `guard()`:
 *   escopo concedido → permissão RBAC atual → rate limit (conexão e org)
 *   → execução em `runWithContext` da org (isSuperAdmin=false) → auditoria.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { can, loadAuthzContext } from "@/lib/authz";
import { getLogger } from "@/lib/logger";
import { recordToolCall } from "@/lib/mcp/audit";
import { MCP_TOOL_REQUIREMENTS, type McpToolName } from "@/lib/mcp/scopes";
import {
  countOf,
  getCampaignResults,
  getConversationMessages,
  getLead,
  getPipelineMetrics,
  getSalesMetrics,
  getTeamPerformance,
  isMcpOwnScopeOnly,
  listConversations,
  listLeads,
  listVisiblePipelines,
  ToolError,
  type ToolEnv,
  type ToolUser,
} from "@/lib/mcp/tools";
import { consumeRateLimit } from "@/lib/rate-limit";
import { runWithContext } from "@/lib/request-context";
import type { McpPrincipal } from "@/services/mcp/oauth";

const log = getLogger("mcp.server");

export const MCP_SERVER_INFO = { name: "bwipo-crm", version: "1.0.0" };

function asRole(role: string): ToolUser["role"] {
  return role === "ADMIN" || role === "MANAGER" ? role : "MEMBER";
}

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export type GuardDeps = {
  principal: McpPrincipal;
};

/**
 * Executa uma ferramenta com todas as travas. Exportado para os testes
 * exercitarem escopo/RBAC/isolamento sem passar pelo transporte HTTP.
 */
export async function runGuardedTool(
  principal: McpPrincipal,
  tool: McpToolName,
  args: Record<string, unknown>,
  exec: (env: ToolEnv) => Promise<unknown>,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const req = MCP_TOOL_REQUIREMENTS[tool];
  const audit = (status: Parameters<typeof recordToolCall>[0]["status"], extra: { resultCount?: number | null; errorCode?: string | null } = {}) =>
    recordToolCall({
      organizationId: principal.organizationId,
      connectionId: principal.connectionId,
      userId: principal.user.id,
      tool,
      status,
      args,
      durationMs: Date.now() - t0,
      ...extra,
    });

  if (!principal.scopes.includes(req.scope)) {
    await audit("denied", { errorCode: "missing_scope" });
    return errorResult(
      `Esta conexão não tem a permissão "${req.scope}". Peça ao usuário para reconectar e autorizar esse acesso no CRM.`,
    );
  }

  const user: ToolUser = {
    id: principal.user.id,
    name: principal.user.name,
    email: principal.user.email,
    role: asRole(principal.user.role),
    organizationId: principal.organizationId,
    isSuperAdmin: false,
  };

  const [connRl, orgRl] = await Promise.all([
    consumeRateLimit(`mcp:conn:${principal.connectionId}`, "mcp.tool"),
    consumeRateLimit(`mcp:org:${principal.organizationId}`, "mcp.org"),
  ]);
  if (!connRl.allowed || !orgRl.allowed) {
    await audit("rate_limited", { errorCode: "rate_limited" });
    const wait = Math.max(connRl.retryAfterSec, orgRl.retryAfterSec, 1);
    return errorResult(`Limite de consultas atingido. Tente novamente em ${wait}s.`);
  }

  return runWithContext(
    {
      organizationId: principal.organizationId,
      userId: user.id,
      isSuperAdmin: false,
      actor: { type: "INTEGRATION", label: `MCP (${principal.clientName})`, ref: principal.connectionId },
    },
    async () => {
      const authz = await loadAuthzContext({
        userId: user.id,
        organizationId: user.organizationId,
        isSuperAdmin: false,
      });
      const missing = req.permissions.filter((p) => !can(authz, p));
      if (missing.length > 0) {
        await audit("denied", { errorCode: `missing_permission:${missing.join(",")}` });
        return errorResult(
          "Seu usuário no CRM não tem permissão para esta consulta. Fale com o administrador da sua conta.",
        );
      }
      try {
        // Papel lido a cada chamada: promover/rebaixar vale na hora.
        const ownOnly = isMcpOwnScopeOnly({ role: user.role, isAdmin: authz.isAdmin });
        const result = await exec({ user, exposeContactPii: principal.exposeContactPii, ownOnly });
        await audit("ok", { resultCount: countOf(result) });
        return textResult(result);
      } catch (err) {
        if (err instanceof ToolError) {
          await audit(err.code === "forbidden" ? "denied" : "invalid", { errorCode: err.code });
          return errorResult(err.message);
        }
        log.error(
          { err: (err as Error)?.message, tool, organizationId: principal.organizationId },
          "[mcp] ferramenta falhou",
        );
        await audit("error", { errorCode: "internal_error" });
        return errorResult("Erro interno ao consultar o CRM. Tente novamente.");
      }
    },
  );
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const id = z.string().min(1).max(64);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const periodShape = {
  period: z
    .enum(["today", "yesterday", "last_7", "last_30", "this_month", "last_month", "custom"])
    .optional()
    .describe("Período (padrão last_30). custom exige startDate e endDate."),
  startDate: day.optional().describe("Início (YYYY-MM-DD) quando period=custom."),
  endDate: day.optional().describe("Fim (YYYY-MM-DD) quando period=custom."),
};

export function buildMcpServer(principal: McpPrincipal): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      "CRM Bwipo (somente leitura). 'Lead' é um negócio (deal) no funil. Os dados retornados já respeitam as permissões do usuário conectado; para operadores (scope = own), só os negócios em que ele é o responsável e as conversas dele. Use list_leads/list_conversations com paginação; IDs aceitam o número público (#123) ou o ID interno.",
  });

  const reg = <S extends z.ZodRawShape>(
    name: McpToolName,
    title: string,
    description: string,
    shape: S,
    exec: (env: ToolEnv, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) => {
    server.registerTool(
      name,
      { title, description, inputSchema: shape, annotations: { ...READ_ONLY, title } },
      (async (args: Record<string, unknown>) =>
        runGuardedTool(principal, name, args, (env) =>
          exec(env, args as z.infer<z.ZodObject<S>>),
        )) as never,
    );
  };

  reg(
    "list_leads",
    "Listar leads",
    "Lista leads (negócios) do CRM com filtros por funil, etapa, status, responsável, busca e data de criação. Paginado (perPage máx. 50). Também devolve os funis visíveis quando pipelineId não é informado.",
    {
      pipelineId: id.optional().describe("ID do funil."),
      stageId: id.optional().describe("ID da etapa."),
      status: z.enum(["OPEN", "WON", "LOST"]).optional(),
      ownerId: id.optional().describe("ID do responsável, ou 'me'."),
      search: z.string().max(100).optional().describe("Busca por título, nome, e-mail ou telefone do contato."),
      createdFrom: day.optional(),
      createdTo: day.optional(),
      page: z.number().int().min(1).max(500).optional(),
      perPage: z.number().int().min(1).max(50).optional(),
    },
    async (env, args) => {
      const result = await listLeads(env, args);
      return args.pipelineId ? result : { ...result, pipelines: await listVisiblePipelines(env) };
    },
  );

  reg(
    "get_lead",
    "Detalhes do lead",
    "Detalhes de um lead (negócio): etapa, valor, responsável, contato, conversas, notas e histórico de eventos.",
    { id: id.describe("ID interno ou número público do lead.") },
    (env, args) => getLead(env, args),
  );

  reg(
    "list_conversations",
    "Listar conversas",
    "Lista conversas da inbox que o usuário pode ver (sem conteúdo das mensagens). Paginação por cursor (nextCursor).",
    {
      status: z.enum(["OPEN", "RESOLVED", "PENDING", "SNOOZED"]).optional(),
      channel: z.string().max(40).optional().describe("Tipo de canal, ex.: whatsapp, instagram, email."),
      ownerId: id.optional().describe("ID do atendente, ou 'me'."),
      contactId: id.optional(),
      search: z.string().max(100).optional(),
      cursor: z.string().max(500).optional(),
      perPage: z.number().int().min(1).max(50).optional(),
    },
    (env, args) => listConversations(env, args),
  );

  reg(
    "get_conversation_messages",
    "Mensagens da conversa",
    "Mensagens de uma conversa que o usuário pode acessar (sem notas internas), da mais antiga para a mais recente. Use nextBefore para páginas anteriores.",
    {
      conversationId: id.describe("ID interno ou número público da conversa."),
      before: z.string().max(40).optional().describe("ISO-8601: mensagens anteriores a este instante."),
      limit: z.number().int().min(1).max(50).optional(),
    },
    (env, args) => getConversationMessages(env, args),
  );

  reg(
    "get_sales_metrics",
    "Resultados de vendas",
    "Resultados comerciais no período: ganhos, perdidos, receita, ticket médio, taxa de conversão, origens e motivos de perda.",
    { ...periodShape, pipelineId: id.optional().describe("Funil; vazio = todos os visíveis.") },
    (env, args) => getSalesMetrics(env, args),
  );

  reg(
    "get_team_performance",
    "Desempenho da equipe",
    "Resultados por vendedor no período (leads, ganhos, perdidos, conversão, receita). Restrito a gestores e administradores.",
    { ...periodShape, pipelineId: id.optional() },
    (env, args) => getTeamPerformance(env, args),
  );

  reg(
    "get_campaign_results",
    "Resultados de campanhas",
    "Sem campaignId: lista campanhas com indicadores. Com campaignId: estatísticas detalhadas (entregas, leituras, respostas, falhas).",
    {
      campaignId: id.optional(),
      status: z.string().max(20).optional(),
      search: z.string().max(100).optional(),
      page: z.number().int().min(1).max(500).optional(),
      perPage: z.number().int().min(1).max(50).optional(),
    },
    (env, args) => getCampaignResults(env, args),
  );

  reg(
    "get_pipeline_metrics",
    "Métricas do funil",
    "Métricas por etapa de um funil: estoque aberto, valor, entradas, saídas, ganhos, perdidos, conversão e negócios parados.",
    { ...periodShape, pipelineId: id.describe("ID ou número do funil (use list_leads para ver os funis).") },
    (env, args) => getPipelineMetrics(env, args),
  );

  return server;
}

/** Atende uma requisição `/mcp` já autenticada. */
export async function handleMcpHttp(request: Request, principal: McpPrincipal): Promise<Response> {
  const server = buildMcpServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close().catch(() => {});
  }
}
