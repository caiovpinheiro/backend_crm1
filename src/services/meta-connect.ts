/**
 * Embedded Signup no host connect.bwipo.com.
 *
 * Cookie de sessão (verificado antes de depender dele):
 * `src/lib/auth.config.ts` grava `__Secure-authjs.session-token` com
 * `sameSite: "lax"` e `secure` quando `NEXTAUTH_URL` é https.
 * `getAuthCookieDomain()` põe `Domain=.{TENANT_BASE_DOMAIN}`
 * (`.bwipo.com` com o default) nesse mesmo caso, salvo
 * `AUTH_COOKIE_DOMAIN=none`. O prefixo `__Secure-` permite Domain.
 * `connect.bwipo.com` e `api.bwipo.com` são same-site, então Lax
 * viaja no fetch com credenciais. O frontend não redefine esse cookie.
 */
import type { AppSession } from "@/lib/auth-helpers";
import { getAuthCookieDomain } from "@/lib/tenant-url";
import {
  issueMetaConnectState,
  metaConnectPageOrigin,
  metaConnectReturnUrl,
  metaConnectStateTtlSec,
  MetaConnectError,
  newMetaConnectNonce,
  readMetaConnectState,
  type MetaConnectStatePayload,
} from "@/lib/meta-connect-state";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  MetaProvisionError,
  provisionMetaCloudChannel,
} from "@/services/channels-meta-provision";
import { exchangeEmbeddedSignupCode } from "@/services/meta-embedded-signup-token";
import {
  claimMetaConnect,
  completeMetaConnectRecord,
  readMetaConnectRecord,
  releaseMetaConnectRecord,
  savePendingMetaConnect,
} from "@/services/meta-connect-store";

const log = getLogger("meta-connect");

function assertSharedSessionCookie(): void {
  if (process.env.NODE_ENV !== "production") return;
  const domain = getAuthCookieDomain();
  const secure = (process.env.NEXTAUTH_URL ?? "").startsWith("https://");
  if (!domain || !secure) {
    throw new MetaConnectError(
      "A sessão não está compartilhada entre subdomínios. Confira NEXTAUTH_URL em https e o Domain do cookie.",
      500,
      "SESSION_COOKIE",
    );
  }
}

function sessionOrg(session: AppSession): { organizationId: string; slug: string } {
  const organizationId = session.user.organizationId;
  const slug = session.user.organizationSlug;
  if (!organizationId || !slug) {
    throw new MetaConnectError(
      "Entre em uma organização para conectar o WhatsApp.",
      403,
      "ORG_REQUIRED",
    );
  }
  return { organizationId, slug };
}

function assertStateSession(
  payload: MetaConnectStatePayload,
  session: AppSession,
): void {
  const { organizationId } = sessionOrg(session);
  if (payload.userId !== session.user.id || payload.organizationId !== organizationId) {
    throw new MetaConnectError(
      "Esta conexão não pertence à sua sessão.",
      403,
      "STATE_MISMATCH",
    );
  }
}

export async function startMetaConnect(
  session: AppSession,
  input: { name?: string; channelId?: string },
): Promise<{ url: string }> {
  assertSharedSessionCookie();
  const { organizationId, slug } = sessionOrg(session);
  const name = input.name?.trim();
  if (name && name.length > 120) {
    throw new MetaConnectError("Nome do canal é longo demais.", 400, "INVALID_NAME");
  }
  const channelId = input.channelId?.trim();
  if (channelId) {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId },
      select: { id: true, type: true, provider: true },
    });
    if (!channel || channel.type !== "WHATSAPP" || channel.provider !== "META_CLOUD_API") {
      throw new MetaConnectError("Canal não encontrado.", 404, "CHANNEL_NOT_FOUND");
    }
  }

  const ttlSec = metaConnectStateTtlSec();
  const payload: MetaConnectStatePayload = {
    organizationId,
    userId: session.user.id,
    nonce: newMetaConnectNonce(),
    exp: Date.now() + ttlSec * 1000,
    returnUrl: metaConnectReturnUrl(slug),
    ...(channelId ? { channelId } : {}),
    ...(name ? { name } : {}),
  };
  await savePendingMetaConnect(
    payload.nonce,
    {
      status: "pending",
      organizationId,
      userId: session.user.id,
      returnUrl: payload.returnUrl,
      exp: payload.exp,
      ...(channelId ? { channelId } : {}),
      ...(name ? { name } : {}),
    },
    ttlSec,
  );
  const state = issueMetaConnectState(payload);
  const url = new URL("/meta/start", metaConnectPageOrigin());
  url.searchParams.set("state", state);
  return { url: url.toString() };
}

