/**
 * OAuth 2.1 do MCP — Authorization Code + PKCE (S256), DCR (RFC 7591),
 * refresh com rotação, revogação (RFC 7009) e resource indicator (RFC 8707).
 *
 * Credenciais nunca são persistidas em claro (só SHA-256) nem logadas.
 * Não reaproveita `ApiToken` (`eduit_…`): o token MCP só vale em `/mcp`,
 * só para leitura e só nos escopos consentidos.
 *
 * `prismaBase` com `organizationId` explícito em toda consulta: os fluxos
 * OAuth acontecem antes de existir RequestContext (mesmo padrão de
 * `services/api-tokens.ts`).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { logAudit } from "@/lib/audit/log";
import {
  accessTokenTtlSec,
  AUTH_CODE_TTL_MS,
  mcpPublicOrigin,
  refreshTokenTtlMs,
} from "@/lib/mcp/config";
import {
  intersectScopes,
  MCP_SCOPES,
  parseScopeParam,
  type McpScope,
} from "@/lib/mcp/scopes";
import { prismaBase } from "@/lib/prisma-base";
import { canUserConnectMcp, getMcpOrgConfig } from "@/services/mcp/settings";

export const TOKEN_PREFIX = {
  code: "bwmcp_code_",
  access: "bwmcp_at_",
  refresh: "bwmcp_rt_",
  client: "mcpc_",
  secret: "mcps_",
} as const;

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
  }
  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}

export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function randomToken(prefix: string, bytes = 32): string {
  return prefix + randomBytes(bytes).toString("base64url");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ──────────────────────────────────────────────────────────────────────
// Redirect URIs
// ──────────────────────────────────────────────────────────────────────

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Aceita: https (sem fragmento), http só em loopback (CLIs/desktop, RFC
 * 8252 §7.3) e esquema privado de app (`cursor://…`, RFC 8252 §7.1).
 */
export function validateRedirectUri(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (BLOCKED_SCHEMES.has(url.protocol)) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return Boolean(url.hostname);
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  // Esquema privado: letras/dígitos/+.- (RFC 3986), pelo menos 2 chars.
  return /^[a-z][a-z0-9+.-]+:$/i.test(url.protocol);
}

/** Loopback: a porta pode variar a cada execução (RFC 8252 §7.3). */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    if (a.protocol !== "http:" || !LOOPBACK_HOSTS.has(a.hostname)) return false;
    return (
      a.protocol === b.protocol &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Dynamic Client Registration (RFC 7591)
// ──────────────────────────────────────────────────────────────────────

export type ClientRegistrationInput = {
  client_name?: unknown;
  redirect_uris?: unknown;
  client_uri?: unknown;
  logo_uri?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
};

function optionalHttpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

export async function registerClient(input: ClientRegistrationInput, ipHash: string | null) {
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  if (uris.length === 0 || uris.length > 10) {
    throw new OAuthError("invalid_redirect_uri", "Informe de 1 a 10 redirect_uris.");
  }
  for (const u of uris) {
    if (typeof u !== "string" || !validateRedirectUri(u)) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uri não permitida.");
    }
  }
  const grantTypes = Array.isArray(input.grant_types)
    ? (input.grant_types as unknown[]).filter((g): g is string => typeof g === "string")
    : ["authorization_code", "refresh_token"];
  if (grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    throw new OAuthError("invalid_client_metadata", "Só authorization_code e refresh_token.");
  }
  const responseTypes = Array.isArray(input.response_types)
    ? (input.response_types as unknown[]).filter((g): g is string => typeof g === "string")
    : ["code"];
  if (responseTypes.some((r) => r !== "code")) {
    throw new OAuthError("invalid_client_metadata", "Só response_type=code.");
  }
  const method =
    typeof input.token_endpoint_auth_method === "string"
      ? input.token_endpoint_auth_method
      : "none";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    throw new OAuthError("invalid_client_metadata", "token_endpoint_auth_method não suportado.");
  }
  const rawName = typeof input.client_name === "string" ? input.client_name.trim() : "";
  const clientName = (rawName || "Cliente MCP").replace(/[\u0000-\u001f<>]/g, "").slice(0, 80);

  const clientId = randomToken(TOKEN_PREFIX.client, 18);
  const secret = method === "none" ? null : randomToken(TOKEN_PREFIX.secret, 32);
  const row = await prismaBase.mcpOAuthClient.create({
    data: {
      clientId,
      clientName,
      clientUri: optionalHttpsUrl(input.client_uri),
      logoUri: optionalHttpsUrl(input.logo_uri),
      redirectUris: uris as string[],
      clientSecretHash: secret ? hashSecret(secret) : null,
      registeredIpHash: ipHash,
    },
    select: { clientId: true, createdAt: true },
  });
  return {
    client_id: row.clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    client_name: clientName,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    scope: MCP_SCOPES.join(" "),
  };
}

