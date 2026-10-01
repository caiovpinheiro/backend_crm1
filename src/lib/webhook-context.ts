// prismaBase (sem extension) porque esse helper roda ANTES de qualquer
// RequestContext existir — ele eh quem vai criar o contexto a partir
// do Channel resolvido.
import { prismaBase as prisma } from "@/lib/prisma-base";
import { runWithContext, type RequestContext } from "@/lib/request-context";
import { webhookContextKey, wrapChannelLookup } from "@/lib/cache/keys";

/**
 * Rotas de webhook (/api/webhooks/meta/*, /api/webhooks/baileys/*) nao
 * tem sessao NextAuth — a identidade do "quem esta chamando" vem do
 * canal (phone_number_id, sessionId, channelId). Esse helper centraliza
 * a resolucao do organizationId a partir do Channel correspondente e
 * embrulha o handler em AsyncLocalStorage, igual a withOrgContext.
 *
 * Super-admin nao se aplica a webhooks — sao sempre no contexto de uma org.
 */

type WebhookCtxInput =
  | { by: "channelId"; value: string }
  | { by: "phoneNumber"; value: string }
  /// phone_number_id do Meta fica em Channel.config JSON. Esse caso faz
  /// query com JSON containment. Se vierem muitos, vale subir o campo
  /// pra coluna dedicada e indexar.
  | { by: "metaPhoneNumberId"; value: string }
  | { by: "baileysSessionId"; value: string };

// PR 5.1 — TTL de 5 min para resolucao de orgId/channelId. Mudancas
// de canal (provider switch, phone change) sao raras e a invalidacao em
// services/channels.ts (`invalidateChannelLookups`, versao por org) eh
// chamada imediatamente no caminho de update. TTL longo eh seguro.
const RESOLVE_TTL_SEC = 300;

export async function resolveOrgIdFromChannel(
  input: WebhookCtxInput,
): Promise<{ organizationId: string; channelId: string } | null> {
  const cacheKey = webhookContextKey(input.by, input.value);
  return wrapChannelLookup(cacheKey, RESOLVE_TTL_SEC, async () => {
    if (input.by === "channelId") {
      const ch = await prisma.channel.findUnique({
        where: { id: input.value },
        select: { id: true, organizationId: true },
      });
      return ch ? { organizationId: ch.organizationId, channelId: ch.id } : null;
    }
    if (input.by === "phoneNumber") {
      const ch = await prisma.channel.findFirst({
        where: { phoneNumber: input.value },
        select: { id: true, organizationId: true },
        orderBy: { updatedAt: "desc" },
      });
      return ch ? { organizationId: ch.organizationId, channelId: ch.id } : null;
    }
    if (input.by === "metaPhoneNumberId") {
      // Meta grava phone_number_id dentro de `config.phone_number_id`.
      // Query com JSON containment. Se a busca for hot, considerar subir
      // para coluna dedicada (`phoneNumberId`) com index proprio.
      const ch = await prisma.channel.findFirst({
        where: {
          provider: "META_CLOUD_API",
          config: { path: ["phone_number_id"], equals: input.value },
        },
        select: { id: true, organizationId: true },
        orderBy: { updatedAt: "desc" },
      });
      return ch ? { organizationId: ch.organizationId, channelId: ch.id } : null;
    }
    if (input.by === "baileysSessionId") {
      const ch = await prisma.channel.findFirst({
        where: {
          provider: "BAILEYS_MD",
          config: { path: ["sessionId"], equals: input.value },
        },
        select: { id: true, organizationId: true },
        orderBy: { updatedAt: "desc" },
      });
      return ch ? { organizationId: ch.organizationId, channelId: ch.id } : null;
    }
    return null;
  });
}

/**
 * Executa `handler` dentro de um contexto de tenant resolvido pelo canal.
 * Retorna `null` se nao conseguiu achar o Channel — o handler decide se
 * retorna 404 ou 200 (algumas integracoes Meta esperam 200 sempre).
 */
export async function withWebhookContext<T>(
  input: WebhookCtxInput,
  handler: (ctx: {
    organizationId: string;
    channelId: string;
  }) => Promise<T> | T,
): Promise<T | null> {
  const resolved = await resolveOrgIdFromChannel(input);
  if (!resolved) return null;
  const ctx: RequestContext = {
    organizationId: resolved.organizationId,
    userId: "webhook",
    isSuperAdmin: false,
    // Webhook entra como SYSTEM. Quando o handler descobre o ator real
    // (ex.: agente IA tomou a acao, automacao foi disparada), pode
    // sobrescrever com `runWithActor`.
    actor: { type: "SYSTEM", label: "Webhook" },
  };
  return runWithContext(ctx, () => handler(resolved)) as Promise<T>;
}

/**
 * Versao pra quando o orgId vem de outro lugar (cron, job queue, seed) e
 * queremos apenas o wrapping do AsyncLocalStorage.
 */
export function withSystemContext<T>(
  organizationId: string,
  handler: () => Promise<T> | T,
  opts?: {
    userId?: string;
    isSuperAdmin?: boolean;
    /// Sobrescreve o ator default ({ type: SYSTEM, label: "Sistema" }).
    /// Use em workers/cron quando souber que a acao representa um
    /// agente IA / automacao / integracao.
    actor?: import("@/lib/request-context").ContextActor;
  },
): Promise<T> {
  const ctx: RequestContext = {
    organizationId,
    userId: opts?.userId ?? "system",
    isSuperAdmin: Boolean(opts?.isSuperAdmin),
    actor: opts?.actor ?? { type: "SYSTEM", label: "Sistema" },
  };
  return Promise.resolve(runWithContext(ctx, handler));
}