export async function previewMetaConnect(
  session: AppSession,
  state: string,
): Promise<{ returnUrl: string }> {
  const payload = readMetaConnectState(state.trim());
  if (!payload) {
    throw new MetaConnectError("Link de conexão inválido.", 400, "STATE_INVALID");
  }
  assertStateSession(payload, session);
  const record = await readMetaConnectRecord(payload.nonce);
  if (payload.exp <= Date.now() && record?.status !== "completed") {
    throw new MetaConnectError(
      "Este link expirou. Volte ao Bwipo e conecte de novo.",
      410,
      "STATE_EXPIRED",
      payload.returnUrl,
    );
  }
  if (!record) {
    throw new MetaConnectError(
      "Este link já foi usado ou não está mais disponível.",
      409,
      "STATE_USED",
      payload.returnUrl,
    );
  }
  return { returnUrl: record.returnUrl || payload.returnUrl };
}

async function claimReady(nonce: string, returnUrl: string) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const claimed = await claimMetaConnect(nonce);
    if (claimed.kind !== "busy") return claimed;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new MetaConnectError(
    "A conexão já está em andamento. Aguarde um instante e tente de novo.",
    409,
    "STATE_IN_PROGRESS",
    returnUrl,
  );
}

export async function finishMetaConnect(
  session: AppSession,
  input: { state: string; code: string; wabaId: string; phoneNumberId: string },
): Promise<{ ok: true; returnUrl: string; channelId: string; replayed: boolean }> {
  const payload = readMetaConnectState(input.state.trim());
  if (!payload) {
    throw new MetaConnectError("Link de conexão inválido.", 400, "STATE_INVALID");
  }
  assertStateSession(payload, session);

  const existing = await readMetaConnectRecord(payload.nonce);
  if (existing?.status === "completed" && existing.resultChannelId) {
    return {
      ok: true,
      returnUrl: existing.returnUrl,
      channelId: existing.resultChannelId,
      replayed: true,
    };
  }
  if (payload.exp <= Date.now()) {
    throw new MetaConnectError(
      "Este link expirou. Volte ao Bwipo e conecte de novo.",
      410,
      "STATE_EXPIRED",
      payload.returnUrl,
    );
  }

  const claimed = await claimReady(payload.nonce, payload.returnUrl);
  if (claimed.kind === "missing") {
    throw new MetaConnectError(
      "Este link já foi usado ou não está mais disponível.",
      409,
      "STATE_USED",
      payload.returnUrl,
    );
  }
  if (claimed.kind === "completed" && claimed.record.resultChannelId) {
    return {
      ok: true,
      returnUrl: claimed.record.returnUrl,
      channelId: claimed.record.resultChannelId,
      replayed: true,
    };
  }
  if (claimed.kind !== "claimed") {
    throw new MetaConnectError(
      "Este link já foi usado ou não está mais disponível.",
      409,
      "STATE_USED",
      payload.returnUrl,
    );
  }

  try {
    const accessToken = await exchangeEmbeddedSignupCode({ code: input.code });
    const result = await provisionMetaCloudChannel({
      accessToken,
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      name: payload.name,
      channelId: payload.channelId,
      embeddedSignup: true,
    });
    await completeMetaConnectRecord(
      payload.nonce,
      result.channel.id,
      payload.returnUrl,
      metaConnectStateTtlSec(),
    );
    return {
      ok: true,
      returnUrl: payload.returnUrl,
      channelId: result.channel.id,
      replayed: false,
    };
  } catch (err) {
    await releaseMetaConnectRecord(payload.nonce).catch((releaseErr) => {
      log.warn({ err: releaseErr }, "meta connect release failed");
    });
    if (err instanceof MetaProvisionError) {
      throw new MetaConnectError(err.message, err.status, "META_ERROR", payload.returnUrl);
    }
    log.error({ err }, "meta connect complete failed");
    throw new MetaConnectError(
      "Não foi possível concluir a conexão com a Meta.",
      500,
      "META_ERROR",
      payload.returnUrl,
    );
  }
}
