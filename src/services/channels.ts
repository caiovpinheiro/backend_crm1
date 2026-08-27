import {
  Prisma,
  type Channel,
  type ChannelProvider,
  type ChannelStatus,
  type ChannelType,
} from "@prisma/client";

import {
  decryptChannelConfig,
  encryptChannelConfig,
} from "@/lib/channels/config";
import { applySessionResetOnIdentityChange } from "@/lib/channel-session";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { logAudit } from "@/lib/audit/log";
import { pickFields } from "@/lib/audit/redact";
import { cache } from "@/lib/cache";
import { channelKey } from "@/lib/cache/keys";

const CHANNEL_AUDIT_FIELDS = [
  "id",
  "name",
  "type",
  "provider",
  "phoneNumber",
  "status",
] as const;

export type CreateChannelData = {
  name: string;
  type: ChannelType;
  provider: ChannelProvider;
  config?: Prisma.InputJsonValue;
  phoneNumber?: string | null;
};

export type UpdateChannelData = {
  name?: string;
  type?: ChannelType;
  provider?: ChannelProvider;
  config?: Prisma.InputJsonValue;
  phoneNumber?: string | null;
  status?: ChannelStatus;
  qrCode?: string | null;
  sessionData?: Prisma.InputJsonValue | null;
  lastConnectedAt?: Date | null;
  /**
   * Funil de destino do inbound deste canal. `string` = roteia novos leads
   * para esse funil; `null` = volta ao funil padrão da org. Validado contra
   * a org corrente em `updateChannel`.
   */
  defaultPipelineId?: string | null;
  /**
   * Força `config.sessionResetAt = agora` (janela 24h fecha no inbox).
   * Uso: número já migrado de BM e o phoneNumberId no banco já é o novo.
   */
  resetSessionWindow?: boolean;
};

export type UpdateChannelStatusExtra = {
  qrCode?: string | null;
  lastConnectedAt?: Date | null;
  sessionData?: Prisma.InputJsonValue | null;
};

/**
 * Channel + slug da org dona — usado pela UI pra montar a URL do webhook
 * Meta scoped por organizacao (/api/webhooks/meta/{slug}). Sem o slug,
 * o painel de configuracao Meta nao conseguiria mostrar a URL correta
 * pro admin copiar/colar no painel da Meta.
 */
export type ChannelWithOrgSlug = Channel & { organizationSlug: string };

function attachOrgSlug<T extends Channel & { organization: { slug: string } | null }>(
  channel: T,
): ChannelWithOrgSlug {
  const { organization, ...rest } = channel;
  return { ...rest, organizationSlug: organization?.slug ?? "" };
}

export async function getChannels(): Promise<ChannelWithOrgSlug[]> {
  const channels = await prisma.channel.findMany({
    orderBy: { createdAt: "desc" },
    include: { organization: { select: { slug: true } } },
  });
  return channels.map(attachOrgSlug);
}

/** Prefixo de id sintético: conversas cujo Channel foi hard-deleted (channelId SetNull). */
export const INBOX_FILTER_MISSING_PREFIX = "__missing__:";
/** Conversas sem channelId e sem inboxName (canal excluído sem nome gravado). */
export const INBOX_FILTER_DELETED_ID = "__deleted__";

export type InboxFilterChannel = {
  id: string;
  name: string;
  type: string;
  status: string;
  phoneNumber: string | null;
  deleted: boolean;
};

export function inboxFilterMissingId(inboxName: string): string {
  return `${INBOX_FILTER_MISSING_PREFIX}${encodeURIComponent(inboxName)}`;
}

export function parseInboxFilterChannelIds(ids: string[]): {
  channelIds: string[];
  missingInboxNames: string[];
  includeUnnamedDeleted: boolean;
} {
  const channelIds: string[] = [];
  const missingInboxNames: string[] = [];
  let includeUnnamedDeleted = false;
  for (const raw of ids) {
    const id = raw.trim();
    if (!id) continue;
    if (id === INBOX_FILTER_DELETED_ID) {
      includeUnnamedDeleted = true;
      continue;
    }
    if (id.startsWith(INBOX_FILTER_MISSING_PREFIX)) {
      try {
        missingInboxNames.push(
          decodeURIComponent(id.slice(INBOX_FILTER_MISSING_PREFIX.length)),
        );
      } catch {
        missingInboxNames.push(id.slice(INBOX_FILTER_MISSING_PREFIX.length));
      }
      continue;
    }
    channelIds.push(id);
  }
  return { channelIds, missingInboxNames, includeUnnamedDeleted };
}

/**
 * Instâncias de canal da org para o filtro do inbox: todos os status
 * (conectado, desconectado, falha…) + canais que ainda aparecem em
 * conversas mesmo após exclusão (órfãos / inboxName residual).
 *
 * Não altera `getChannels()` — settings/composer continuam na lista
 * de rows existentes, sem sintéticos.
 */
