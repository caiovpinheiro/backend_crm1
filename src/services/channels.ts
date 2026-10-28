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
import { channelKey, invalidateChannelLookups } from "@/lib/cache/keys";
import { bumpResponseFamilies, RESPONSE_FAMILIES } from "@/lib/cache/response-cache";
import {
  defaultWebchatConfig,
  generateWebchatPublicKey,
  normalizeWebchatConfig,
  readWebchatConfig,
  webchatOrgDefaults,
} from "@/lib/webchat/config";
import {
  pickWebchatSecretFields,
  stripWebchatSecrets,
  webchatSecretsStatus,
  withRotatedWebchatSecret,
  type WebchatSecretKind,
  type WebchatSecretsStatus,
} from "@/lib/webchat/secrets";
import {
  defaultWebchatV2Config,
  normalizeWebchatV2Config,
  readWebchatV2Config,
} from "@/lib/webchat/v2-config";

/** Lista de canais em cache (`GET /api/channels`, bootstrap): sobe a versão. */
export async function invalidateChannelsList(orgId: string | null | undefined): Promise<void> {
  await bumpResponseFamilies(orgId, RESPONSE_FAMILIES.channels);
}

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
export type ChannelWithOrgSlug = Channel & {
  organizationSlug: string;
  /**
   * Só em canais WEBCHAT: a marca da org que o tema do widget herda quando
   * `config.theme.primary`/`avatarUrl` estão ausentes (painel mostra o
   * "herdado"). docs/decisoes/webchat-widget.md §3.4.1.
   */
  webchatDefaults?: { primary: string; avatarUrl: string | null };
  /**
   * Só em canais WEBCHAT: segredos v2 configurados (sim/não + data). O valor
   * nunca sai daqui — `config` vem sem os campos de segredo. §9.5.
   */
  webchatSecrets?: WebchatSecretsStatus;
};

/**
 * Canal WEBCHAT como o painel pode ver: `config` sem os segredos
 * (`identitySecret`/`s2sSecret`) e `webchatSecrets` com o status. Outros
 * tipos passam intactos. Use em TODA resposta que devolve a linha do canal.
 */
export function redactWebchatChannel<T extends { provider: ChannelProvider; config: unknown }>(
  channel: T,
): T & { webchatSecrets?: WebchatSecretsStatus } {
  if (channel.provider !== "WEBCHAT") return channel;
  return {
    ...channel,
    config: stripWebchatSecrets(channel.config) as T["config"],
    webchatSecrets: webchatSecretsStatus(channel.config),
  };
}

type OrgBrandingRef = {
  slug: string;
  primaryColor?: string | null;
  logoUrl?: string | null;
} | null;

const ORG_REF_SELECT = { slug: true, primaryColor: true, logoUrl: true } as const;

function attachOrgSlug<T extends Channel & { organization: OrgBrandingRef }>(
  channel: T,
): ChannelWithOrgSlug {
  const { organization, ...rest } = channel;
  return {
    ...redactWebchatChannel(rest),
    organizationSlug: organization?.slug ?? "",
    ...(rest.provider === "WEBCHAT" ? { webchatDefaults: webchatOrgDefaults(organization) } : {}),
  };
}

/** Resposta de POST/PUT: canal WEBCHAT ganha `webchatDefaults` (marca da org). */
export async function withWebchatDefaults<T extends Channel>(
  channel: T,
): Promise<
  T & {
    webchatDefaults?: { primary: string; avatarUrl: string | null };
    webchatSecrets?: WebchatSecretsStatus;
  }
> {
  if (channel.provider !== "WEBCHAT") return channel;
  const org = await prisma.organization.findUnique({
    where: { id: channel.organizationId },
    select: { primaryColor: true, logoUrl: true },
  });
  return { ...redactWebchatChannel(channel), webchatDefaults: webchatOrgDefaults(org) };
}

export async function getChannels(): Promise<ChannelWithOrgSlug[]> {
  const channels = await prisma.channel.findMany({
    orderBy: { createdAt: "desc" },
    include: { organization: { select: ORG_REF_SELECT } },
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
    include: { organization: { select: ORG_REF_SELECT } },
  });
  return channel ? attachOrgSlug(channel) : null;
}

/**
 * Canal Cloud API desta org com o mesmo `phoneNumberId`.
 * O prisma já restringe `organizationId`. Não cria linha nova.
 */
