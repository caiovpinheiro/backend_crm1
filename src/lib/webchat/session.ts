/**
 * Porta de entrada das rotas públicas do webchat (`/api/public/webchat/*`):
 * canal pela `publicKey`, origem contra `allowedOrigins`, visitante pelo
 * Bearer e emissão/renovação da sessão. Sem sessão de usuário — por isso
 * `prismaBase` aqui (o contexto de org só existe depois de achar o canal);
 * as rotas embrulham o resto em `withSystemContext(org)`.
 */
import { createHash, randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { classifyBrowserApiOrigin } from "@/lib/browser-api-cors";
import { wrapChannelLookup } from "@/lib/cache/keys";
import { getClientIp } from "@/lib/client-ip";
import { getLogger } from "@/lib/logger";
// prismaBase: chamada pública sem RequestContext — a org sai do canal
// resolvido pela chave (mesmo papel do `withWebhookContext`).
import { prismaBase } from "@/lib/prisma-base";
import {
  canonicalOrigin,
  isWebchatPublicKey,
  readWebchatConfig,
  webchatOrgDefaults,
  type WebchatChannelConfig,
} from "@/lib/webchat/config";
import {
  bearerFrom,
  hashWebchatToken,
  signWebchatToken,
  verifyWebchatToken,
} from "@/lib/webchat/token";

const log = getLogger("webchat");

/** Cache do canal por chave/id (invalidado pela versão `channel:<org>`). */
const CHANNEL_CACHE_TTL_SEC = 60;
/** `lastSeenAt` só é regravado depois deste intervalo (poll a cada 3 s). */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
/**
 * Depois de girar o token, o anterior ainda vale por este tempo: outra aba
 * ou um poll em voo com o token antigo não toma 401 (o widget relê o
 * localStorage no 401, mas a corrida é comum ao abrir a página).
 */
export const WEBCHAT_TOKEN_GRACE_MS = 60_000;
const DEFAULT_SESSION_MAX_AGE_DAYS = 90;
const MAX_SESSION_MAX_AGE_DAYS = 3650;

/**
 * Vida máxima da sessão do visitante, contada da criação
 * (`WEBCHAT_SESSION_MAX_AGE_DAYS`, padrão 90). Passado isso o token não
 * autentica e a renovação cria um visitante novo em vez de renovar para
 * sempre.
 */
export function webchatSessionMaxAgeMs(): number {
  const raw = Number(process.env.WEBCHAT_SESSION_MAX_AGE_DAYS?.trim() || "");
  const days =
    Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_SESSION_MAX_AGE_DAYS) : DEFAULT_SESSION_MAX_AGE_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

export function isWebchatSessionTooOld(createdAt: Date, now: number = Date.now()): boolean {
  return now - createdAt.getTime() > webchatSessionMaxAgeMs();
}
const MAX_URL = 2000;
const MAX_UTM_VALUE = 500;
const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_id",
  "utm_referrer",
  "gclid",
  "fbclid",
] as const;

export type WebchatChannel = {
  id: string;
  organizationId: string;
  name: string;
  publicKey: string;
  defaultPipelineId: string | null;
  config: WebchatChannelConfig;
  /** Marca da org (cor/logo) que o tema herda quando o canal não define. */
  orgDefaults: { primary: string; avatarUrl: string | null };
};

export type WebchatSessionRow = {
  id: string;
  organizationId: string;
  channelId: string;
  contactId: string | null;
  tokenHash: string;
  /** Hash do token anterior — vale até `rotatedAt + WEBCHAT_TOKEN_GRACE_MS`. */
  prevTokenHash: string | null;
  rotatedAt: Date | null;
  expiresAt: Date;
  lastSeenAt: Date;
  firstUrl: string | null;
  lastUrl: string | null;
  referrer: string | null;
  utm: Prisma.JsonValue | null;
  createdAt: Date;
};

export type WebchatErrorCode =
  | "INVALID_KEY"
  | "CHANNEL_NOT_FOUND"
  | "ORIGIN_NOT_ALLOWED"
  | "TOKEN_MISSING"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "INVALID_JSON"
  | "INVALID_BODY"
  | "CONTENT_TOO_LONG"
  | "PAYLOAD_TOO_LARGE";

export function webchatError(
  status: number,
  code: WebchatErrorCode,
  message: string,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json({ message, code }, { status, headers });
}

type ChannelRow = {
  id: string;
  organizationId: string;
  name: string;
  publicKey: string | null;
  provider: string;
  status: string;
  defaultPipelineId: string | null;
  config: Prisma.JsonValue;
  organization: { status: string; primaryColor: string | null; logoUrl: string | null } | null;
};

