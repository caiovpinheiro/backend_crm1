import { hash } from "bcryptjs";

import { clearLoginLockout } from "@/lib/auth/lockout";
import { generateUrlToken, hashSecret } from "@/lib/auth/token-hash";
import { sendPasswordResetEmail } from "@/lib/mail/send";
import { prismaBase } from "@/lib/prisma-base";
import { buildTenantUrl } from "@/lib/tenant-url";

const TTL_MS = 30 * 60 * 1000;
const GENERIC_OK = { ok: true as const };

/**
 * Sempre a mesma resposta (não enumerar e-mail). Invalida tokens
 * anteriores não usados do mesmo user e emite um novo (30 min, hash).
 */
export async function requestPasswordReset(input: {
  email: string;
  organizationSlug?: string | null;
}): Promise<{ ok: true }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@") || email.length > 320) return GENERIC_OK;

  const users = await prismaBase.user.findMany({
    where: {
      email,
      type: "HUMAN",
      isErased: false,
      hashedPassword: { not: null },
      ...(input.organizationSlug
        ? { organization: { slug: input.organizationSlug } }
        : {}),
    },
    select: {
      id: true,
      email: true,
      organization: { select: { slug: true, status: true } },
    },
    take: 8,
  });

  const eligible = users.filter(
    (u) => !u.organization || u.organization.status === "ACTIVE",
  );
  if (eligible.length !== 1) return GENERIC_OK;

  const user = eligible[0];
  const orgSlug = user.organization?.slug ?? input.organizationSlug ?? null;
  if (!orgSlug && user.organization) return GENERIC_OK;

  const { raw, hash: tokenHash } = generateUrlToken();
  const now = new Date();
  await prismaBase.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: now },
  });
  await prismaBase.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(now.getTime() + TTL_MS),
    },
  });

  const base = orgSlug
    ? buildTenantUrl(orgSlug)
    : (process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
  if (!base) return GENERIC_OK;

  await sendPasswordResetEmail({
    to: user.email,
    resetUrl: `${base}/reset-password?token=${encodeURIComponent(raw)}`,
  });
  return GENERIC_OK;
}

export async function consumePasswordReset(input: {
  token: string;
  password: string;
}): Promise<void> {
  const raw = input.token.trim();
  const password = input.password;
  if (!raw) throw new Error("Token inválido.");
  if (password.length < 8) {
    throw new Error("A senha precisa ter pelo menos 8 caracteres.");
  }

  const tokenHash = hashSecret(raw);
  const row = await prismaBase.passwordResetToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      usedAt: true,
      user: { select: { email: true, emailVerifiedAt: true } },
    },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    throw new Error("Link inválido ou expirado.");
  }

  const hashedPassword = await hash(password, 12);
  await prismaBase.$transaction(async (tx) => {
    await tx.passwordResetToken.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    });
    await tx.user.update({
      where: { id: row.userId },
      data: {
        hashedPassword,
        ...(row.user.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
      },
    });
  });
  await clearLoginLockout(row.user.email);
}
