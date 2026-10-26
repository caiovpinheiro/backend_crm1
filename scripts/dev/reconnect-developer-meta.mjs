/**
 * Reconecta um canal WhatsApp Cloud ligado pelo App do Developers
 * (token colado, nao Embedded Signup).
 *
 * Nao chama /register (nao troca o PIN). Nao substitui o config inteiro:
 * atualiza accessToken, appId, appSecret, phoneNumberId e WABA e mantem
 * verifyToken, webhookId e o restante.
 *
 * O .env da API ja e o banco unico do CRM. ORG_ID escolhe o tenant;
 * nao existe DATABASE_URL por organizacao.
 *
 *   $env:ORG_ID = '...'
 *   $env:PHONE_NUMBER_ID = '...'
 *   $env:WABA_ID = '...'
 *   $env:APP_ID = '...'
 *   $env:APP_SECRET = '...'
 *   $env:ACCESS_TOKEN = '...'
 *   node scripts/dev/reconnect-developer-meta.mjs
 *
 * Nao imprime token nem secret.
 */
import pkg from "@next/env";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

pkg.loadEnvConfig(process.cwd());

const ORG_ID = process.env.ORG_ID?.trim() ?? "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID?.trim() ?? "";
const WABA_ID = process.env.WABA_ID?.trim() ?? "";
const APP_ID = process.env.APP_ID?.trim() ?? "";
const APP_SECRET = process.env.APP_SECRET?.trim() ?? "";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN?.trim() ?? "";
const GRAPH = "https://graph.facebook.com/v21.0";
const PREFIX = "enc:v1:";

const required = {
  ORG_ID,
  PHONE_NUMBER_ID,
  WABA_ID,
  APP_ID,
  APP_SECRET,
  ACCESS_TOKEN,
};
const missing = Object.entries(required)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error("Faltam variaveis:", missing.join(", "));
  process.exit(1);
}

function key() {
  const raw = process.env.KEYRING_SECRET?.trim();
  if (!raw) throw new Error("KEYRING_SECRET ausente no .env");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("KEYRING_SECRET invalido");
  return buf;
}

function decrypt(value) {
  if (!value || !value.startsWith(PREFIX)) return value;
  const buf = Buffer.from(value.slice(PREFIX.length), "base64url");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(authTag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function encrypt(plain) {
  if (!plain) return plain;
  if (plain.startsWith(PREFIX)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url");
}

async function graph(path, init) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function redact(value) {
  return String(value)
    .split(ACCESS_TOKEN).join("[token]")
    .split(APP_SECRET).join("[secret]");
}

const db = new PrismaClient();

try {
  const org = await db.organization.findUnique({
    where: { id: ORG_ID },
    select: { id: true, name: true, slug: true },
  });
  if (!org) {
    console.error("Organizacao nao encontrada.");
    process.exit(1);
  }

  const channels = await db.channel.findMany({
    where: { organizationId: ORG_ID, provider: "META_CLOUD_API", type: "WHATSAPP" },
    select: {
      id: true,
      name: true,
      status: true,
      phoneNumber: true,
      config: true,
    },
  });

  const describe = (ch) => {
    const cfg = ch.config && typeof ch.config === "object" ? ch.config : {};
    return {
      id: ch.id,
      name: ch.name,
      status: ch.status,
      phoneNumber: ch.phoneNumber,
      phoneNumberId: cfg.phoneNumberId ?? null,
      businessAccountId: cfg.businessAccountId ?? cfg.wabaId ?? null,
    };
  };

  const matches = channels.filter((ch) => {
    const cfg = ch.config && typeof ch.config === "object" ? ch.config : {};
    return String(cfg.phoneNumberId ?? "") === PHONE_NUMBER_ID;
  });

  if (matches.length !== 1) {
    console.error(
      matches.length === 0
        ? "Nenhum canal WhatsApp Cloud com esse phone number id."
        : "Mais de um canal com esse phone number id.",
    );
    console.error(JSON.stringify({ org, channels: channels.map(describe) }, null, 2));
    process.exit(1);
  }

  const channel = matches[0];
  const previous = channel.config && typeof channel.config === "object" ? { ...channel.config } : {};
  for (const field of ["accessToken", "appSecret", "verifyToken"]) {
    if (typeof previous[field] === "string") previous[field] = decrypt(previous[field]);
  }

  const appToken = `${APP_ID}|${APP_SECRET}`;
  const debugUrl = new URL("https://graph.facebook.com/v21.0/debug_token");
  debugUrl.searchParams.set("input_token", ACCESS_TOKEN);
  debugUrl.searchParams.set("access_token", appToken);
  const debug = await graph(debugUrl.toString());
  const info = debug.data?.data ?? {};
  const tokenError = debug.data?.error ?? info.error;
  if (!debug.ok || info.is_valid !== true) {
    console.error(
      "Token recusado pela Meta:",
      tokenError?.message ?? JSON.stringify({ code: tokenError?.code, type: tokenError?.type }),
    );
    process.exit(1);
  }

  const phone = await graph(
    `${GRAPH}/${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,status,code_verification_status,quality_rating`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
  );
  if (!phone.ok) {
    console.error(
      "Numero recusado pela Meta:",
      phone.data?.error?.message ?? "erro sem mensagem",
    );
    process.exit(1);
  }

  const sub = await graph(`${GRAPH}/${WABA_ID}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });

  const next = {
    ...previous,
    accessToken: ACCESS_TOKEN,
    appSecret: APP_SECRET,
    appId: APP_ID,
    phoneNumberId: PHONE_NUMBER_ID,
    businessAccountId: WABA_ID,
    embeddedSignup: false,
  };
  if (typeof phone.data.verified_name === "string" && phone.data.verified_name) {
    next.verifiedName = phone.data.verified_name;
  }
  for (const field of ["accessToken", "appSecret", "verifyToken"]) {
    if (typeof next[field] === "string" && next[field]) next[field] = encrypt(next[field]);
  }

  const displayPhone =
    typeof phone.data.display_phone_number === "string"
      ? phone.data.display_phone_number
      : channel.phoneNumber;

  await db.channel.update({
    where: { id: channel.id },
    data: {
      config: next,
      status: "CONNECTED",
      lastConnectedAt: new Date(),
      phoneNumber: displayPhone,
      qrCode: null,
    },
  });

  const expiresAt = info.expires_at ?? null;
  console.log(
    JSON.stringify(
      {
        org: { id: org.id, slug: org.slug, name: org.name },
        channelId: channel.id,
        name: channel.name,
        status: `${channel.status} -> CONNECTED`,
        phoneNumber: displayPhone,
        phoneStatus: phone.data.status ?? null,
        verifiedName: phone.data.verified_name ?? null,
        tokenValid: true,
        tokenExpiresAt: expiresAt === 0 ? "never" : expiresAt,
        subscribedApps: sub.ok,
        subscribedAppsError: sub.ok ? null : (sub.data?.error?.message ?? "falhou"),
      },
      null,
      2,
    ),
  );
  if (!sub.ok) process.exit(2);
} catch (err) {
  console.error(redact(err instanceof Error ? err.message : err));
  process.exit(1);
} finally {
  await db.$disconnect();
}
