import { cache } from "@/lib/cache";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull, getOrgIdOrThrow } from "@/lib/request-context";
import { runtimeEnv } from "@/lib/runtime-env";

const log = getLogger("smtp-relay");

// ─── Relay / smarthost (fallback de saída) ───────────────────
// Provedores de cloud (DigitalOcean) bloqueiam 465/587 de saída na borda
// de rede. Com um relay configurado, uma falha de CONEXÃO no SMTP direto
// da conta cai para o relay. Erro de AUTH (535) NÃO cai no relay — senha
// errada é erro do usuário e o relay mascararia isso no teste de conexão.
//
// Fonte da config (ordem de precedência):
//   1. Banco (SmtpRelayConfig da org, via /settings/smtp-relay) — por
//      tenant, sem env. Toggle `enabled=false` desliga o relay pra org
//      e TAMBÉM impede o fallback pra env (o admin explicitamente
//      desligou — não faz sentido cair no relay global).
//   2. Envs SMTP_RELAY_* (legado global, backwards compat) — só quando a
//      org não tem NENHUMA row no banco.
//   3. null — comportamento idêntico ao de antes do relay existir.
//
// O relay NÃO é a conta transacional do CRM (SMTP_USER/SMTP_PASS do
// Mailjet). O From continua o e-mail da caixa conectada do usuário, então
// o relay precisa ser um smarthost autorizado a enviar por AQUELE domínio:
// o SMTP do próprio cliente, um smarthost dedicado da operação ou um
// serviço onde o domínio do cliente esteja verificado. Pela conta
// transacional o From quebra SPF/DKIM e o CRM passa a enviar em nome de
// domínios arbitrários.

export type SmtpRelayConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
};

/** Nomes montados em runtime — o bundler não consegue inlinear `undefined`. */
function relayKey(part: "HOST" | "PORT" | "USER" | "PASS" | "SECURE"): string {
  return ["SMTP", "RELAY", part].join("_");
}

/** Legado global via env — backwards compat (ver bloco de docs acima). */
export function getSmtpRelayConfigFromEnv(): SmtpRelayConfig | null {
  const host = runtimeEnv(relayKey("HOST"));
  if (!host) return null;
  const portRaw = Number(runtimeEnv(relayKey("PORT")) ?? "2525");
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : 2525;
  const secureRaw = (runtimeEnv(relayKey("SECURE")) ?? "").toLowerCase();
  const secure = secureRaw ? ["1", "true", "yes", "on"].includes(secureRaw) : port === 465;
  return {
    host,
    port,
    secure,
    user: runtimeEnv(relayKey("USER")),
    pass: runtimeEnv(relayKey("PASS")),
  };
}

// ── Leitura do banco (cacheada) ──────────────────────────────

type DbRelayResolution =
  | { kind: "none" }
  | { kind: "disabled" }
  | { kind: "config"; config: SmtpRelayConfig };

const TTL_SEC = 60;

function relayCacheKey(orgId: string): string {
  return `smtp_relay:${orgId}`;
}

/**
 * Lê a row da org e resolve para o formato de envio. Cacheado por 60s
 * (mesmo TTL das org-settings) — escrita invalida na hora via
 * `invalidateRelayCache`. Nunca logar `pass`.
 */
async function resolveDbRelay(orgId: string): Promise<DbRelayResolution> {
  return cache.wrap(relayCacheKey(orgId), TTL_SEC, async (): Promise<DbRelayResolution> => {
    const row = await prisma.smtpRelayConfig.findFirst({
      where: { organizationId: orgId },
      select: {
        host: true,
        port: true,
        secure: true,
        username: true,
        passwordEncrypted: true,
        enabled: true,
      },
    });
    if (!row) return { kind: "none" };
    if (!row.enabled) return { kind: "disabled" };
    let pass: string | undefined;
    if (row.passwordEncrypted) {
      try {
        pass = decryptSecret(row.passwordEncrypted);
      } catch (err) {
        // Chave errada/corrompido: sem senha o relay falharia com 535 e
        // mascararia o erro real. Tratar como "sem config" e logar.
        log.error({ err, orgId, host: row.host }, "senha do relay SMTP não decripta — ignorando config do banco");
        return { kind: "none" };
      }
    }
    return {
      kind: "config",
      config: {
        host: row.host,
        port: row.port,
        secure: row.secure,
        user: row.username ?? undefined,
        pass,
      },
    };
  });
}

