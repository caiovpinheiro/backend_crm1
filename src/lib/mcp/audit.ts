/**
 * Histórico de consultas MCP (`mcp_audit_logs`). Guarda só metadados:
 * ferramenta, filtros saneados (texto livre vira tamanho), contagem e
 * duração. Nunca tokens, conteúdo de mensagens ou dados retornados.
 */
import { prismaBase } from "@/lib/prisma-base";
import { getLogger } from "@/lib/logger";

const log = getLogger("mcp.audit");

/** Chaves cujo valor é texto livre do usuário/modelo (pode conter PII). */
const FREE_TEXT_KEYS = new Set(["search", "q", "query"]);

export function sanitizeArgs(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>).slice(0, 20)) {
    if (v === undefined || v === null) continue;
    if (FREE_TEXT_KEYS.has(k)) {
      out[k] = `[texto: ${String(v).length} caracteres]`;
    } else if (typeof v === "string") {
      out[k] = v.length > 80 ? `${v.slice(0, 80)}…` : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

export type ToolAuditInput = {
  organizationId: string;
  connectionId: string;
  userId: string;
  tool: string;
  status: "ok" | "denied" | "error" | "rate_limited" | "invalid";
  args?: unknown;
  resultCount?: number | null;
  durationMs?: number;
  errorCode?: string | null;
};

export async function recordToolCall(input: ToolAuditInput): Promise<void> {
  try {
    await prismaBase.mcpAuditLog.create({
      data: {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        userId: input.userId,
        tool: input.tool,
        status: input.status,
        args: (sanitizeArgs(input.args) ?? undefined) as never,
        resultCount: input.resultCount ?? null,
        durationMs: input.durationMs ?? null,
        errorCode: input.errorCode ?? null,
      },
    });
    if (input.status === "error") {
      await prismaBase.mcpConnection.update({
        where: { id: input.connectionId },
        data: { lastError: input.errorCode ?? "error", lastErrorAt: new Date() },
      });
    }
  } catch (err) {
    log.warn({ err: (err as Error).message, tool: input.tool }, "[mcp.audit] falhou ao gravar");
  }
}