const CHANNEL_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  publicKey: true,
  provider: true,
  status: true,
  defaultPipelineId: true,
  config: true,
  organization: { select: { status: true, primaryColor: true, logoUrl: true } },
} as const;

function toWebchatChannel(row: ChannelRow | null): WebchatChannel | null {
  if (!row || row.provider !== "WEBCHAT" || !row.publicKey) return null;
  if (row.status !== "CONNECTED") return null;
  if (row.organization && row.organization.status !== "ACTIVE") return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    publicKey: row.publicKey,
    defaultPipelineId: row.defaultPipelineId,
    config: readWebchatConfig(row.config, row.publicKey),
    orgDefaults: webchatOrgDefaults(row.organization),
  };
}

export async function loadWebchatChannelByKey(publicKey: string): Promise<WebchatChannel | null> {
  if (!isWebchatPublicKey(publicKey)) return null;
  return wrapChannelLookup(`webchat:s:key:${publicKey}`, CHANNEL_CACHE_TTL_SEC, async () =>
    toWebchatChannel(
      (await prismaBase.channel.findUnique({
        where: { publicKey },
        select: CHANNEL_SELECT,
      })) as ChannelRow | null,
    ),
  );
}

export async function loadWebchatChannelById(id: string): Promise<WebchatChannel | null> {
  return wrapChannelLookup(`webchat:s:id:${id}`, CHANNEL_CACHE_TTL_SEC, async () =>
    toWebchatChannel(
      (await prismaBase.channel.findUnique({
        where: { id },
        select: CHANNEL_SELECT,
      })) as ChannelRow | null,
    ),
  );
}

/** A página hospedada / iframe do widget (apex `bwipo.com` ou extras de CORS). */
function isHostedPageOrigin(origin: string): boolean {
  const kind = classifyBrowserApiOrigin(origin)?.kind;
  return kind === "apex" || kind === "extra";
}

/**
 * Origem da chamada contra o canal (§3.3/§3.4):
 *  - `Origin` do browser: tem de ser a página do widget (apex/extras) ou
 *    uma origem de `allowedOrigins`;
 *  - `host` (origem da página do cliente que embute o iframe, `?host=` do
 *    loader): tem de estar em `allowedOrigins`. Vazio = só a página
 *    hospedada (host ausente ou o próprio apex).
 * Sem `Origin` nem `host` (chamada fora de browser) passa — o Bearer e o
 * rate limit seguram o resto.
 */
export function checkWebchatOrigin(
  request: Request,
  config: WebchatChannelConfig,
  host?: string | null,
): boolean {
  const allowed = new Set(config.allowedOrigins);
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    if (!isHostedPageOrigin(origin) && !allowed.has(origin)) return false;
  } else if (origin === "null") {
    return false;
  }
  if (host !== undefined && host !== null && host !== "") {
    const h = canonicalOrigin(host);
    if (!h) return false;
    if (!allowed.has(h) && !isHostedPageOrigin(h)) return false;
  }
  return true;
}

export function originDenied(): NextResponse {
  return webchatError(403, "ORIGIN_NOT_ALLOWED", "Origem não autorizada para este chat.");
}

// ── Visitante (Bearer) ──────────────────────────────────────────────

export type AuthenticatedVisitor = {
  channel: WebchatChannel;
  session: WebchatSessionRow;
};

const SESSION_SELECT = {
  id: true,
  organizationId: true,
  channelId: true,
  contactId: true,
  tokenHash: true,
  prevTokenHash: true,
  rotatedAt: true,
  expiresAt: true,
  lastSeenAt: true,
  firstUrl: true,
  lastUrl: true,
  referrer: true,
  utm: true,
  createdAt: true,
} as const;

/**
 * O token apresentado é o atual da sessão ou o imediatamente anterior,
 * ainda dentro da carência pós-rotação.
 */
export function sessionAcceptsToken(
  session: Pick<WebchatSessionRow, "tokenHash" | "prevTokenHash" | "rotatedAt">,
  token: string,
  now: number = Date.now(),
): boolean {
  const hash = hashWebchatToken(token);
  if (session.tokenHash === hash) return true;
  return (
    session.prevTokenHash === hash &&
    session.rotatedAt !== null &&
    now - session.rotatedAt.getTime() <= WEBCHAT_TOKEN_GRACE_MS
  );
}

/**
 * Bearer → sessão viva + canal. 401 para token ausente/inválido/vencido ou
 * substituído por um mais novo (hash diferente); 404 se o canal saiu do ar;
 * 403 se a origem não vale para o canal.
 */
