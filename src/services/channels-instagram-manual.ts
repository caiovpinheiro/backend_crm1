/**
 * Conexao manual do Instagram Direct — mesmo modelo do WhatsApp
 * `/api/channels/manual-cloud` (App Meta da org, org por org).
 *
 * Aceita dois tipos de token (o operador cola o que gerou no painel Meta):
 *   1. Instagram Login (graph.instagram.com) — token da conta Business,
 *      em geral via "Entrar com Instagram". Provider META_INSTAGRAM_LOGIN.
 *   2. Usuario do sistema / Pagina (graph.facebook.com) — token EAA...
 *      gerado em Business Settings. Precisa de Pagina com Instagram
 *      Business vinculado. Provider META_CLOUD_API (envio via Pagina).
 *
 * O webhook e a URL opaca `/api/webhooks/meta/<webhookId>` gerada pelo
 * botao Webhook.
 */
import type { Channel } from "@prisma/client";

import {
  createChannel,
  getChannelById,
  parseChannelConfig,
  updateChannel,
} from "@/services/channels";

const GRAPH_API_VERSION = "v21.0";
const IG_GRAPH = `https://graph.instagram.com/${GRAPH_API_VERSION}`;
const FB_GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export class IgManualProvisionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "IgManualProvisionError";
    this.status = status;
  }
}

export type ProvisionInstagramManualInput = {
  accessToken: string;
  instagramUserId?: string;
  name?: string;
  channelId?: string;
  verifyToken?: string;
  webhookId?: string;
  appSecret?: string;
};

type GraphErr = { message?: string; code?: number };

type MeResponse = {
  user_id?: string;
  id?: string;
  username?: string;
  name?: string;
  error?: GraphErr;
};

type FbPage = {
  id?: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: {
    id?: string;
    username?: string;
    name?: string;
  };
};

type IgIdentity = {
  provider: "META_INSTAGRAM_LOGIN" | "META_CLOUD_API";
  accessToken: string;
  instagramUserId?: string;
  instagramAccountId?: string;
  pageId?: string;
  pageName?: string;
  username: string;
  displayName: string;
  webhookSubscribed: boolean;
};

