import nodemailer from "nodemailer";
import type { EmailEncryption } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { runtimeEnv } from "@/lib/runtime-env";
import {
  flattenMailerError,
  implicitTlsForPort,
  mailAuthMessage,
  mailboxProviderKind,
  mailerMeta,
  type EmailFieldError,
  type EmailOk,
} from "@/services/email-imap";

const log = getLogger("email-smtp");

export type SmtpConnectInput = {
  email: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpEncryption: EmailEncryption;
};

const CONNECT_TIMEOUT_MS = 15_000;

// ─── Relay / smarthost (fallback de saída) ───────────────────
// Provedores de cloud (DigitalOcean) bloqueiam 465/587 de saída na borda
// de rede. Com SMTP_RELAY_* configurado, uma falha de CONEXÃO no SMTP
// direto da conta cai para o relay. Erro de AUTH (535) NÃO cai no relay —
// senha errada é erro do usuário e o relay mascararia isso no teste de
// conexão. Sem SMTP_RELAY_HOST o comportamento é exatamente o de antes
// (opt-in — nunca cair automaticamente nas credenciais transacionais).
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

export function getSmtpRelayConfig(): SmtpRelayConfig | null {
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

/** Só falha de rede justifica relay — auth/TLS do servidor alvo, não. */
function isConnectionFailure(err: unknown): boolean {
  const raw = `${flattenMailerError(err)} ${mailerMeta(err).code ?? ""}`.toLowerCase();
  return (
    raw.includes("timeout") ||
    raw.includes("timed out") ||
    raw.includes("etimedout") ||
    raw.includes("econnrefused") ||
    raw.includes("econnreset") ||
    raw.includes("ehostunreach") ||
    raw.includes("enetunreach") ||
    raw.includes("enotfound") ||
    raw.includes("eai_again") ||
    raw.includes("epipe")
  );
}

function createRelayTransport(relay: SmtpRelayConfig) {
  return nodemailer.createTransport({
    host: relay.host,
    port: relay.port,
    secure: relay.secure,
    ...(relay.user ? { auth: { user: relay.user, pass: relay.pass ?? "" } } : {}),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
    tls: {
      servername: relay.host,
      minVersion: "TLSv1.2",
    },
  });
}

function createTransport(input: SmtpConnectInput) {
  const implicitTls = implicitTlsForPort(input.smtpPort, input.smtpEncryption);
  const uol = mailboxProviderKind(input.smtpHost) === "uol";
  return nodemailer.createTransport({
    host: input.smtpHost,
    port: input.smtpPort,
    secure: implicitTls,
    requireTLS: !implicitTls && input.smtpEncryption === "STARTTLS",
    auth: { user: input.email, pass: input.password },
    // PLAIN = senha com ! @ # em base64. LOGIN quoted falha em alguns Dovecot/UOL.
    ...(uol ? { authMethod: "PLAIN" } : {}),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
    tls: {
      servername: input.smtpHost,
      minVersion: "TLSv1.2",
    },
  });
}

function looksLikeAppPasswordRequired(lower: string): boolean {
  return (
    lower.includes("application-specific password") ||
    lower.includes("app password") ||
    lower.includes("app-password") ||
    lower.includes("web login required") ||
    lower.includes("via your web browser") ||
    lower.includes("please log in via")
  );
}

export function mapSmtpError(err: unknown, host = ""): EmailFieldError {
  const raw = flattenMailerError(err);
  const meta = mailerMeta(err);
  const lower = `${raw} ${meta.responseText ?? ""} ${meta.serverResponseCode ?? ""}`.toLowerCase();
  const kind = mailboxProviderKind(host);
  if (lower.includes("timeout")) {
    return { ok: false, field: "smtp_host", message: "Tempo esgotado ao conectar no SMTP. Verifique servidor e porta." };
  }
  if (looksLikeAppPasswordRequired(lower)) {
    return {
      ok: false,
      field: "password",
      message:
        "O provedor recusou a senha. Gmail e Outlook exigem senha de app — não use a senha da conta.",
    };
  }
  if (
    lower.includes("auth") ||
    lower.includes("invalid login") ||
    lower.includes("authenticationfailed") ||
    /\b535\b/.test(lower) ||
    /\b534\b/.test(lower)
  ) {
    return { ok: false, field: "password", message: mailAuthMessage(kind, "SMTP") };
  }
  if (lower.includes("enotfound") || lower.includes("econnrefused") || lower.includes("eai_again")) {
    return { ok: false, field: "smtp_host", message: "Servidor SMTP inacessível. Confira o host e a porta." };
  }
  if (lower.includes("econnreset") || lower.includes("ehostunreach") || lower.includes("enetunreach") || lower.includes("epipe")) {
    return { ok: false, field: "smtp_host", message: "A conexão SMTP foi recusada ou interrompida. Confira host, porta 465 e firewall de saída." };
  }
  if (lower.includes("certificate") || lower.includes("cert_") || lower.includes("ssl") || lower.includes("tls")) {
    return { ok: false, field: "smtp_encryption", message: "Falha de TLS no SMTP. Na porta 465 use SSL/TLS (implícito), não STARTTLS." };
  }
  log.warn({ err: raw, host, ...meta }, "erro SMTP");
  return {
    ok: false,
    field: "smtp_host",
    message: raw && raw !== "[object Object]"
      ? `Não foi possível conectar no SMTP (${raw.slice(0, 180)}).`
      : "Não foi possível conectar no SMTP.",
  };
}

export async function testSmtpConnection(input: SmtpConnectInput): Promise<EmailOk | EmailFieldError> {
  const transport = createTransport(input);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    const relay = getSmtpRelayConfig();
    if (!relay || !isConnectionFailure(err)) {
      return mapSmtpError(err, input.smtpHost);
    }
    log.warn(
      { err: flattenMailerError(err), host: input.smtpHost, relayHost: relay.host, relayPort: relay.port },
      "SMTP direto inacessível — testando via relay",
    );
    const relayTransport = createRelayTransport(relay);
    try {
      await relayTransport.verify();
      return { ok: true };
    } catch (relayErr) {
      return mapSmtpError(relayErr, relay.host);
    } finally {
      relayTransport.close();
    }
  } finally {
    transport.close();
  }
}

export async function sendSmtpMail(
  input: SmtpConnectInput,
  mail: { to: string; subject: string; text?: string; html?: string },
): Promise<{ ok: true; messageId: string } | EmailFieldError> {
  const transport = createTransport(input);
  try {
    const info = await transport.sendMail({
      from: input.email,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return { ok: true, messageId: info.messageId || `smtp-${Date.now()}@${input.smtpHost}` };
  } catch (err) {
    const relay = getSmtpRelayConfig();
    if (!relay || !isConnectionFailure(err)) {
      return mapSmtpError(err, input.smtpHost);
    }
    log.warn(
      { err: flattenMailerError(err), host: input.smtpHost, relayHost: relay.host, relayPort: relay.port },
      "SMTP direto inacessível — enviando via relay",
    );
    // From continua o e-mail da conta: o relay precisa aceitar esse remetente
    // (sender verificado / domínio autorizado no provedor do relay).
    const relayTransport = createRelayTransport(relay);
    try {
      const info = await relayTransport.sendMail({
        from: input.email,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      return { ok: true, messageId: info.messageId || `relay-${Date.now()}@${relay.host}` };
    } catch (relayErr) {
      return mapSmtpError(relayErr, relay.host);
    } finally {
      relayTransport.close();
    }
  } finally {
    transport.close();
  }
}