export async function authenticateWebchatVisitor(
  request: Request,
  opts: { host?: string | null } = {},
): Promise<{ ok: true; visitor: AuthenticatedVisitor } | { ok: false; response: NextResponse }> {
  const token = bearerFrom(request);
  const verified = await verifyWebchatToken(token);
  if (!verified.ok) {
    if (verified.reason === "missing") {
      return { ok: false, response: webchatError(401, "TOKEN_MISSING", "Sessão do chat ausente.") };
    }
    if (verified.reason === "expired") {
      return { ok: false, response: webchatError(401, "TOKEN_EXPIRED", "Sessão do chat expirada.") };
    }
    return { ok: false, response: webchatError(401, "TOKEN_INVALID", "Sessão do chat inválida.") };
  }
  const { claims } = verified;
  const session = (await prismaBase.webchatSession.findUnique({
    where: { id: claims.vis },
    select: SESSION_SELECT,
  })) as WebchatSessionRow | null;
  if (
    !session ||
    session.organizationId !== claims.org ||
    session.channelId !== claims.ch ||
    !sessionAcceptsToken(session, token as string) ||
    session.expiresAt.getTime() <= Date.now()
  ) {
    return { ok: false, response: webchatError(401, "TOKEN_INVALID", "Sessão do chat inválida.") };
  }
  if (isWebchatSessionTooOld(session.createdAt)) {
    // Vida máxima: o widget renova em POST /session, que cria visitante novo.
    return { ok: false, response: webchatError(401, "TOKEN_EXPIRED", "Sessão do chat expirada.") };
  }
  const channel = await loadWebchatChannelById(session.channelId);
  if (!channel || channel.organizationId !== session.organizationId) {
    return { ok: false, response: webchatError(404, "CHANNEL_NOT_FOUND", "Chat indisponível.") };
  }
  if (!checkWebchatOrigin(request, channel.config, opts.host)) {
    return { ok: false, response: originDenied() };
  }
  touchLastSeen(session);
  return { ok: true, visitor: { channel, session } };
}

function touchLastSeen(session: WebchatSessionRow): void {
  const now = Date.now();
  if (now - session.lastSeenAt.getTime() < LAST_SEEN_WRITE_INTERVAL_MS) return;
  void prismaBase.webchatSession
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } })
    .catch((err: unknown) => log.debug({ err, visitorId: session.id }, "lastSeenAt falhou"));
}

// ── Emissão / renovação ─────────────────────────────────────────────

const VISITOR_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Id do visitante (= `WebchatSession.id`): "wv_" + 20 chars. */
export function generateVisitorId(): string {
  let out = "";
  while (out.length < 20) {
    for (const b of randomBytes(24)) {
      // 252 = 7 × 36: descarta o resto para não enviesar.
      if (b < 252 && out.length < 20) out += VISITOR_ALPHABET[b % 36];
    }
  }
  return `wv_${out}`;
}

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

/** URL http(s) cortada no teto; outra coisa vira null. */
export function sanitizeUrl(v: unknown): string | null {
  const s = clip(v, MAX_URL);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().slice(0, MAX_URL);
  } catch {
    return null;
  }
}

/** Só as chaves de rastreio conhecidas, strings curtas. */
export function sanitizeUtm(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const val = clip((v as Record<string, unknown>)[key], MAX_UTM_VALUE);
    if (val) out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** LGPD: nunca o IP cru — sha256 com sal do segredo do app. */
export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  const salt = (process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "").trim();
  return createHash("sha256").update(`webchat-ip:${salt}:${ip}`).digest("hex").slice(0, 32);
}

export type IssuedSession = {
  token: string;
  expiresAt: Date;
  session: WebchatSessionRow;
  renewed: boolean;
};

/**
 * Sessão que o Bearer da requisição pode renovar, ou null. Só leitura —
 * a rota decide o rate limit antes de gravar qualquer coisa:
 *  - assinatura válida (vencido vale), mesmo canal/org;
 *  - o token é o último emitido para a sessão (ou o anterior, na carência
 *    pós-rotação);
 *  - a sessão não passou da vida máxima (aí vira visitante novo).
 * `visitorId` sozinho não retoma nada: sem prova de posse seria sequestro
 * de conversa.
 */
export async function findRenewableWebchatSession(
  request: Request,
  channel: WebchatChannel,
): Promise<WebchatSessionRow | null> {
  const token = bearerFrom(request);
  if (!token) return null;
  const verified = await verifyWebchatToken(token, { allowExpired: true });
  if (!verified.ok) return null;
  if (verified.claims.ch !== channel.id || verified.claims.org !== channel.organizationId) return null;
  const existing = (await prismaBase.webchatSession.findUnique({
    where: { id: verified.claims.vis },
    select: SESSION_SELECT,
  })) as WebchatSessionRow | null;
  if (!existing || existing.channelId !== channel.id) return null;
  if (existing.organizationId !== channel.organizationId) return null;
  if (!sessionAcceptsToken(existing, token)) return null;
  if (isWebchatSessionTooOld(existing.createdAt)) return null;
  return existing;
}