/**
 * Resolve a config efetiva de relay pro envio/teste: DB da org (se houver
 * RequestContext) → env legada → null. Async porque lê o banco.
 *
 * Sem org no contexto (worker sem runWithContext — não deveria acontecer
 * no fluxo de e-mail, que é HTTP) cai direto na env, sem tocar no prisma
 * scoped (que throwaria fora de RequestContext).
 */
export async function getSmtpRelayConfig(): Promise<SmtpRelayConfig | null> {
  const orgId = getOrgIdOrNull();
  if (orgId) {
    const db = await resolveDbRelay(orgId);
    if (db.kind === "config") return db.config;
    if (db.kind === "disabled") return null;
  }
  return getSmtpRelayConfigFromEnv();
}

async function invalidateRelayCache(orgId: string): Promise<void> {
  await cache.del(relayCacheKey(orgId));
}

// ── Settings (API /api/settings/smtp-relay) ──────────────────

/** Visão segura pra UI — NUNCA inclui a senha (só `hasPassword`). */
export type SmtpRelaySettingsView = {
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  hasPassword: boolean;
  enabled: boolean;
  updatedAt: string | null;
};

const EMPTY_VIEW: SmtpRelaySettingsView = {
  configured: false,
  host: "",
  port: 587,
  secure: false,
  username: null,
  hasPassword: false,
  enabled: true,
  updatedAt: null,
};

export async function getSmtpRelaySettings(): Promise<SmtpRelaySettingsView> {
  const row = await prisma.smtpRelayConfig.findFirst({
    select: {
      host: true,
      port: true,
      secure: true,
      username: true,
      passwordEncrypted: true,
      enabled: true,
      updatedAt: true,
    },
  });
  if (!row) return EMPTY_VIEW;
  return {
    configured: true,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    hasPassword: Boolean(row.passwordEncrypted),
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type SmtpRelayFieldError = { ok: false; field: string; message: string };

export function isSmtpRelayFieldError(
  v: UpsertSmtpRelayInput | SmtpRelayFieldError,
): v is SmtpRelayFieldError {
  return "ok" in v && v.ok === false;
}

export type UpsertSmtpRelayInput = {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  /** undefined/"" = manter a senha atual; string = trocar. */
  password?: string;
  /** true = remover a senha (relay IP-authenticated, sem AUTH). */
  clearPassword?: boolean;
  enabled: boolean;
};

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

export function parseUpsertInput(
  body: Record<string, unknown>,
): UpsertSmtpRelayInput | SmtpRelayFieldError {
  const host = typeof body.host === "string" ? body.host.trim().toLowerCase() : "";
  if (!host || host.length > 253 || !HOST_RE.test(host) || host.includes("..")) {
    return { ok: false, field: "host", message: "Informe um host válido (ex.: smtp.suaempresa.com)." };
  }
  const portRaw = typeof body.port === "number" ? body.port : Number(body.port);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : NaN;
  if (!port) {
    return { ok: false, field: "port", message: "Porta inválida — use 465 (SSL) ou 587 (STARTTLS)." };
  }
  const username =
    typeof body.username === "string" && body.username.trim() ? body.username.trim() : null;
  const password = typeof body.password === "string" ? body.password : undefined;
  return {
    host,
    port,
    secure: body.secure === true,
    username,
    password: password || undefined,
    clearPassword: body.clearPassword === true,
    enabled: body.enabled !== false,
  };
}

export async function upsertSmtpRelaySettings(
  input: UpsertSmtpRelayInput,
): Promise<SmtpRelaySettingsView> {
  const orgId = getOrgIdOrThrow();
  const existing = await prisma.smtpRelayConfig.findFirst({
    select: { id: true, passwordEncrypted: true },
  });

  const passwordEncrypted = input.clearPassword
    ? null
    : input.password
      ? encryptSecret(input.password)
      : (existing?.passwordEncrypted ?? null);

  const data = {
    host: input.host,
    port: input.port,
    secure: input.secure,
    username: input.username,
    passwordEncrypted,
    enabled: input.enabled,
  };

  if (existing) {
    await prisma.smtpRelayConfig.update({ where: { id: existing.id }, data });
  } else {
    await prisma.smtpRelayConfig.create({ data: { ...data, organizationId: orgId } });
  }
  await invalidateRelayCache(orgId);
  return getSmtpRelaySettings();
}

export async function deleteSmtpRelaySettings(): Promise<void> {
  const orgId = getOrgIdOrThrow();
  await prisma.smtpRelayConfig.deleteMany({});
  await invalidateRelayCache(orgId);
}