export async function findMetaCloudChannelByPhoneNumberId(
  phoneNumberId: string,
): Promise<Channel | null> {
  const id = phoneNumberId.trim();
  if (!id) return null;
  return prisma.channel.findFirst({
    where: {
      type: "WHATSAPP",
      provider: "META_CLOUD_API",
      config: { path: ["phoneNumberId"], equals: id },
    },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Webchat: sem handshake externo — nasce CONNECTED, com `publicKey` nova e
 * config default (+ o que o painel mandou, validado). Colisão da chave
 * (improvável: 62^24) repete com outra.
 */
async function createWebchatChannel(data: CreateChannelData): Promise<Channel> {
  for (let attempt = 0; ; attempt++) {
    const publicKey = generateWebchatPublicKey();
    const config = {
      ...normalizeWebchatConfig(data.config, defaultWebchatConfig(publicKey)),
      // v2 (§9.7): defaults seguros; segredos só pela rota de geração.
      v2: normalizeWebchatV2Config(
        (data.config as Record<string, unknown> | undefined)?.v2,
        defaultWebchatV2Config(),
      ),
    };
    try {
      return await prisma.channel.create({
        data: withOrgFromCtx({
          name: data.name.trim(),
          type: data.type,
          provider: data.provider,
          status: "CONNECTED" as const,
          lastConnectedAt: new Date(),
          publicKey,
          config: config as unknown as Prisma.InputJsonValue,
          phoneNumber: null,
        }),
      });
    } catch (err) {
      const p2002 =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (attempt < 2 && p2002) continue;
      throw err;
    }
  }
}

export async function createChannel(data: CreateChannelData): Promise<Channel> {
  // PR-1.2: encripta campos sensiveis (accessToken, appSecret, verifyToken)
  // antes de gravar. encryptChannelConfig e idempotente — se ja vier encriptado
  // (caso raro de re-uso de config), mantem como esta.
  const plainConfig = (data.config ?? {}) as Record<string, unknown>;
  const encryptedConfig = encryptChannelConfig(data.provider, plainConfig);

  const created =
    data.provider === "WEBCHAT"
      ? await createWebchatChannel(data)
      : await prisma.channel.create({
          data: withOrgFromCtx({
            name: data.name.trim(),
            type: data.type,
            provider: data.provider,
            config: encryptedConfig as Prisma.InputJsonValue,
            phoneNumber: data.phoneNumber?.trim() || null,
          }),
        });
  // Invalida os lookups de webhook da org (phoneNumberId→org, appSecrets)
  // e os "não mapeado": cobre o caso de um POST ter cacheado "não mapeado"
  // pouco antes do onboarding do canal novo.
  await invalidateChannelLookups(created.organizationId);
  await invalidateChannelsList(created.organizationId);
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
  if (before?.provider === "WEBCHAT") {
    // Webchat: config é patch parcial validado sobre o gravado; a chave
    // pública não muda por aqui. Sem janela de 24h. `v2` é mesclado sobre o
    // gravado; os segredos (encriptados) nunca vêm do cliente — preservados
    // do banco (só a rota de geração os troca, §9.5).
    if (data.config !== undefined) {
      const publicKey = before.publicKey ?? "";
      const current = readWebchatConfig(before.config, publicKey);
      const incoming = data.config as Record<string, unknown> | null;
      patch.config = {
        ...normalizeWebchatConfig(data.config, current),
        v2: normalizeWebchatV2Config(incoming?.v2, readWebchatV2Config(before.config)),
        ...pickWebchatSecretFields(before.config),
      } as unknown as Prisma.InputJsonValue;
    }
  } else if (data.config !== undefined || data.resetSessionWindow) {
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
  // Invalida os lookups cacheados de webhook da org deste canal: todos os
  // tipos de `wh_ctx` (channelId, phoneNumber, metaPhoneNumberId,
  // baileysSessionId) e os do webhook Meta (phoneNumberId→org, appSecrets)
  // — edição de config pode trocar phoneNumberId/appSecret. É a versão
  // `channel:<org>`; as outras orgs não perdem o cache.
  await cache.del(channelKey(id));
  await invalidateChannelLookups(updated.organizationId);
  await invalidateChannelsList(updated.organizationId);
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
  await invalidateChannelLookups(deleted.organizationId);
  await invalidateChannelsList(deleted.organizationId);
  await logAudit({
    entity: "channel",
    action: "delete",
    entityId: id,
    before: pickFields(deleted, CHANNEL_AUDIT_FIELDS),
  });
  return deleted;
}

/**
 * Gera (ou gira) um segredo v2 do canal WEBCHAT e devolve o valor em claro
 * UMA vez. O anterior deixa de valer na hora. Auditoria sem o valor.
 * `null` = canal não existe (na org do contexto) ou não é WEBCHAT.
 */
export async function rotateWebchatChannelSecret(
  id: string,
  kind: WebchatSecretKind,
): Promise<{ secret: string; rotatedAt: string; status: WebchatSecretsStatus } | null> {
  const before = await prisma.channel.findUnique({ where: { id } });
  if (!before || before.provider !== "WEBCHAT") return null;
  const next = withRotatedWebchatSecret(before.config, kind);
  const updated = await prisma.channel.update({
    where: { id },
    data: { config: next.config as Prisma.InputJsonValue },
  });
  await cache.del(channelKey(id));
  await invalidateChannelLookups(updated.organizationId);
  await invalidateChannelsList(updated.organizationId);
  await logAudit({
    entity: "channel",
    action: "update",
    entityId: id,
    after: { webchatSecretRotated: kind, rotatedAt: next.rotatedAt },
  });
  return { secret: next.plain, rotatedAt: next.rotatedAt, status: webchatSecretsStatus(next.config) };
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
  await invalidateChannelsList(updated.organizationId);
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
  await invalidateChannelsList(updated.organizationId);
  return updated;
}