/** Dados de rotação: o token atual vira o anterior (carência). */
function rotationData(current: Pick<WebchatSessionRow, "tokenHash">, now: Date) {
  return { prevTokenHash: current.tokenHash, rotatedAt: now };
}

/**
 * Renova `renewable` (de `findRenewableWebchatSession`) ou cria um
 * visitante novo. Quem chama já cobrou o rate limit certo: o do visitante
 * na renovação, o do IP na criação.
 */
export async function issueWebchatSession(args: {
  request: Request;
  channel: WebchatChannel;
  renewable: WebchatSessionRow | null;
  page: string | null;
  referrer: string | null;
  utm: Record<string, string> | null;
}): Promise<IssuedSession> {
  const { request, channel, renewable: existing } = args;
  const now = new Date();
  if (existing) {
    const signed = await signWebchatToken(
      { org: channel.organizationId, ch: channel.id, vis: existing.id, cid: existing.contactId },
      now,
    );
    const session = (await prismaBase.webchatSession.update({
      where: { id: existing.id },
      data: {
        tokenHash: signed.tokenHash,
        ...rotationData(existing, now),
        expiresAt: signed.expiresAt,
        lastSeenAt: now,
        ...(args.page ? { lastUrl: args.page } : {}),
      },
      select: SESSION_SELECT,
    })) as WebchatSessionRow;
    return { token: signed.token, expiresAt: signed.expiresAt, session, renewed: true };
  }

  const visitorId = generateVisitorId();
  const signed = await signWebchatToken(
    { org: channel.organizationId, ch: channel.id, vis: visitorId, cid: null },
    now,
  );
  const session = (await prismaBase.webchatSession.create({
    data: {
      id: visitorId,
      organizationId: channel.organizationId,
      channelId: channel.id,
      contactId: null,
      tokenHash: signed.tokenHash,
      expiresAt: signed.expiresAt,
      lastSeenAt: now,
      firstUrl: args.page,
      lastUrl: args.page,
      referrer: args.referrer,
      ...(args.utm ? { utm: args.utm } : {}),
      userAgent: clip(request.headers.get("user-agent"), 500),
      ipHash: hashIp(getClientIp(request)),
    },
    select: SESSION_SELECT,
  })) as WebchatSessionRow;
  return { token: signed.token, expiresAt: signed.expiresAt, session, renewed: false };
}

/**
 * Novo token para a mesma sessão (o identify devolve token novo). O
 * anterior segue valendo na carência. Lê o hash atual do banco: o da linha
 * em memória pode ser de antes de outra aba girar.
 */
export async function reissueWebchatToken(
  session: WebchatSessionRow,
  contactId: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const now = new Date();
  const signed = await signWebchatToken(
    {
      org: session.organizationId,
      ch: session.channelId,
      vis: session.id,
      cid: contactId,
    },
    now,
  );
  const current = await prismaBase.webchatSession.findUnique({
    where: { id: session.id },
    select: { tokenHash: true },
  });
  await prismaBase.webchatSession.update({
    where: { id: session.id },
    data: {
      tokenHash: signed.tokenHash,
      ...rotationData(current ?? session, now),
      expiresAt: signed.expiresAt,
    },
  });
  return { token: signed.token, expiresAt: signed.expiresAt };
}

/** Campos de rastreio do contato a partir da primeira visita (§3.2). */
export function contactTrackingFromSession(
  session: Pick<WebchatSessionRow, "referrer" | "utm" | "firstUrl">,
): Record<string, string> {
  const utm = (session.utm && typeof session.utm === "object" && !Array.isArray(session.utm)
    ? session.utm
    : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof utm[k] === "string" ? (utm[k] as string) : null);
  const out: Record<string, string> = {};
  const set = (field: string, v: string | null) => {
    if (v) out[field] = v;
  };
  set("adUtmSource", s("utm_source"));
  set("adUtmMedium", s("utm_medium"));
  set("adUtmCampaign", s("utm_campaign"));
  set("adUtmContent", s("utm_content"));
  set("adUtmTerm", s("utm_term"));
  set("utmId", s("utm_id"));
  set("utmReferrer", s("utm_referrer"));
  set("gclid", s("gclid"));
  set("fbclid", s("fbclid"));
  set("referrer", session.referrer ?? null);
  return out;
}
