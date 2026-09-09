import nodemailer from "nodemailer";
import type { EmailEncryption } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import type { EmailFieldError, EmailOk } from "@/services/email-imap";

const log = getLogger("email-smtp");

export type SmtpConnectInput = {
  email: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpEncryption: EmailEncryption;
};

const CONNECT_TIMEOUT_MS = 15_000;

function createTransport(input: SmtpConnectInput) {
  return nodemailer.createTransport({
    host: input.smtpHost,
    port: input.smtpPort,
    secure: input.smtpEncryption === "SSL_TLS",
    requireTLS: input.smtpEncryption === "STARTTLS",
    auth: { user: input.email, pass: input.password },
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

export function mapSmtpError(err: unknown): EmailFieldError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
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
  if (lower.includes("auth") || lower.includes("invalid login") || lower.includes("535") || lower.includes("534")) {
    return {
      ok: false,
      field: "password",
      message:
        "Falha na autenticação SMTP. Confira e-mail e senha. No Gmail/Outlook, use uma senha de app.",
    };
  }
  if (lower.includes("enotfound") || lower.includes("econnrefused") || lower.includes("eai_again")) {
    return { ok: false, field: "smtp_host", message: "Servidor SMTP inacessível. Confira o host e a porta." };
  }
  if (lower.includes("certificate") || lower.includes("ssl") || lower.includes("tls")) {
    return { ok: false, field: "smtp_encryption", message: "Falha de TLS no SMTP. Confira o método de criptografia." };
  }
  log.warn({ err: raw }, "erro SMTP");
  return { ok: false, field: "smtp_host", message: "Não foi possível conectar no SMTP." };
}

export async function testSmtpConnection(input: SmtpConnectInput): Promise<EmailOk | EmailFieldError> {
  const transport = createTransport(input);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return mapSmtpError(err);
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
    return mapSmtpError(err);
  } finally {
    transport.close();
  }
}
