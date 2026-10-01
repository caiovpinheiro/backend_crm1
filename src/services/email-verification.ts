import { clearLoginLockout } from "@/lib/auth/lockout";
import { generateNumericCode, hashSecret } from "@/lib/auth/token-hash";
import { sendVerifyEmail } from "@/lib/mail/send";
import { prismaBase } from "@/lib/prisma-base";
import { consumeRateLimit } from "@/lib/rate-limit";
import { buildTenantUrl } from "@/lib/tenant-url";

const TTL_MS = 30 * 60 * 1000;

export async function issueEmailVerification(input: {
  userId: string;
  email: string;
  organizationName?: string;
  /** Página onde digitar o código (o e-mail passa a trazer o link). */
  verifyUrl?: string;
}): Promise<{ sent: boolean }> {
  const { raw, hash } = generateNumericCode(6);
  const now = new Date();
  await prismaBase.emailVerificationToken.updateMany({
    where: { userId: input.userId, usedAt: null },
    data: { usedAt: now },
  });
  await prismaBase.emailVerificationToken.create({
    data: {
      userId: input.userId,
      codeHash: hash,
      expiresAt: new Date(now.getTime() + TTL_MS),
    },
  });
  const mail = await sendVerifyEmail({
    to: input.email,
    code: raw,
    organizationName: input.organizationName,
    verifyUrl: input.verifyUrl,
  });
  return { sent: mail.sent };
}

/**
 * Reenvio disparado pelo LOGIN: senha correta, e-mail não confirmado.
 *
 * O login responde a mesma falha genérica de senha errada (não revela que
 * a conta existe), então a tela não pode mais mandar a pessoa para a
 * verificação. Quem resolve é este e-mail: código novo + link da página
 * de confirmação. Roda em segundo plano (`runInBackground`), com teto por
 * usuário (`auth.verify-resend`, 3/h) — estourado, só não envia.
 */
export async function resendVerificationOnLogin(input: {
  userId: string;
}): Promise<{ sent: boolean }> {
  const decision = await consumeRateLimit(
    `user:${input.userId}:auth.verify-resend`,
    "auth.verify-resend",
  );
  if (!decision.allowed) return { sent: false };

  const user = await prismaBase.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      email: true,
      type: true,
      isErased: true,
      emailVerifiedAt: true,
      organization: { select: { name: true, slug: true } },
    },
  });
  if (!user || user.type !== "HUMAN" || user.isErased || user.emailVerifiedAt) {
    return { sent: false };
  }

  const slug = user.organization?.slug;
  return issueEmailVerification({
    userId: user.id,
    email: user.email,
    organizationName: user.organization?.name,
    verifyUrl: slug
      ? `${buildTenantUrl(slug)}/verify-email?email=${encodeURIComponent(user.email)}`
      : undefined,
  });
}

const GENERIC_OK = { ok: true as const };

export async function resendEmailVerification(input: {
  email: string;
  organizationSlug?: string | null;
}): Promise<{ ok: true }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) return GENERIC_OK;

  const user = await prismaBase.user.findFirst({
    where: {
      email,
      type: "HUMAN",
      isErased: false,
      emailVerifiedAt: null,
      ...(input.organizationSlug
        ? { organization: { slug: input.organizationSlug } }
        : {}),
    },
    select: {
      id: true,
      email: true,
      organization: { select: { name: true } },
    },
  });
  if (!user) return GENERIC_OK;

  await issueEmailVerification({
    userId: user.id,
    email: user.email,
    organizationName: user.organization?.name,
  });
  return GENERIC_OK;
}

export async function confirmEmailVerification(input: {
  email: string;
  code: string;
  organizationSlug?: string | null;
}): Promise<{ userId: string; email: string }> {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim().replace(/\s/g, "");
  if (!email.includes("@") || !/^\d{6}$/.test(code)) {
    throw new Error("Código inválido.");
  }

  const user = await prismaBase.user.findFirst({
    where: {
      email,
      type: "HUMAN",
      isErased: false,
      ...(input.organizationSlug
        ? { organization: { slug: input.organizationSlug } }
        : {}),
    },
    select: { id: true, email: true, emailVerifiedAt: true },
  });
  if (!user) throw new Error("Código inválido.");
  if (user.emailVerifiedAt) {
    return { userId: user.id, email: user.email };
  }

  const codeHash = hashSecret(code);
  const token = await prismaBase.emailVerificationToken.findFirst({
    where: {
      userId: user.id,
      codeHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!token) throw new Error("Código inválido ou expirado.");

  await prismaBase.$transaction(async (tx) => {
    await tx.emailVerificationToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
  });
  // Tentativas de login antes de confirmar contam como falha (resposta
  // genérica); confirmado o e-mail, o titular não pode ficar bloqueado.
  await clearLoginLockout(user.email);

  return { userId: user.id, email: user.email };
}
