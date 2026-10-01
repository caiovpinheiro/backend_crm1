/**
 * FCM HTTP v1 — so entrega nativa no APK. Nao usa Firestore/Auth/Hosting.
 *
 * Credenciais:
 *  - FCM_PROJECT_ID (ou project_id no JSON da service account)
 *  - FCM_SERVICE_ACCOUNT_JSON (JSON cru ou base64 da chave da conta)
 *
 * Sem google-auth-library: JWT RS256 + oauth2 token endpoint.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PushPayload } from "@/lib/web-push";
import { getLogger } from "@/lib/logger";

const log = getLogger("fcm");

export const FCM_ENDPOINT_PREFIX = "fcm:";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export function fcmEndpointFromToken(token: string): string {
  return `${FCM_ENDPOINT_PREFIX}${token.trim()}`;
}

export function isFcmEndpoint(endpoint: string): boolean {
  return endpoint.startsWith(FCM_ENDPOINT_PREFIX);
}

export function fcmTokenFromEndpoint(endpoint: string): string {
  return endpoint.slice(FCM_ENDPOINT_PREFIX.length);
}

function parseServiceAccount(): ServiceAccount | null {
  try {
    const filePath = process.env.FCM_SERVICE_ACCOUNT_PATH?.trim();
    let raw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim() ?? "";
    if (!raw && filePath) {
      raw = readFileSync(filePath, "utf8");
    }
    if (!raw) return null;
    raw = raw.trim();
    if (
      (raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"'))
    ) {
      raw = raw.slice(1, -1);
    }
    const json = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(json) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isFcmConfigured(): boolean {
  if (process.env.FCM_ENABLED === "0") return false;
  const sa = parseServiceAccount();
  const projectId =
    process.env.FCM_PROJECT_ID?.trim() || sa?.project_id?.trim();
  return Boolean(sa && projectId);
}

function getProjectId(): string | null {
  const sa = parseServiceAccount();
  return process.env.FCM_PROJECT_ID?.trim() || sa?.project_id?.trim() || null;
}

function toBase64Url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function getAccessToken(): Promise<string | null> {
  const sa = parseServiceAccount();
  if (!sa) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) {
    return cachedToken.accessToken;
  }

  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = toBase64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = toBase64Url(signer.sign(sa.private_key));
  const jwt = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log.error({ resStatus: res.status, text: text.slice(0, 300) }, "[fcm] oauth token failed");
    return null;
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) return null;
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600),
  };
  return cachedToken.accessToken;
}

function stringifyData(
  payload: PushPayload,
): Record<string, string> {
  const data: Record<string, string> = {};
  if (payload.url) data.url = payload.url;
  if (payload.tag) data.tag = payload.tag;
  if (payload.data) {
    for (const [key, value] of Object.entries(payload.data)) {
      if (value == null) continue;
      data[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  return data;
}

export type FcmSendResult = "ok" | "unregistered" | "error";

export async function sendFcmToToken(
  token: string,
  payload: PushPayload,
): Promise<FcmSendResult> {
  if (!isFcmConfigured()) return "error";
  const projectId = getProjectId();
  const accessToken = await getAccessToken();
  if (!projectId || !accessToken) return "error";

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title: payload.title,
            body: payload.body,
          },
          data: stringifyData(payload),
            android: {
            ttl: "3600s",
            notification: {
              icon: "ic_stat_notify",
              color: "#0D1B3E",
              tag: payload.tag,
              click_action: "OPEN_ACTIVITY",
            },
          },
        },
      }),
    },
  );

  if (res.ok) return "ok";

  const text = await res.text().catch(() => "");
  const unregistered =
    res.status === 404 ||
    /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/i.test(text);
  if (unregistered) return "unregistered";
  log.error({ resStatus: res.status, text: text.slice(0, 400) }, "[fcm] send failed");
  return "error";
}