function sanitizeMetaAccessToken(raw: string): string {
  // O prefixo `Bearer ` tem que sair ANTES da limpeza de espaços/aspas, e
  // o `^` só casa se nada vier antes dele. Token colado da UI vem com
  // espaço/aspas na frente (`  Bearer "EAA…"`), então o `^Bearer` não
  // casava e a limpeza colava o literal no token: `BearerEAA…`.
  return raw
    .replace(/^[\uFEFF\s"'`]+/, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/[\s"'`]+/g, "");
}

function graphErrorMessage(data: { error?: GraphErr }, fallback: string): string {
  return data.error?.message?.trim() || fallback;
}

function isUnparseableIgToken(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("cannot parse access token") ||
    m.includes("invalid oauth access token")
  );
}

async function graphGet<T extends { error?: GraphErr }>(
  url: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

async function subscribePageMessages(
  pageId: string,
  pageToken: string,
): Promise<boolean> {
  const subUrl = new URL(`${FB_GRAPH}/${pageId}/subscribed_apps`);
  subUrl.searchParams.set("subscribed_fields", "messages,messaging_postbacks");
  subUrl.searchParams.set("access_token", pageToken);
  const subRes = await fetch(subUrl.toString(), { method: "POST" });
  if (subRes.ok) return true;
  const subErr = (await subRes.json().catch(() => ({}))) as { error?: GraphErr };
  console.warn(
    "[provisionInstagramManual] page subscribed_apps non-fatal:",
    subErr.error?.message || `HTTP ${subRes.status}`,
  );
  return false;
}

async function subscribeIgLoginMessages(
  instagramUserId: string,
  token: string,
): Promise<boolean> {
  const subUrl = new URL(`${IG_GRAPH}/${instagramUserId}/subscribed_apps`);
  subUrl.searchParams.set("subscribed_fields", "messages");
  subUrl.searchParams.set("access_token", token);
  const subRes = await fetch(subUrl.toString(), { method: "POST" });
  if (subRes.ok) return true;
  const subErr = (await subRes.json().catch(() => ({}))) as { error?: GraphErr };
  console.warn(
    "[provisionInstagramManual] ig subscribed_apps non-fatal:",
    subErr.error?.message || `HTTP ${subRes.status}`,
  );
  return false;
}

async function resolveViaInstagramLogin(
  token: string,
  requestedIgId?: string,
): Promise<{ ok: true; identity: IgIdentity } | { ok: false; error: string }> {
  const meUrl = new URL(`${IG_GRAPH}/me`);
  meUrl.searchParams.set("fields", "user_id,username,name,id");
  meUrl.searchParams.set("access_token", token);
  const me = await graphGet<MeResponse>(meUrl.toString());
  if (!me.ok) {
    return {
      ok: false,
      error: graphErrorMessage(me.data, `Meta nao aceitou o token (HTTP ${me.status}).`),
    };
  }
  const meId = (me.data.user_id || me.data.id || "").trim();
  const username = (me.data.username || "").trim();
  const displayName = (me.data.name || username).trim();
  const instagramUserId = (requestedIgId || meId).trim();
  if (!instagramUserId) {
    return {
      ok: false,
      error:
        "Meta nao retornou o Instagram User ID. Cole o ID da conta Business.",
    };
  }
  if (meId && requestedIgId && meId !== requestedIgId) {
    return {
      ok: false,
      error: `O token pertence ao ID ${meId}, nao ao ${requestedIgId}.`,
    };
  }
  const webhookSubscribed = await subscribeIgLoginMessages(instagramUserId, token);
  return {
    ok: true,
    identity: {
      provider: "META_INSTAGRAM_LOGIN",
      accessToken: token,
      instagramUserId,
      username,
      displayName,
      webhookSubscribed,
    },
  };
}

function pickPageWithInstagram(
  pages: FbPage[],
  requestedIgId?: string,
): FbPage | null {
  const withIg = pages.filter((p) => p.instagram_business_account?.id?.trim());
  if (requestedIgId) {
    const match = withIg.find(
      (p) => p.instagram_business_account?.id?.trim() === requestedIgId,
    );
    if (match) return match;
  }
  return withIg[0] ?? null;
}

async function resolveViaFacebookPage(
  token: string,
  requestedIgId?: string,
): Promise<{ ok: true; identity: IgIdentity } | { ok: false; error: string }> {
  const meUrl = new URL(`${FB_GRAPH}/me`);
  meUrl.searchParams.set("fields", "id,name");
  meUrl.searchParams.set("access_token", token);
  const me = await graphGet<MeResponse>(meUrl.toString());
  if (!me.ok) {
    return {
      ok: false,
      error: graphErrorMessage(me.data, `Meta nao aceitou o token (HTTP ${me.status}).`),
    };
  }

  const accountsUrl = new URL(`${FB_GRAPH}/me/accounts`);
  accountsUrl.searchParams.set(
    "fields",
    "id,name,access_token,instagram_business_account{id,username,name}",
  );
  accountsUrl.searchParams.set("limit", "100");
  accountsUrl.searchParams.set("access_token", token);
  const accounts = await graphGet<{ data?: FbPage[]; error?: GraphErr }>(
    accountsUrl.toString(),
  );

  let pages: FbPage[] = accounts.ok ? (accounts.data.data ?? []) : [];

  if (pages.length === 0 && me.data.id) {
    const pageUrl = new URL(`${FB_GRAPH}/${me.data.id}`);
    pageUrl.searchParams.set(
      "fields",
      "id,name,instagram_business_account{id,username,name}",
    );
    pageUrl.searchParams.set("access_token", token);
    const page = await graphGet<FbPage>(pageUrl.toString());
    if (page.ok && page.data.id) {
      pages = [{ ...page.data, access_token: token }];
    }
  }

  const page = pickPageWithInstagram(pages, requestedIgId);
  if (!page?.id) {
    const hint = accounts.ok
      ? "Nenhuma Pagina do Facebook com Instagram Business vinculado foi encontrada neste token."
      : graphErrorMessage(
          accounts.data,
          "Nao foi possivel listar Paginas (permissao pages_show_list?).",
        );
    return {
      ok: false,
      error:
        `${hint} Atribua o usuario do sistema a Pagina, vincule o Instagram ` +
        `Business e inclua pages_messaging + instagram_manage_messages.`,
    };
  }

  const ig = page.instagram_business_account;
  const instagramAccountId = ig?.id?.trim() || "";
  if (!instagramAccountId) {
    return {
      ok: false,
      error:
        "Esta Pagina nao tem uma conta Instagram Business vinculada. Vincule no Meta Business Suite.",
    };
  }
  if (requestedIgId && requestedIgId !== instagramAccountId) {
    return {
      ok: false,
      error: `O Instagram vinculado a Pagina e ${instagramAccountId}, nao ${requestedIgId}.`,
    };
  }

  const pageToken = page.access_token?.trim() || token;
  const username = (ig?.username || "").trim();
  const displayName = (ig?.name || page.name || username).trim();
  const webhookSubscribed = await subscribePageMessages(page.id, pageToken);

  return {
    ok: true,
    identity: {
      provider: "META_CLOUD_API",
      accessToken: pageToken,
      instagramAccountId,
      instagramUserId: instagramAccountId,
      pageId: page.id,
      pageName: page.name?.trim() || undefined,
      username,
      displayName,
      webhookSubscribed,
    },
  };
}

export async function resolveInstagramManualIdentity(
  accessToken: string,
  requestedIgId?: string,
): Promise<IgIdentity> {
  const token = sanitizeMetaAccessToken(accessToken);
  if (!token) {
    throw new IgManualProvisionError("Token de acesso e obrigatorio.", 400);
  }

  const ig = await resolveViaInstagramLogin(token, requestedIgId);
  if (ig.ok) return ig.identity;

  const fb = await resolveViaFacebookPage(token, requestedIgId);
  if (fb.ok) return fb.identity;

  if (isUnparseableIgToken(ig.error)) {
    throw new IgManualProvisionError(
      `Esse token e do Facebook Graph (usuario do sistema / Pagina). ` +
        `${fb.error} ` +
        `No App da empresa: atribua o usuario do sistema a Pagina, vincule o Instagram Business a essa Pagina e gere o token com pages_show_list, pages_messaging, instagram_basic, instagram_manage_messages e pages_manage_metadata.`,
      400,
    );
  }

  throw new IgManualProvisionError(ig.error || fb.error, 400);
}

export async function provisionInstagramManualChannel(
  input: ProvisionInstagramManualInput,
): Promise<{
  channel: Channel;
  created: boolean;
  username: string;
  webhookSubscribed: boolean;
}> {
  const accessToken = sanitizeMetaAccessToken(input.accessToken);
  if (!accessToken) {
    throw new IgManualProvisionError("Token de acesso e obrigatorio.", 400);
  }
  let existingConfig: Record<string, unknown> = {};
  if (input.channelId) {
    const existing = await getChannelById(input.channelId);
    if (!existing) throw new IgManualProvisionError("Canal nao encontrado.", 404);
    existingConfig = parseChannelConfig(existing.config);
  }

  const identity = await resolveInstagramManualIdentity(
    accessToken,
    input.instagramUserId?.trim() || undefined,
  );

  const config: Record<string, unknown> = {
    ...existingConfig,
    platform: "instagram",
    accessToken: identity.accessToken,
  };
  if (identity.instagramUserId) config.instagramUserId = identity.instagramUserId;
  if (identity.instagramAccountId) {
    config.instagramAccountId = identity.instagramAccountId;
  }
  if (identity.pageId) config.pageId = identity.pageId;
  if (identity.pageName) config.pageName = identity.pageName;
  if (identity.username) config.username = identity.username;
  if (identity.displayName) config.displayName = identity.displayName;
  if (input.verifyToken) config.verifyToken = input.verifyToken;
  if (input.webhookId) config.webhookId = input.webhookId;
  if (input.appSecret) config.appSecret = input.appSecret;

  const name =
    input.name?.trim() ||
    `Instagram @${identity.username || identity.instagramAccountId || identity.instagramUserId}`;

  let channel: Channel;
  let created = false;
  if (input.channelId) {
    channel = await updateChannel(input.channelId, {
      name,
      type: "INSTAGRAM",
      provider: identity.provider,
      config,
      status: "CONNECTED",
      lastConnectedAt: new Date(),
    });
  } else {
    channel = await createChannel({
      name,
      type: "INSTAGRAM",
      provider: identity.provider,
      config,
    });
    channel = await updateChannel(channel.id, {
      status: "CONNECTED",
      lastConnectedAt: new Date(),
    });
    created = true;
  }

  return {
    channel,
    created,
    username: identity.username,
    webhookSubscribed: identity.webhookSubscribed,
  };
}

export const IG_MANUAL_INTERNAL = {
  sanitizeMetaAccessToken,
  resolveInstagramManualIdentity,
};
