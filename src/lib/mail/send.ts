import { getLogger } from "@/lib/logger";
import { MailNotConfiguredError, sendMail } from "@/lib/mail/transport";
import {
  inviteEmail,
  passwordResetEmail,
  verifyEmailTemplate,
  welcomeEmail,
} from "@/lib/mail/templates";

const log = getLogger("mail");

export type MailSendResult = { sent: true } | { sent: false; reason: "not_configured" | "failed" };

async function trySend(
  to: string,
  tpl: { subject: string; text: string; html: string },
): Promise<MailSendResult> {
  try {
    await sendMail({ to, ...tpl });
    return { sent: true };
  } catch (err) {
    if (err instanceof MailNotConfiguredError) {
      log.warn("SMTP_HOST ausente — e-mail transacional não enviado");
      return { sent: false, reason: "not_configured" };
    }
    log.error({ err }, "Envio de e-mail transacional falhou");
    return { sent: false, reason: "failed" };
  }
}

export function sendInviteEmail(input: {
  to: string;
  organizationName: string;
  inviteUrl: string;
  roleLabel: string;
}): Promise<MailSendResult> {
  return trySend(input.to, inviteEmail(input));
}

export function sendPasswordResetEmail(input: {
  to: string;
  resetUrl: string;
}): Promise<MailSendResult> {
  return trySend(input.to, passwordResetEmail(input));
}

export function sendWelcomeEmail(input: {
  to: string;
  organizationName: string;
  loginUrl: string;
  name: string;
}): Promise<MailSendResult> {
  return trySend(input.to, welcomeEmail(input));
}

export function sendVerifyEmail(input: {
  to: string;
  code: string;
  organizationName?: string;
}): Promise<MailSendResult> {
  return trySend(input.to, verifyEmailTemplate(input));
}