export async function getChannelsForInboxFilter(): Promise<InboxFilterChannel[]> {
  const channels = await prisma.channel.findMany({
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      phoneNumber: true,
    },
    orderBy: { name: "asc" },
  });
  const knownIds = new Set(channels.map((c) => c.id));

  const result: InboxFilterChannel[] = channels.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    status: c.status,
    phoneNumber: c.phoneNumber,
    deleted: false,
  }));

  const leftover = await prisma.conversation.findMany({
    where: { channelId: { not: null } },
    select: { channelId: true, inboxName: true },
    distinct: ["channelId", "inboxName"],
  });
  for (const row of leftover) {
    if (!row.channelId || knownIds.has(row.channelId)) continue;
    const stored = row.inboxName?.trim();
    result.push({
      id: row.channelId,
      name: stored || "Canal excluído",
      type: "",
      status: "DELETED",
      phoneNumber: null,
      deleted: true,
    });
    knownIds.add(row.channelId);
  }

  const detached = await prisma.conversation.findMany({
    where: { channelId: null },
    select: { inboxName: true },
    distinct: ["inboxName"],
  });
  const seenNames = new Set<string>();
  let hasUnnamed = false;
  for (const row of detached) {
    const stored = row.inboxName?.trim() ?? "";
    if (!stored) {
      hasUnnamed = true;
      continue;
    }
    if (seenNames.has(stored)) continue;
    seenNames.add(stored);
    result.push({
      id: inboxFilterMissingId(stored),
      name: stored,
      type: "",
      status: "DELETED",
      phoneNumber: null,
      deleted: true,
    });
  }
  if (hasUnnamed) {
    result.push({
      id: INBOX_FILTER_DELETED_ID,
      name: "Canal excluído",
      type: "",
      status: "DELETED",
      phoneNumber: null,
      deleted: true,
    });
  }

  result.sort((a, b) => {
    if (a.deleted !== b.deleted) return a.deleted ? 1 : -1;
    return a.name.localeCompare(b.name, "pt-BR");
  });
  return result;
}

export async function getChannelById(
  id: string,
): Promise<ChannelWithOrgSlug | null> {
  const channel = await prisma.channel.findUnique({
    where: { id },
    include: { organization: { select: { slug: true } } },
  });
  return channel ? attachOrgSlug(channel) : null;
}

export async function createChannel(data: CreateChannelData): Promise<Channel> {
  // PR-1.2: encripta campos sensiveis (accessToken, appSecret, verifyToken)
  // antes de gravar. encryptChannelConfig e idempotente — se ja vier encriptado
  // (caso raro de re-uso de config), mantem como esta.
  const plainConfig = (data.config ?? {}) as Record<string, unknown>;
  const encryptedConfig = encryptChannelConfig(data.provider, plainConfig);

  const created = await prisma.channel.create({
    data: withOrgFromCtx({
      name: data.name.trim(),
      type: data.type,
      provider: data.provider,
      config: encryptedConfig as Prisma.InputJsonValue,
      phoneNumber: data.phoneNumber?.trim() || null,
    }),
  });
  // Limpa caches de lookup do webhook Meta (phoneNumberId→org, appSecrets):
  // cobre o caso de um POST ter cacheado "não mapeado" pouco antes do
  // onboarding do canal novo.
  await cache.delPattern("meta_wh:*");
  await logAudit({
    entity: "channel",
    action: "create",
    entityId: created.id,
    after: pickFields(created, CHANNEL_AUDIT_FIELDS),
  });
  return created;
}

