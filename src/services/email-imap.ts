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
  return new ImapFlow({
    host: input.imapHost,
    port: input.imapPort,
    secure: input.imapEncryption === "SSL_TLS",
    auth: { user: input.email, pass: input.password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
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

export function mapImapError(err: unknown): EmailFieldError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("timeout") || raw.endsWith("_TIMEOUT")) {
    return { ok: false, field: "imap_host", message: "Tempo esgotado ao conectar no IMAP. Verifique servidor e porta." };
  }
  if (looksLikeAppPasswordRequired(lower)) {
    return {
      ok: false,
      field: "password",
      message:
        "O provedor recusou a senha. Gmail e Outlook exigem senha de app — não use a senha da conta.",
    };
  }
  if (lower.includes("auth") || lower.includes("login") || lower.includes("invalid credentials") || lower.includes("authentication")) {
    return {
      ok: false,
      field: "password",
      message:
        "Falha na autenticação IMAP. Confira e-mail e senha. No Gmail/Outlook, use uma senha de app.",
    };
  }
  if (lower.includes("enotfound") || lower.includes("econnrefused") || lower.includes("eai_again")) {
    return { ok: false, field: "imap_host", message: "Servidor IMAP inacessível. Confira o host e a porta." };
  }
  if (lower.includes("certificate") || lower.includes("ssl") || lower.includes("tls")) {
    return { ok: false, field: "imap_encryption", message: "Falha de TLS no IMAP. Confira o método de criptografia." };
  }
  log.warn({ err: raw }, "erro IMAP");
  return { ok: false, field: "imap_host", message: "Não foi possível conectar no IMAP." };
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
    return mapImapError(err);
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
    return mapImapError(err);
  }
}
