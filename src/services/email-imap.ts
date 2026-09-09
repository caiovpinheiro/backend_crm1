import { ImapFlow } from "imapflow";
import type { EmailEncryption } from "@prisma/client";

import { getLogger } from "@/lib/logger";

const log = getLogger("email-imap");

export type EmailFieldError = { ok: false; field: string; message: string };
export type EmailOk = { ok: true };

export type ImapConnectInput = {
  email: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapEncryption: EmailEncryption;
};

export type FetchedImapMessage = {
  uid: string;
  messageId: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date | null;
  isRead: boolean;
};

const CONNECT_TIMEOUT_MS = 15_000;

type MailerErrShape = {
  message?: string;
  code?: string;
  command?: string;
  response?: unknown;
  responseText?: string;
  serverResponseCode?: string;
  authenticationFailed?: boolean;
  tlsFailed?: boolean;
  cause?: unknown;
};

export function flattenMailerError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4 && !seen.has(cur); depth++) {
    seen.add(cur);
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    if (typeof cur !== "object") {
      parts.push(String(cur));
      break;
    }
    const o = cur as MailerErrShape;
    if (o.message) parts.push(o.message);
    if (o.code) parts.push(String(o.code));
    if (o.serverResponseCode) parts.push(String(o.serverResponseCode));
    if (o.responseText) parts.push(o.responseText);
    if (typeof o.response === "string") parts.push(o.response);
    if (o.authenticationFailed) parts.push("AUTHENTICATIONFAILED");
    if (o.tlsFailed) parts.push("tlsFailed");
    cur = o.cause;
  }
  return parts.filter(Boolean).join(" | ") || String(err);
}

export function mailboxProviderKind(host: string): "gmail-outlook" | "uol" | "other" {
  const h = host.toLowerCase();
  if (h.includes("uhserver") || h.includes("uolhost") || h.endsWith(".uol.com.br")) return "uol";
  if (
    h.includes("gmail") ||
    h.includes("google") ||
    h.includes("outlook") ||
    h.includes("office365") ||
    h.includes("hotmail") ||
    h.includes("live.com")
  ) {
    return "gmail-outlook";
  }
  return "other";
}

