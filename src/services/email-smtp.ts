import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import * as socks from "socks";
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
import { buildSmtpMailPayload, type SmtpMailInput } from "@/services/email-smtp-payload";
import { getSmtpRelayConfig, type SmtpRelayConfig } from "@/services/smtp-relay";

const log = getLogger("email-smtp");

export type SmtpConnectInput = {
  email: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpEncryption: EmailEncryption;
  /** Nome de exibição do `From` (dono da conta). Só usado no envio. */
  fromName?: string | null;
};

const CONNECT_TIMEOUT_MS = 15_000;

// ─── Proxy de saída (SMTP_PROXY_URL) ─────────────────────────
// A DigitalOcean bloqueia 25/465/587 de saída na borda de rede (drop, não
// recusa: cada tentativa direta estoura o CONNECT_TIMEOUT_MS). Com
// SMTP_PROXY_URL=socks5://user:pass@host:porta (ou http://) o Nodemailer
// abre a conexão "direta" da conta através de um proxy num servidor onde
// essas portas saem. O proxy só repassa TCP: TLS (servername do destino)
// e AUTH continuam fim-a-fim entre o CRM e o SMTP do cliente — SPF/DKIM
// intactos, qualquer provedor, sem config por org. Vale só para as contas
// conectadas: o transacional (Mailjet) já sai por HTTPS e o IMAP (993)
// não é bloqueado. O relay por org abaixo continua como fallback
// secundário.
// Esquemas: socks5:// / socks4:// via pacote `socks` (o nodemailer exige
// `transport.set("proxy_socks_module", socks)`); http:// / https:// via
// HTTP CONNECT nativo do nodemailer.

const SOCKS_PROTOCOLS = new Set(["socks:", "socks4:", "socks4a:", "socks5:"]);
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/** Nome montado em runtime — o bundler não consegue inlinear `undefined`. */
function proxyKey(): string {
  return ["SMTP", "PROXY", "URL"].join("_");
}

type SmtpProxy = { url: string; label: string; socks: boolean };

/** `label` sem credenciais, para log. `null` = env ausente ou inválida. */
export function parseSmtpProxyUrl(raw: string | undefined): SmtpProxy | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const isSocks = SOCKS_PROTOCOLS.has(parsed.protocol);
  if (!isSocks && !HTTP_PROTOCOLS.has(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  const port = parsed.port || (isSocks ? "1080" : parsed.protocol === "https:" ? "443" : "80");
  return { url: raw, label: `${parsed.protocol}//${parsed.hostname}:${port}`, socks: isSocks };
}

let proxyAnnounced: string | null = null;
let proxyRejected: string | null = null;

function getSmtpProxy(): SmtpProxy | null {
  const raw = runtimeEnv(proxyKey());
  if (!raw) return null;
  const proxy = parseSmtpProxyUrl(raw);
  if (!proxy) {
    // Nunca logar `raw`: carrega credenciais.
    if (proxyRejected !== raw) {
      proxyRejected = raw;
      log.error("SMTP_PROXY_URL inválida (use socks5://[user:pass@]host:porta ou http://…) — ignorando, SMTP sai direto");
    }
    return null;
  }
  if (proxyAnnounced !== proxy.label) {
    proxyAnnounced = proxy.label;
    log.info({ proxy: proxy.label }, `SMTP das contas conectadas sai via proxy ${proxy.socks ? "SOCKS" : "HTTP CONNECT"}`);
  }
  return proxy;
}

// ─── Relay / smarthost (fallback de saída) ───────────────────
// A resolução da config mora em `@/services/smtp-relay` (DB por org →
// env SMTP_RELAY_* legada → null). Aqui fica só a política de QUANDO
// usar: uma falha de CONEXÃO no SMTP direto da conta (via proxy, se
// SMTP_PROXY_URL estiver definida) cai para o relay.
// Erro de AUTH (535) NÃO cai no relay — senha errada é erro do usuário
// e o relay mascararia isso no teste de conexão. Sem relay configurado
// o comportamento é exatamente o de antes (opt-in — nunca cair
// automaticamente nas credenciais transacionais).

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
    raw.includes("epipe") ||
    // Proxy HTTP CONNECT respondeu 4xx/5xx (ConnectPort fechado, auth do
    // proxy errada) ou o SOCKS recusou/falhou (SocksClientError): o destino
    // nem foi alcançado — mesma classe de rede.
    raw.includes("response from proxy") ||
    raw.includes("socks")
  );
}

function createRelayTransport(relay: SmtpRelayConfig, tlsServername?: string) {
  return nodemailer.createTransport({
    host: relay.host,
    port: relay.port,
    // 465 é SEMPRE TLS implícito (mesma regra de implicitTlsForPort das
    // contas de e-mail) — mesmo que o toggle tenha vindo desmarcado.
    // Nas demais portas respeita o flag salvo (STARTTLS quando false).
    secure: relay.secure || relay.port === 465,
    ...(relay.user ? { auth: { user: relay.user, pass: relay.pass ?? "" } } : {}),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
    tls: {
      // Túnel TCP transparente (ex.: socat na 2525 → SMTP real na 465): o
      // certificado apresentado é o do DESTINO — o caller passa o servername
      // dele no retry de withRelay(). Smarthost normal usa relay.host.
      servername: tlsServername ?? relay.host,
      minVersion: "TLSv1.2",
    },
  });
}

