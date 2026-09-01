import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import { getLogger } from "@/lib/logger";
import { secrets } from "@/lib/secrets";

const log = getLogger("mail");

const DEFAULT_FROM_EMAIL = "no-reply@bwipo.com";
const DEFAULT_FROM_NAME = "Bwipo";

export class MailNotConfiguredError extends Error {
  constructor() {
    super("SMTP não configurado.");
    this.name = "MailNotConfiguredError";
  }
}

let cached: Transporter | null | undefined;

function intPort(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveFromAddress(): { address: string; name: string } {
  const namedEmail = secrets.optional("SMTP_FROM_EMAIL")?.trim();
  const namedName = secrets.optional("SMTP_FROM_NAME")?.trim();
  const combined = secrets.optional("SMTP_FROM")?.trim();
  if (namedEmail) {
    return { address: namedEmail, name: namedName || DEFAULT_FROM_NAME };
  }
  if (combined) {
    const m = combined.match(/^(.*)<([^>]+)>$/);
    if (m) {
      return {
        name: m[1].trim().replace(/^"|"$/g, "") || DEFAULT_FROM_NAME,
        address: m[2].trim(),
      };
    }
    return { address: combined, name: namedName || DEFAULT_FROM_NAME };
  }
  return { address: DEFAULT_FROM_EMAIL, name: namedName || DEFAULT_FROM_NAME };
}

export function getMailTransporter(): Transporter | null {
  if (cached !== undefined) return cached;
  const host = secrets.optional("SMTP_HOST")?.trim();
  if (!host) {
    cached = null;
    return null;
  }
  const port = intPort(secrets.optional("SMTP_PORT"), 587);
  const user = secrets.optional("SMTP_USER")?.trim();
  const pass = secrets.optional("SMTP_PASS");
  cached = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: user ? { user, pass: pass ?? "" } : undefined,
  });
  return cached;
}

export async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const transport = getMailTransporter();
  if (!transport) throw new MailNotConfiguredError();
  const from = resolveFromAddress();
  try {
    await transport.sendMail({
      from: `${from.name} <${from.address}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
  } catch (err) {
    log.error({ err }, "Falha ao enviar e-mail transacional");
    throw err;
  }
}