export function implicitTlsForPort(port: number, encryption: EmailEncryption): boolean {
  if (port === 993 || port === 465) return true;
  return encryption === "SSL_TLS";
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

function createClient(input: ImapConnectInput) {
  const implicitTls = implicitTlsForPort(input.imapPort, input.imapEncryption);
  return new ImapFlow({
    host: input.imapHost,
    port: input.imapPort,
    secure: implicitTls,
    ...(implicitTls
      ? {}
      : { doSTARTTLS: input.imapEncryption === "STARTTLS" }),
    servername: input.imapHost,
    // LOGIN = senha normal (Thunderbird). Sem SPA/NTLM/XOAUTH2.
    auth: { user: input.email, pass: input.password, loginMethod: "LOGIN" },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
    tls: {
      servername: input.imapHost,
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

function looksLikeImapDisabled(lower: string): boolean {
  return (
    (lower.includes("imap") && (lower.includes("disabled") || lower.includes("desativ") || lower.includes("not enabled"))) ||
    lower.includes("protocol not available") ||
    lower.includes("login disabled")
  );
}

function looksLikeAuthFailure(lower: string): boolean {
  return (
    lower.includes("authenticationfailed") ||
    lower.includes("authentication failed") ||
    lower.includes("authfail") ||
    lower.includes("invalid credentials") ||
    lower.includes("invalid login") ||
    lower.includes("login failed") ||
    lower.includes("authenticate failed") ||
    lower.includes("[auth") ||
    /\b535\b/.test(lower) ||
    /\b534\b/.test(lower)
  );
}

export function mailAuthMessage(kind: ReturnType<typeof mailboxProviderKind>, proto: "IMAP" | "SMTP"): string {
  if (kind === "uol") {
    return `Falha na autenticação ${proto}. Use o e-mail completo e a senha da caixa. No UOL Host, ative o IMAP em Webmail → Configurar IMAP/POP.`;
  }
  if (kind === "gmail-outlook") {
    return `Falha na autenticação ${proto}. Confira e-mail e senha. No Gmail/Outlook, use uma senha de app.`;
  }
  return `Falha na autenticação ${proto}. Confira o e-mail completo e a senha da caixa.`;
}

export function mapImapError(err: unknown, host = ""): EmailFieldError {
  const raw = flattenMailerError(err);
  const lower = raw.toLowerCase();
  const kind = mailboxProviderKind(host);
  if (lower.includes("timeout") || raw.includes("_TIMEOUT")) {
    return { ok: false, field: "imap_host", message: "Tempo esgotado ao conectar no IMAP. Verifique servidor, porta e se o IMAP está liberado." };
  }
  if (looksLikeImapDisabled(lower)) {
    return {
      ok: false,
      field: "password",
      message:
        kind === "uol"
          ? "IMAP desativado nesta caixa. No UOL Host, abra a caixa em Webmail → Configurar IMAP/POP e ative o IMAP."
          : "O provedor recusou IMAP nesta caixa. Ative o acesso IMAP nas configurações da conta.",
    };
  }
  if (looksLikeAppPasswordRequired(lower)) {
    return {
      ok: false,
      field: "password",
      message:
        "O provedor recusou a senha. Gmail e Outlook exigem senha de app — não use a senha da conta.",
    };
  }
  if (looksLikeAuthFailure(lower)) {
    return { ok: false, field: "password", message: mailAuthMessage(kind, "IMAP") };
  }
  if (lower.includes("enotfound") || lower.includes("econnrefused") || lower.includes("eai_again")) {
    return { ok: false, field: "imap_host", message: "Servidor IMAP inacessível. Confira o host e a porta." };
  }
  if (lower.includes("econnreset") || lower.includes("ehostunreach") || lower.includes("enetunreach") || lower.includes("epipe")) {
    return { ok: false, field: "imap_host", message: "A conexão IMAP foi recusada ou interrompida. Confira host, porta 993 e firewall de saída." };
  }
  if (lower.includes("certificate") || lower.includes("cert_") || lower.includes("ssl") || lower.includes("tls") || lower.includes("tlsfailed")) {
    return { ok: false, field: "imap_encryption", message: "Falha de TLS no IMAP. Na porta 993 use SSL/TLS (implícito), não STARTTLS." };
  }
  log.warn({ err: raw, host }, "erro IMAP");
  return {
    ok: false,
    field: "imap_host",
    message: raw && raw !== "[object Object]"
      ? `Não foi possível conectar no IMAP (${raw.slice(0, 180)}).`
      : "Não foi possível conectar no IMAP.",
  };
}

export async function testImapConnection(input: ImapConnectInput): Promise<EmailOk | EmailFieldError> {
  const client = createClient(input);
  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "IMAP");
    await client.logout();
    return { ok: true };
  } catch (err) {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    return mapImapError(err, input.imapHost);
  }
}

function addrOf(
  list: Array<{ address?: string; name?: string }> | undefined,
): { address: string; name: string | null } {
  const first = list?.[0];
  return {
    address: (first?.address ?? "").trim().toLowerCase(),
    name: first?.name?.trim() || null,
  };
}

function extractBodies(source: string): { bodyText: string | null; bodyHtml: string | null } {
  const html = source.match(/<html[\s\S]*<\/html>/i)?.[0] ?? null;
  let text: string | null = null;
  const plainPart = source.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\nContent-Type:|$)/i);
  if (plainPart?.[1]) {
    text = plainPart[1].replace(/\r\n/g, "\n").trim().slice(0, 20_000);
  } else if (!html) {
    const stripped = source.replace(/^[\s\S]*?\r?\n\r?\n/, "").replace(/<[^>]+>/g, " ").trim();
    text = stripped.slice(0, 8_000) || null;
  }
  return { bodyText: text, bodyHtml: html ? html.slice(0, 80_000) : null };
}

export async function fetchRecentInbox(
  input: ImapConnectInput,
  limit = 80,
): Promise<{ ok: true; messages: FetchedImapMessage[] } | EmailFieldError> {
  const client = createClient(input);
  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "IMAP");
    const lock = await client.getMailboxLock("INBOX");
    const messages: FetchedImapMessage[] = [];
    try {
      const mailbox = client.mailbox;
      const exists = typeof mailbox === "object" && mailbox ? mailbox.exists : 0;
      if (exists > 0) {
        const from = Math.max(1, exists - limit + 1);
        for await (const msg of client.fetch(`${from}:${exists}`, {
          envelope: true,
          source: true,
          uid: true,
          flags: true,
        })) {
          const env = msg.envelope;
          const fromA = addrOf(env?.from);
          const toA = addrOf(env?.to);
          const source = msg.source ? msg.source.toString("utf8") : "";
          const bodies = extractBodies(source);
          const messageId =
            env?.messageId?.replace(/^<|>$/g, "").trim() ||
            `uid-${msg.uid}@${input.imapHost}`;
          messages.push({
            uid: String(msg.uid),
            messageId,
            fromAddress: fromA.address || input.email,
            fromName: fromA.name,
            toAddress: toA.address || input.email,
            subject: env?.subject ?? null,
            bodyText: bodies.bodyText,
            bodyHtml: bodies.bodyHtml,
            receivedAt: env?.date ? new Date(env.date) : null,
            isRead: Boolean(msg.flags?.has("\\Seen")),
          });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { ok: true, messages };
  } catch (err) {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    return mapImapError(err, input.imapHost);
  }
}