/** Cert recebido não casa com o hostname do relay = túnel transparente? */
function isCertHostnameMismatch(err: unknown): boolean {
  const raw = `${flattenMailerError(err)} ${mailerMeta(err).code ?? ""}`.toLowerCase();
  return raw.includes("err_tls_cert_altname_invalid") || raw.includes("altnames");
}

/**
 * Roda `fn` (verify/sendMail) contra o relay. Se o relay apresentar o
 * certificado do SERVIDOR DE DESTINO (túnel TCP transparente — a sessão TLS
 * é fim-a-fim com o SMTP real e o relay só repassa bytes), o hostname do
 * relay não casa com o cert: refaz UMA vez com o servername do destino.
 * Smarthost real (cert do próprio relay, ex.: Mailjet) funciona na primeira
 * tentativa e nunca cai no retry. Verificar contra o destino NÃO afrouxa a
 * segurança: um cert válido pro destino só existe no destino real.
 */
async function withRelay<T>(
  relay: SmtpRelayConfig,
  destinationHost: string,
  fn: (transport: ReturnType<typeof nodemailer.createTransport>) => Promise<T>,
): Promise<T> {
  const first = createRelayTransport(relay);
  try {
    return await fn(first);
  } catch (err) {
    if (!isCertHostnameMismatch(err) || destinationHost.toLowerCase() === relay.host.toLowerCase()) {
      throw err;
    }
    log.warn(
      { relayHost: relay.host, relayPort: relay.port, destinationHost },
      "relay apresentou certificado do destino (túnel transparente) — retentando com servername do destino",
    );
    const second = createRelayTransport(relay, destinationHost);
    try {
      return await fn(second);
    } finally {
      second.close();
    }
  } finally {
    first.close();
  }
}

function createTransport(input: SmtpConnectInput) {
  const implicitTls = implicitTlsForPort(input.smtpPort, input.smtpEncryption);
  const uol = mailboxProviderKind(input.smtpHost) === "uol";
  const proxy = getSmtpProxy();
  // `proxy` é suportado em runtime pelo nodemailer (Mail.setupProxy →
  // http-proxy-client), mas não consta em SMTPTransport.Options do @types.
  const options: SMTPTransport.Options & { proxy?: string } = {
    host: input.smtpHost,
    port: input.smtpPort,
    secure: implicitTls,
    requireTLS: !implicitTls && input.smtpEncryption === "STARTTLS",
    auth: { user: input.email, pass: input.password },
    // PLAIN = senha com ! @ # em base64. LOGIN quoted falha em alguns Dovecot/UOL.
    ...(uol ? { authMethod: "PLAIN" } : {}),
    // Proxy até host:porta da conta; TLS e AUTH seguem fim-a-fim.
    ...(proxy ? { proxy: proxy.url } : {}),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
    tls: {
      servername: input.smtpHost,
      minVersion: "TLSv1.2",
    },
  };
  const transport = nodemailer.createTransport(options);
  // socks*:// — o nodemailer só traz o cliente HTTP CONNECT embutido; para
  // SOCKS ele pede o módulo `socks` registrado no transport.
  if (proxy?.socks) transport.set("proxy_socks_module", socks);
  return transport;
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
  if (lower.includes("response from proxy") || lower.includes("socks")) {
    return {
      ok: false,
      field: "smtp_host",
      message:
        "O proxy de saída SMTP (SMTP_PROXY_URL) falhou ao conectar no servidor. Confira usuário/senha do proxy e se ele libera a porta de destino.",
    };
  }
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
    const relay = await getSmtpRelayConfig();
    if (!relay || !isConnectionFailure(err)) {
      return mapSmtpError(err, input.smtpHost);
    }
    log.warn(
      {
        err: flattenMailerError(err),
        host: input.smtpHost,
        viaProxy: getSmtpProxy() !== null,
        relayHost: relay.host,
        relayPort: relay.port,
      },
      "SMTP direto inacessível — testando via relay",
    );
    try {
      await withRelay(relay, input.smtpHost, (t) => t.verify());
      return { ok: true };
    } catch (relayErr) {
      return mapSmtpError(relayErr, relay.host);
    }
  } finally {
    transport.close();
  }
}

export async function sendSmtpMail(
  input: SmtpConnectInput,
  mail: SmtpMailInput,
): Promise<{ ok: true; messageId: string } | EmailFieldError> {
  // From com nome, Content-Language e <html lang> — ver email-smtp-payload.ts.
  const payload = buildSmtpMailPayload({ email: input.email, fromName: input.fromName }, mail);
  const transport = createTransport(input);
  try {
    const info = await transport.sendMail(payload);
    return { ok: true, messageId: info.messageId || `smtp-${Date.now()}@${input.smtpHost}` };
  } catch (err) {
    const relay = await getSmtpRelayConfig();
    if (!relay || !isConnectionFailure(err)) {
      return mapSmtpError(err, input.smtpHost);
    }
    log.warn(
      {
        err: flattenMailerError(err),
        host: input.smtpHost,
        viaProxy: getSmtpProxy() !== null,
        relayHost: relay.host,
        relayPort: relay.port,
      },
      "SMTP direto inacessível — enviando via relay",
    );
    // From continua o e-mail da conta: o relay precisa aceitar esse remetente
    // (sender verificado / domínio autorizado no provedor do relay).
    try {
      const info = await withRelay(relay, input.smtpHost, (t) => t.sendMail(payload));
      return { ok: true, messageId: info.messageId || `relay-${Date.now()}@${relay.host}` };
    } catch (relayErr) {
      return mapSmtpError(relayErr, relay.host);
    }
  } finally {
    transport.close();
  }
}
