/**
 * Tabulação do agente v2 ("Começo e fim › Tabulação"): ao encerrar e/ou ao
 * transferir, aplica a folha do assunto, senão a padrão, senão (ao
 * encerrar) a de encerramento automático do departamento da conversa.
 * Antes a config existia mas nada a lia: o que o agente encerrava ficava
 * sem tabulação. Nunca sobrescreve folha já aplicada (regra do CRM).
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import type { V2AgentConfig, V2Theme } from "@/lib/ai-v2/types";
import { traceStep } from "./trace";

export type V2TabulationMoment = "close" | "transfer";

/** Folha configurada para o momento (sem a do departamento), ou null. */
export function pickV2TabulationId(config: V2AgentConfig, theme: V2Theme | null | undefined, moment: V2TabulationMoment): string | null {
  const t = config.tabulation;
  if (!t?.enabled) return null;
  const when = t.when ?? "on_close";
  if (moment === "close" && when === "on_transfer") return null;
  if (moment === "transfer" && when === "on_close") return null;
  return theme?.tabulationId || (theme ? t.byTheme?.[theme.id] : undefined) || t.fallbackId || null;
}

async function departmentAutoCloseTabulation(organizationId: string, conversationId: string): Promise<string | null> {
  const conv = await (prisma as unknown as {
    conversation: { findUnique: (args: unknown) => Promise<{ departmentId: string | null } | null> };
  }).conversation.findUnique({ where: { id: conversationId }, select: { departmentId: true } });
  if (!conv?.departmentId) return null;
  const { resolveAutoCloseTabulation } = await import("@/services/tabulations");
  const auto = await resolveAutoCloseTabulation({ organizationId, departmentId: conv.departmentId }).catch(() => null);
  return auto?.tabulationId ?? null;
}

/** Aplica a tabulação do momento, se configurada. Falha não interrompe o turno. */
export async function applyV2Tabulation(args: {
  config: V2AgentConfig;
  theme: V2Theme | null | undefined;
  moment: V2TabulationMoment;
  organizationId: string;
  conversationId: string;
  contactId?: string | null;
}): Promise<void> {
  if (!args.config.tabulation?.enabled) return;
  try {
    const tabulationId =
      pickV2TabulationId(args.config, args.theme, args.moment) ??
      (args.moment === "close" && (args.config.tabulation.when ?? "on_close") !== "on_transfer"
        ? await departmentAutoCloseTabulation(args.organizationId, args.conversationId)
        : null);
    if (!tabulationId) {
      traceStep("tabulação", "Tabulação ligada, mas sem folha para este assunto nem padrão");
      return;
    }
    const { applyConversationTabulation } = await import("@/services/ai/tabulation-classify");
    const res = await applyConversationTabulation({
      conversationId: args.conversationId,
      organizationId: args.organizationId,
      tabulationId,
      contactId: args.contactId ?? null,
      source: "AI_AGENT",
      closeIfOpen: false,
    });
    traceStep("tabulação", res.ok ? `Tabulada: "${res.tabulation.name}"` : `Não tabulada: ${res.error}`);
  } catch (err) {
    traceStep("tabulação", `Falhou: ${err instanceof Error ? err.message : String(err)}`);
  }
}
