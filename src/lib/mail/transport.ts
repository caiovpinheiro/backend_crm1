import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import { getLogger } from "@/lib/logger";
import { runtimeEnv } from "@/lib/runtime-env";

const log = getLogger("mail");

const DEFAULT_FROM_EMAIL = "no-reply@bwipo.com";
const DEFAULT_FROM_NAME = "Bwipo";

/** Nomes montados em runtime — o bundler não consegue inlinear `undefined`. */
function smtpKey(part: "HOST" | "PORT" | "USER" | "PASS" | "FROM" | "FROM_EMAIL" | "FROM_NAME"): string {
  return ["SMTP", part].join("_");
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super("SMTP não configurado.");
    this.name = "MailNotConfiguredError";
  }
}

let cached: Transporter | undefined;

function intPort(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveFromAddress(): { address: string; name: string } {
  const namedEmail = runtimeEnv(smtpKey("FROM_EMAIL"));
  const namedName = runtimeEnv(smtpKey("FROM_NAME"));
  const combined = runtimeEnv(smtpKey("FROM"));
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
  if (cached) return cached;
  const host = runtimeEnv(smtpKey("HOST"));
  if (!host) {
    log.warn(
      {
        smtpHost: false,
        smtpUser: Boolean(runtimeEnv(smtpKey("USER"))),
        smtpFromEmail: Boolean(runtimeEnv(smtpKey("FROM_EMAIL"))),
      },
      "SMTP_HOST ausente — e-mail transacional não enviado",
    );
    return null;
  }
  const port = intPort(runtimeEnv(smtpKey("PORT")), 587);
  const user = runtimeEnv(smtpKey("USER"));
  const pass = runtimeEnv(smtpKey("PASS"));
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
