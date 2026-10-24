/**
 * State do Embedded Signup central (connect.bwipo.com).
 *
 * Assinado com `META_CONNECT_STATE_SECRET`. Não usa `META_APP_SECRET`.
 * O payload não autoriza sozinho: o complete ainda exige a sessão do
 * mesmo usuário e da mesma organização.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { buildTenantUrl, getTenantBaseDomain, getTenantProtocol } from "@/lib/tenant-url";

export class MetaConnectError extends Error {
  status: number;
  code: string;
  returnUrl?: string;
  constructor(message: string, status: number, code: string, returnUrl?: string) {
    super(message);
    this.name = "MetaConnectError";
    this.status = status;
    this.code = code;
    this.returnUrl = returnUrl;
  }
}

export type MetaConnectStatePayload = {
  organizationId: string;
  userId: string;
  nonce: string;
  /** Epoch ms. */
  exp: number;
  returnUrl: string;
  channelId?: string;
  name?: string;
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function metaConnectStateTtlSec(): number {
  const raw = Number(process.env.META_CONNECT_STATE_TTL_SEC ?? "600");
  if (!Number.isFinite(raw)) return 600;
  return Math.min(1800, Math.max(60, Math.floor(raw)));
}

export function metaConnectStateSecret(): string {
  const secret = process.env.META_CONNECT_STATE_SECRET?.trim() ?? "";
  if (secret.length < 16) {
    throw new MetaConnectError(
      "META_CONNECT_STATE_SECRET não configurado.",
      500,
      "STATE_SECRET",
    );
  }
  return secret;
}

/** Origem da página. Em produção, sem env, é https://connect.{base}. */
export function metaConnectPageOrigin(): string {
  const explicit = process.env.META_CONNECT_PUBLIC_ORIGIN?.trim().replace(/\/$/, "") ?? "";
  if (explicit) {
    let url: URL;
    try {
      url = new URL(explicit);
    } catch {
      throw new MetaConnectError(
        "META_CONNECT_PUBLIC_ORIGIN inválida.",
        500,
        "CONNECT_ORIGIN",
      );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new MetaConnectError(
        "META_CONNECT_PUBLIC_ORIGIN inválida.",
        500,
        "CONNECT_ORIGIN",
      );
    }
    return url.origin;
  }
  const base = getTenantBaseDomain();
  if (base === "localhost") {
    return `${getTenantProtocol()}://connect.localhost:3000`;
  }
  return `https://connect.${base}`;
}

export function metaConnectReturnUrl(slug: string): string {
  const clean = slug.trim().toLowerCase();
  if (!SLUG_RE.test(clean) || clean === "connect") {
    throw new MetaConnectError(
      "Organização inválida para voltar ao Bwipo.",
      400,
      "ORG_INVALID",
    );
  }
  return `${buildTenantUrl(clean)}/settings/channels`;
}

function sign(body: string): string {
  return createHmac("sha256", metaConnectStateSecret()).update(body).digest("base64url");
}

export function issueMetaConnectState(
  payload: MetaConnectStatePayload,
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function newMetaConnectNonce(): string {
  return randomBytes(32).toString("hex");
}

/** Assinatura válida. Não olha expiração — o caller decide. */
export function readMetaConnectState(state: string): MetaConnectStatePayload | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  if (!body || !mac) return null;
  let secret: string;
  try {
    secret = metaConnectStateSecret();
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MetaConnectStatePayload;
    if (
      !parsed ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.exp !== "number" ||
      typeof parsed.returnUrl !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