export async function updateChannel(id: string, data: UpdateChannelData): Promise<Channel> {
  // Unchecked input: combina com a extensao `organization-scope` que injeta
  // `organizationId` escalar no data. Misturar com `relation: { connect }`
  // (checked input) faz o Prisma falhar com "Did you mean 'organization'?".
  const before = await prisma.channel.findUnique({ where: { id } });
  const patch: Prisma.ChannelUncheckedUpdateInput = {};
  if (data.name !== undefined) patch.name = data.name.trim();
  if (data.type !== undefined) patch.type = data.type;
  if (data.provider !== undefined) patch.provider = data.provider;
  if (data.config !== undefined || data.resetSessionWindow) {
    // PR-1.2: encriptacao precisa do provider. Se nao vier no patch, usa o
    // registro existente. Troca de phoneNumberId/WABA carimba sessionResetAt
    // (janela 24h fecha no inbox). Reconnect só de token preserva o corte.
    const provider: ChannelProvider | undefined =
      data.provider ?? before?.provider;
    const previousPlain = before
      ? decryptChannelConfig(
          before.provider,
          (before.config ?? {}) as Record<string, unknown>,
        )
      : {};
    const incomingPlain =
      data.config !== undefined
        ? { ...(data.config as Record<string, unknown>) }
        : { ...previousPlain };
    const stamped = applySessionResetOnIdentityChange(previousPlain, incomingPlain);
    if (data.resetSessionWindow) {
      stamped.sessionResetAt = new Date().toISOString();
    }
    if (provider) {
      patch.config = encryptChannelConfig(
        provider,
        stamped,
      ) as Prisma.InputJsonValue;
    } else {
      patch.config = stamped as Prisma.InputJsonValue;
    }
  }
  if (data.phoneNumber !== undefined) patch.phoneNumber = data.phoneNumber?.trim() || null;
  if (data.defaultPipelineId !== undefined) {
    if (data.defaultPipelineId) {
      // Valida que o funil pertence à org corrente (prisma é org-scoped):
      // evita vincular o canal a um pipeline de outra organização. A
      // extension scope-by-org já injeta organizationId no where do find.
      const pipeline = await prisma.pipeline.findFirst({
        where: { id: data.defaultPipelineId, archivedAt: null },
        select: { id: true },
      });
      if (!pipeline) throw new Error("Funil de destino inválido.");
    }
    // Escalar (unchecked) ao inves de `defaultPipeline: { connect/disconnect }`
    // pra manter coerencia com a extension de org-scope (ver coment. acima).
    patch.defaultPipelineId = data.defaultPipelineId ?? null;
  }
  if (data.status !== undefined) patch.status = data.status;
  if (data.qrCode !== undefined) patch.qrCode = data.qrCode;
  if (data.sessionData !== undefined) {
    patch.sessionData =
      data.sessionData === null ? Prisma.DbNull : data.sessionData;
  }
  if (data.lastConnectedAt !== undefined) patch.lastConnectedAt = data.lastConnectedAt;

  const updated = await prisma.channel.update({
    where: { id },
    data: patch,
  });
  // Invalida lookups cacheados de webhook-context (PR 5.1). Cobre
  // todos os tipos de query (channelId, phoneNumber, metaPhoneNumberId,
  // baileysSessionId) — pattern delete e barato porque keys sao
  // poucas por canal.
  await cache.del(channelKey(id));
  await cache.delPattern("wh_ctx:*");
  // Caches do webhook Meta (phoneNumberId→org e appSecrets por org) —
  // edição de config pode trocar phoneNumberId/appSecret.
  await cache.delPattern("meta_wh:*");
  // Sinaliza eventos de connect/disconnect alem de update generico —
  // util pra investigar interrupcoes de canal sem ler diff.
  let action: "update" | "channel_connect" | "channel_disconnect" = "update";
  if (before && before.status !== updated.status) {
    if (updated.status === "CONNECTED") action = "channel_connect";
    else if (
      before.status === "CONNECTED" &&
      (updated.status === "DISCONNECTED" || updated.status === "FAILED")
    ) {
      action = "channel_disconnect";
    }
  }
  await logAudit({
    entity: "channel",
    action,
    entityId: id,
    before: pickFields(before, CHANNEL_AUDIT_FIELDS),
    after: pickFields(updated, CHANNEL_AUDIT_FIELDS),
  });
  return updated;
}

export async function deleteChannel(id: string): Promise<Channel> {
  const existing = await prisma.channel.findUnique({ where: { id } });
  if (!existing) {
    throw new Error("Canal não encontrado.");
  }
  const deleted = await prisma.channel.delete({ where: { id } });
  await cache.del(channelKey(id));
  await cache.delPattern("wh_ctx:*");
  await cache.delPattern("meta_wh:*");
  await logAudit({
    entity: "channel",
    action: "delete",
    entityId: id,
    before: pickFields(deleted, CHANNEL_AUDIT_FIELDS),
  });
  return deleted;
}

export async function updateChannelStatus(
  id: string,
  status: ChannelStatus,
  extra?: UpdateChannelStatusExtra
): Promise<Channel> {
  const data: Prisma.ChannelUpdateInput = { status };
  if (extra?.qrCode !== undefined) data.qrCode = extra.qrCode;
  if (extra?.lastConnectedAt !== undefined) data.lastConnectedAt = extra.lastConnectedAt;
  if (extra?.sessionData !== undefined) {
    data.sessionData =
      extra.sessionData === null ? Prisma.DbNull : extra.sessionData;
  }
  const updated = await prisma.channel.update({
    where: { id },
    data,
  });
  await cache.del(channelKey(id));
  return updated;
}

export function parseChannelConfig(config: unknown): Record<string, unknown> {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return { ...(config as Record<string, unknown>) };
  }
  return {};
}

/**
 * Versao de `parseChannelConfig` que decripta os campos sensiveis usando
 * o provider do canal. Use SEMPRE que precisar usar accessToken/appSecret/
 * verifyToken (ex.: chamar Meta API, validar webhook signature).
 *
 * @see docs/secrets-encryption.md
 */
export function parseChannelConfigDecrypted(channel: {
  provider: ChannelProvider;
  config: unknown;
}): Record<string, unknown> {
  const parsed = parseChannelConfig(channel.config);
  return decryptChannelConfig(channel.provider, parsed);
}

export function appPublicBaseUrl(): string {
  const fromNext = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "";
  if (fromNext) return fromNext;
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "")}`;
  return "http://localhost:3000";
}

/** Limpa QR e sessão e define desconectado (uso após logout em APIs externas). */
export async function markChannelDisconnected(id: string): Promise<Channel> {
  const updated = await prisma.channel.update({
    where: { id },
    data: {
      status: "DISCONNECTED",
      qrCode: null,
      sessionData: Prisma.DbNull,
    },
  });
  await cache.del(channelKey(id));
  return updated;
}
