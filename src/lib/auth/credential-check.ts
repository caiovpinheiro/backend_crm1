/**
 * Senha + MFA de UMA conta já identificada — o mesmo critério do
 * `authorize()` de `auth.ts` (bcrypt; TOTP atual ou código de backup de uso
 * único), sem o resto do login (lockout, auditoria, org, sessão), que fica
 * com quem chama.
 *
 * Usado na primeira vinculação do "Trocar de organização"
 * (`/api/me/organizations/switch`): a pessoa já está logada na org de
 * origem e prova que também é titular da conta da org de destino.
 * O `authorize()` não foi alterado para usar este módulo de propósito
 * (menor impacto no login); se a regra de MFA mudar lá, mude aqui também.
 */
import { compare } from "bcryptjs";

import { prismaBase } from "@/lib/prisma-base";
import { decryptSecret } from "@/lib/crypto/secrets";
import { getLogger } from "@/lib/logger";

import { findMatchingBackupCode } from "./backup-codes";
import { verifyTotp } from "./totp";

const log = getLogger("auth");

/** Mesmo hash dummy do `authorize()`: tempo constante sem conta/senha. */
const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8n8m6q9Zp5hkoqC0k8Xj9v7oQZk3G";

export type CredentialCheckUser = {
  id: string;
  hashedPassword: string | null;
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
};

export type CredentialCheckResult = "ok" | "bad_password" | "mfa_required" | "bad_mfa";

export async function verifyPasswordAndMfa(
  user: CredentialCheckUser,
  input: { password: string; mfaCode?: string | null; backupCode?: string | null },
): Promise<CredentialCheckResult> {
  if (!user.hashedPassword) {
    await compare(input.password, DUMMY_HASH);
    return "bad_password";
  }
  if (!(await compare(input.password, user.hashedPassword))) return "bad_password";

  if (!user.mfaSecret || !user.mfaEnabledAt) return "ok";

  const totpCode = (input.mfaCode ?? "").trim();
  const backupCode = (input.backupCode ?? "").trim();
  if (!totpCode && !backupCode) return "mfa_required";

  if (totpCode) {
    try {
      if (verifyTotp(decryptSecret(user.mfaSecret), totpCode)) return "ok";
    } catch (err) {
      log.error({ err, userId: user.id }, "[auth] decrypt mfaSecret failed (org-switch)");
    }
  }

  if (backupCode) {
    const stored = await prismaBase.userMfaBackupCode.findMany({
      where: { userId: user.id, usedAt: null },
      select: { id: true, codeHash: true },
    });
    const idx = await findMatchingBackupCode(
      backupCode,
      stored.map((s) => s.codeHash),
    );
    if (idx >= 0) {
      // Uso único: só marca se ainda estava livre (corrida entre abas).
      const marked = await prismaBase.userMfaBackupCode.updateMany({
        where: { id: stored[idx].id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (marked.count === 1) return "ok";
    }
  }
  return "bad_mfa";
}