type ClientRow = {
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  clientSecretHash: string | null;
};

const CLIENT_SELECT = {
  id: true,
  clientId: true,
  clientName: true,
  clientUri: true,
  logoUri: true,
  redirectUris: true,
  clientSecretHash: true,
} as const;

export async function findClient(clientId: string | null | undefined): Promise<ClientRow | null> {
  if (!clientId || typeof clientId !== "string" || clientId.length > 100) return null;
  return prismaBase.mcpOAuthClient.findUnique({ where: { clientId }, select: CLIENT_SELECT });
}

/** Autenticação do cliente no token/revoke endpoint. */
export function authenticateClient(client: ClientRow, secret: string | null): void {
  if (!client.clientSecretHash) return; // público: PKCE é a prova
  if (!secret || !safeEqualHex(client.clientSecretHash, hashSecret(secret))) {
    throw new OAuthError("invalid_client", "Credenciais do cliente inválidas.", 401);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Authorization request
// ──────────────────────────────────────────────────────────────────────

export type AuthorizeParams = {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  scope?: string | null;
  state?: string | null;
  resource?: string | null;
};

export function authorizeParamsFrom(search: URLSearchParams): AuthorizeParams {
  const g = (k: string) => search.get(k);
  return {
    response_type: g("response_type"),
    client_id: g("client_id"),
    redirect_uri: g("redirect_uri"),
    code_challenge: g("code_challenge"),
    code_challenge_method: g("code_challenge_method"),
    scope: g("scope"),
    state: g("state"),
    resource: g("resource"),
  };
}

export type ValidatedAuthorize = {
  client: ClientRow;
  redirectUri: string;
  requestedScopes: McpScope[];
  codeChallenge: string;
  state: string | null;
  resource: string | null;
};

/**
 * Erro antes de confiar no `redirect_uri` → mostra na tela (nunca
 * redireciona para URI não registrada). Depois → volta ao cliente com
 * `error=` (RFC 6749 §4.1.2.1).
 */
export type AuthorizeValidation =
  | { ok: true; value: ValidatedAuthorize }
  | { ok: false; redirectable: false; error: OAuthError }
  | { ok: false; redirectable: true; error: OAuthError; redirectUri: string; state: string | null };

/** Recurso aceito: `<origin>/mcp` (com ou sem barra final) ou a própria origem. */
export function isAcceptedResource(resource: string, request?: Request): boolean {
  const origin = mcpPublicOrigin(request);
  const norm = resource.replace(/\/+$/, "");
  return norm === origin || norm === `${origin}/mcp`;
}

export async function validateAuthorizeRequest(
  p: AuthorizeParams,
  request?: Request,
): Promise<AuthorizeValidation> {
  const client = await findClient(p.client_id);
  if (!client) {
    return { ok: false, redirectable: false, error: new OAuthError("invalid_client", "Cliente desconhecido. Reconecte pelo seu assistente.") };
  }
  const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
  if (!redirectUri || !client.redirectUris.some((r) => redirectMatches(r, redirectUri))) {
    return { ok: false, redirectable: false, error: new OAuthError("invalid_request", "redirect_uri não registrada para este cliente.") };
  }
  const state = p.state ? p.state.slice(0, 1000) : null;
  const fail = (error: string, description: string): AuthorizeValidation => ({
    ok: false,
    redirectable: true,
    error: new OAuthError(error, description),
    redirectUri,
    state,
  });
  if (p.response_type !== "code") return fail("unsupported_response_type", "Só response_type=code.");
  if (!p.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) {
    return fail("invalid_request", "PKCE obrigatório (code_challenge).");
  }
  if (p.code_challenge_method !== "S256") {
    return fail("invalid_request", "PKCE exige code_challenge_method=S256.");
  }
  if (p.resource && !isAcceptedResource(p.resource, request)) {
    return fail("invalid_target", "resource inválido para este servidor.");
  }
  // Escopos desconhecidos (ex.: `openid`) são ignorados; sem nenhum nosso,
  // pede todos — o usuário escolhe na tela de consentimento.
  const parsed = parseScopeParam(p.scope);
  const requested = parsed.length > 0 ? parsed : [...MCP_SCOPES];
  return {
    ok: true,
    value: {
      client,
      redirectUri,
      requestedScopes: requested,
      codeChallenge: p.code_challenge,
      state,
      resource: p.resource ?? null,
    },
  };
}

export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}

export type ConsentUser = {
  id: string;
  organizationId: string | null;
  isSuperAdmin?: boolean;
};

/**
 * Usuário aprovou: cria/atualiza a conexão e emite o authorization code.
 * Escopos finais = escolhidos ∩ pedidos ∩ liberados pela organização.
 */
export async function approveAuthorization(
  user: ConsentUser,
  v: ValidatedAuthorize,
  chosenScopes: readonly string[],
): Promise<{ redirectTo: string; connectionId: string; scopes: McpScope[] }> {
  const eligibility = await canUserConnectMcp(user);
  if (!eligibility.ok || !user.organizationId) {
    throw new OAuthError("access_denied", "MCP indisponível para este usuário.", 403);
  }
  const orgId = user.organizationId;
  const scopes = intersectScopes(
    intersectScopes(chosenScopes, v.requestedScopes),
    eligibility.config.allowedScopes,
  );
  if (scopes.length === 0) {
    throw new OAuthError("invalid_scope", "Selecione ao menos uma permissão.", 400);
  }

  const dbUser = await prismaBase.user.findUnique({
    where: { id: user.id },
    select: { sessionVersion: true, isErased: true, organizationId: true },
  });
  if (!dbUser || dbUser.isErased || dbUser.organizationId !== orgId) {
    throw new OAuthError("access_denied", "MCP indisponível para este usuário.", 403);
  }
  const existing = await prismaBase.mcpConnection.findFirst({
    where: { organizationId: orgId, userId: user.id, clientId: v.client.id, revokedAt: null },
    select: { id: true },
  });
  const connection = existing
    ? await prismaBase.mcpConnection.update({
        where: { id: existing.id },
        data: { scopes, lastError: null, lastErrorAt: null, userSessionVersion: dbUser.sessionVersion },
        select: { id: true },
      })
    : await prismaBase.mcpConnection.create({
        data: {
          organizationId: orgId,
          userId: user.id,
          clientId: v.client.id,
          scopes,
          userSessionVersion: dbUser.sessionVersion,
        },
        select: { id: true },
      });

  const code = randomToken(TOKEN_PREFIX.code);
  await prismaBase.mcpToken.create({
    data: {
      tokenHash: hashSecret(code),
      kind: "CODE",
      organizationId: orgId,
      connectionId: connection.id,
      clientId: v.client.id,
      scopes,
      codeChallenge: v.codeChallenge,
      redirectUri: v.redirectUri,
      resource: v.resource,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    },
  });

  await prismaBase.mcpAuditLog.create({
    data: {
      organizationId: orgId,
      connectionId: connection.id,
      userId: user.id,
      tool: "oauth.consent",
      status: "ok",
      args: { client: v.client.clientName, scopes },
    },
  });
  await logAudit({
    entity: "mcp_connection",
    action: existing ? "update" : "create",
    entityId: connection.id,
    organizationId: orgId,
    actorId: user.id,
    after: { client: v.client.clientName, scopes },
  });

  return {
    redirectTo: buildRedirect(v.redirectUri, {
      code,
      state: v.state,
      iss: mcpPublicOrigin(),
    }),
    connectionId: connection.id,
    scopes,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Token endpoint
// ──────────────────────────────────────────────────────────────────────

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

async function issueTokenPair(args: {
  organizationId: string;
  connectionId: string;
  clientId: string;
  scopes: McpScope[];
  resource: string | null;
}): Promise<TokenResponse> {
  const access = randomToken(TOKEN_PREFIX.access);
  const refresh = randomToken(TOKEN_PREFIX.refresh);
  const ttl = accessTokenTtlSec();
  const now = Date.now();
  await prismaBase.mcpToken.createMany({
    data: [
      {
        tokenHash: hashSecret(access),
        kind: "ACCESS",
        organizationId: args.organizationId,
        connectionId: args.connectionId,
        clientId: args.clientId,
        scopes: args.scopes,
        resource: args.resource,
        expiresAt: new Date(now + ttl * 1000),
      },
      {
        tokenHash: hashSecret(refresh),
        kind: "REFRESH",
        organizationId: args.organizationId,
        connectionId: args.connectionId,
        clientId: args.clientId,
        scopes: args.scopes,
        resource: args.resource,
        expiresAt: new Date(now + refreshTokenTtlMs()),
      },
    ],
  });
  void prismaBase.mcpOAuthClient
    .update({ where: { id: args.clientId }, data: { lastUsedAt: new Date(now) } })
    .catch(() => {});
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ttl,
    refresh_token: refresh,
    scope: args.scopes.join(" "),
  };
}

/** Revoga todos os tokens vivos da conexão (sem revogar o consentimento). */
async function revokeConnectionTokens(connectionId: string): Promise<void> {
  await prismaBase.mcpToken.updateMany({
    where: { connectionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Troca de senha / "sair de todos os dispositivos" / erase sobem
 * `User.sessionVersion` (`lib/auth/session-revocation.ts`). Conexão
 * autorizada numa versão anterior cai junto. `null` = conexão antiga, sem
 * versão gravada (não derruba).
 */
export function sessionsRevokedSinceConsent(
  consentVersion: number | null,
  currentVersion: number,
): boolean {
  return consentVersion !== null && currentVersion !== consentVersion;
}

async function assertConnectionUsable(connectionId: string): Promise<{
  organizationId: string;
  userId: string;
  scopes: string[];
}> {
  const conn = await prismaBase.mcpConnection.findUnique({
    where: { id: connectionId },
    select: {
      organizationId: true,
      userId: true,
      scopes: true,
      revokedAt: true,
      userSessionVersion: true,
      user: {
        select: {
          organizationId: true,
          isErased: true,
          sessionVersion: true,
          organization: { select: { status: true } },
        },
      },
    },
  });
  if (!conn || conn.revokedAt) throw new OAuthError("invalid_grant", "Conexão revogada.");
  if (
    conn.user.organizationId !== conn.organizationId ||
    conn.user.organization?.status !== "ACTIVE" ||
    conn.user.isErased
  ) {
    throw new OAuthError("invalid_grant", "Usuário sem acesso à organização.");
  }
  if (sessionsRevokedSinceConsent(conn.userSessionVersion, conn.user.sessionVersion)) {
    await revokeConnection(conn.organizationId, connectionId, null, conn.userId);
    throw new OAuthError("invalid_grant", "Sessões do usuário foram encerradas. Conecte de novo.");
  }
  const elig = await canUserConnectMcp({ id: conn.userId, organizationId: conn.organizationId });
  if (!elig.ok) throw new OAuthError("invalid_grant", "MCP desativado ou sem permissão.");
  return { organizationId: conn.organizationId, userId: conn.userId, scopes: conn.scopes };
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function exchangeAuthorizationCode(args: {
  client: ClientRow;
  code: string;
  codeVerifier: string;
  redirectUri: string | null;
  resource: string | null;
}): Promise<TokenResponse> {
  const row = await prismaBase.mcpToken.findUnique({
    where: { tokenHash: hashSecret(args.code) },
    select: {
      id: true,
      kind: true,
      organizationId: true,
      connectionId: true,
      clientId: true,
      scopes: true,
      codeChallenge: true,
      redirectUri: true,
      resource: true,
      expiresAt: true,
      usedAt: true,
      revokedAt: true,
    },
  });
  if (!row || row.kind !== "CODE" || row.clientId !== args.client.id) {
    throw new OAuthError("invalid_grant", "Código inválido.");
  }
  if (row.usedAt || row.revokedAt) {
    // Reuso de código: revoga o que foi emitido a partir dele (RFC 6749 §4.1.2).
    await revokeConnectionTokens(row.connectionId);
    throw new OAuthError("invalid_grant", "Código já utilizado.");
  }
  if (row.expiresAt.getTime() < Date.now()) throw new OAuthError("invalid_grant", "Código expirado.");
  if (row.redirectUri && args.redirectUri !== row.redirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri diferente da autorização.");
  }
  if (!row.codeChallenge || !verifyPkce(args.codeVerifier, row.codeChallenge)) {
    throw new OAuthError("invalid_grant", "code_verifier inválido.");
  }
  if (args.resource && row.resource && args.resource.replace(/\/+$/, "") !== row.resource.replace(/\/+$/, "")) {
    throw new OAuthError("invalid_target", "resource diferente da autorização.");
  }
  const claimed = await prismaBase.mcpToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw new OAuthError("invalid_grant", "Código já utilizado.");

  const conn = await assertConnectionUsable(row.connectionId);
  const scopes = intersectScopes(row.scopes, conn.scopes);
  return issueTokenPair({
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    clientId: row.clientId,
    scopes,
    resource: row.resource ?? args.resource,
  });
}

/** Janela em que um refresh repetido é tratado como retry, não como roubo. */
const REFRESH_RETRY_GRACE_MS = 30_000;

export async function refreshAccessToken(args: {
  client: ClientRow;
  refreshToken: string;
  scope: string | null;
}): Promise<TokenResponse> {
  const row = await prismaBase.mcpToken.findUnique({
    where: { tokenHash: hashSecret(args.refreshToken) },
    select: {
      id: true,
      kind: true,
      organizationId: true,
      connectionId: true,
      clientId: true,
      scopes: true,
      resource: true,
      expiresAt: true,
      usedAt: true,
      revokedAt: true,
    },
  });
  if (!row || row.kind !== "REFRESH" || row.clientId !== args.client.id) {
    throw new OAuthError("invalid_grant", "Refresh token inválido.");
  }
  if (row.usedAt || row.revokedAt) {
    const recentRetry =
      row.usedAt && !row.revokedAt && Date.now() - row.usedAt.getTime() < REFRESH_RETRY_GRACE_MS;
    if (!recentRetry) {
      // Reuso de refresh já trocado: sinal de vazamento → derruba a família.
      await revokeConnectionTokens(row.connectionId);
      await prismaBase.mcpConnection
        .update({
          where: { id: row.connectionId },
          data: { lastError: "refresh_token_reuse", lastErrorAt: new Date() },
        })
        .catch(() => {});
    }
    throw new OAuthError("invalid_grant", "Refresh token já utilizado.");
  }
  if (row.expiresAt.getTime() < Date.now()) throw new OAuthError("invalid_grant", "Refresh token expirado.");

  const conn = await assertConnectionUsable(row.connectionId);
  let scopes = intersectScopes(row.scopes, conn.scopes);
  if (args.scope) {
    const asked = parseScopeParam(args.scope);
    if (asked.some((s) => !scopes.includes(s))) {
      throw new OAuthError("invalid_scope", "Escopo além do concedido.");
    }
    scopes = intersectScopes(asked, scopes);
  }
  const claimed = await prismaBase.mcpToken.updateMany({
    where: { id: row.id, usedAt: null, revokedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw new OAuthError("invalid_grant", "Refresh token já utilizado.");
  return issueTokenPair({
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    clientId: row.clientId,
    scopes,
    resource: row.resource,
  });
}

/** RFC 7009: sempre 200, mesmo para token desconhecido. */
export async function revokeTokenByValue(client: ClientRow, token: string): Promise<void> {
  const row = await prismaBase.mcpToken.findUnique({
    where: { tokenHash: hashSecret(token) },
    select: { id: true, kind: true, clientId: true, connectionId: true, organizationId: true },
  });
  if (!row || row.clientId !== client.id) return;
  if (row.kind === "REFRESH") {
    // Cliente desconectou: encerra a conexão inteira.
    await revokeConnection(row.organizationId, row.connectionId, null);
    return;
  }
  await prismaBase.mcpToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
}

/** Revoga consentimento + todos os tokens. Efeito imediato (sem cache). */
export async function revokeConnection(
  organizationId: string,
  connectionId: string,
  actorId: string | null,
  ownerUserId?: string,
): Promise<boolean> {
  const res = await prismaBase.mcpConnection.updateMany({
    where: { id: connectionId, organizationId, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: actorId },
  });
  await prismaBase.mcpToken.updateMany({
    where: { connectionId, organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (res.count > 0) {
    await prismaBase.mcpAuditLog
      .create({
        data: {
          organizationId,
          connectionId,
          // Dono da conexão: a revogação aparece no histórico de quem perdeu
          // o acesso; quem revogou vai em `args`.
          userId:
            ownerUserId ??
            (
              await prismaBase.mcpConnection.findUnique({
                where: { id: connectionId },
                select: { userId: true },
              })
            )?.userId ??
            actorId,
          tool: "oauth.revoke",
          status: "ok",
          args: { revokedBy: actorId ?? "cliente" },
        },
      })
      .catch(() => {});
    await logAudit({
      entity: "mcp_connection",
      action: "token_revoke",
      entityId: connectionId,
      organizationId,
      actorId,
    });
  }
  return res.count > 0;
}

// ──────────────────────────────────────────────────────────────────────
// Validação do access token em `/mcp`
// ──────────────────────────────────────────────────────────────────────

export type McpPrincipal = {
  tokenId: string;
  connectionId: string;
  clientName: string;
  organizationId: string;
  scopes: McpScope[];
  user: { id: string; name: string; email: string; role: string };
  exposeContactPii: boolean;
  /** Campos personalizados liberados pela org (`custom_fields:read`). */
  customFieldIds: string[];
};

const lastUsedTouch = new Map<string, number>();

export async function validateAccessToken(
  raw: string,
): Promise<{ ok: true; principal: McpPrincipal } | { ok: false; reason: string }> {
  if (!raw.startsWith(TOKEN_PREFIX.access)) return { ok: false, reason: "invalid_token" };
  const row = await prismaBase.mcpToken.findUnique({
    where: { tokenHash: hashSecret(raw) },
    select: {
      id: true,
      kind: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      organizationId: true,
      connection: {
        select: {
          id: true,
          revokedAt: true,
          scopes: true,
          organizationId: true,
          userSessionVersion: true,
          client: { select: { clientName: true } },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              organizationId: true,
              isErased: true,
              sessionVersion: true,
              organization: { select: { status: true } },
            },
          },
        },
      },
    },
  });
  if (!row || row.kind !== "ACCESS") return { ok: false, reason: "invalid_token" };
  if (row.revokedAt) return { ok: false, reason: "token_revoked" };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "token_expired" };
  const conn = row.connection;
  if (conn.revokedAt) return { ok: false, reason: "connection_revoked" };
  if (conn.organizationId !== row.organizationId) return { ok: false, reason: "invalid_token" };
  // Usuário mudou de org / org suspensa: nunca atravessa organizações.
  if (conn.user.organizationId !== conn.organizationId) return { ok: false, reason: "user_left_org" };
  if (conn.user.organization?.status !== "ACTIVE") return { ok: false, reason: "org_inactive" };
  // Anonimizado (LGPD): mesma regra do login.
  if (conn.user.isErased) return { ok: false, reason: "user_erased" };
  if (sessionsRevokedSinceConsent(conn.userSessionVersion, conn.user.sessionVersion)) {
    await revokeConnection(conn.organizationId, conn.id, null, conn.user.id);
    return { ok: false, reason: "sessions_revoked" };
  }

  const elig = await canUserConnectMcp({ id: conn.user.id, organizationId: conn.organizationId });
  if (!elig.ok) return { ok: false, reason: elig.reason };

  const scopes = intersectScopes(intersectScopes(row.scopes, conn.scopes), elig.config.allowedScopes);
  const now = Date.now();
  if ((lastUsedTouch.get(conn.id) ?? 0) < now - 60_000) {
    lastUsedTouch.set(conn.id, now);
    if (lastUsedTouch.size > 5000) lastUsedTouch.clear();
    void prismaBase.mcpConnection
      .update({ where: { id: conn.id }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {});
  }
  return {
    ok: true,
    principal: {
      tokenId: row.id,
      connectionId: conn.id,
      clientName: conn.client.clientName,
      organizationId: conn.organizationId,
      scopes,
      user: {
        id: conn.user.id,
        name: conn.user.name,
        email: conn.user.email,
        role: String(conn.user.role),
      },
      exposeContactPii: elig.config.exposeContactPii,
      customFieldIds: elig.config.customFieldIds,
    },
  };
}

export { getMcpOrgConfig };
