import { CredentialsSignin } from "@auth/core/errors";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";

import authConfig from "./auth.config";
// Usa o client base (sem extension de org-scope) porque NextAuth callbacks
// rodam ANTES do RequestContext ser criado e precisam consultar User +
// Organization (models nao-scoped por definicao).
import { prismaBase as prisma } from "./prisma-base";
import { enterRequestContext } from "./request-context";
import type { AppUserRole } from "./auth-types";
import {
  checkLockout,
  recordLoginAttempt,
  clearFailuresOnSuccess,
} from "./auth/lockout";
import { decryptSecret } from "./crypto/secrets";
import { verifyTotp } from "./auth/totp";
import { findMatchingBackupCode } from "./auth/backup-codes";

/** Código em `signIn(..., { redirect: false })` → `result.code` quando o Prisma falha (ex.: BD parada). */
class DatabaseUnavailable extends CredentialsSignin {
  code = "database_unavailable";
}

/** Conta bloqueada por excesso de falhas. UI mostra retryAfter pra orientar. */
class AccountLocked extends CredentialsSignin {
  code = "account_locked";
}

/** MFA habilitada e codigo TOTP/backup necessario (ou invalido). */
class MfaRequired extends CredentialsSignin {
  code = "mfa_required";
}

class MfaInvalid extends CredentialsSignin {
  code = "mfa_invalid";
}

const nextAuth = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Senha", type: "password" },
        organizationSlug: { label: "Org", type: "text" },
        // MFA: o cliente pode enviar `mfaCode` (TOTP de 6 digitos) ou
        // `backupCode` (16 chars com hifens). Se a conta tem MFA
        // habilitado e nada disso veio, throw MfaRequired pra UI
        // mostrar a tela de codigo. UX-wise: front pode tentar login
        // sem MFA, capturar o erro `mfa_required` e re-submeter com
        // `mfaCode` na mesma form.
        mfaCode: { label: "Codigo MFA", type: "text" },
        backupCode: { label: "Codigo de backup", type: "text" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = String(credentials.email).trim().toLowerCase();

        // PR 4.1: Lockout-first — checa antes de qualquer hash de
        // senha pra economizar CPU em ataque distribuido.
        const lock = await checkLockout(email);
        if (lock.locked) {
          await recordLoginAttempt({ email, outcome: "locked" });
          throw new AccountLocked();
        }

        const organizationSlugHint = String(
          credentials.organizationSlug ?? "",
        )
          .trim()
          .toLowerCase();

        let user;
        try {
          const candidates = await prisma.user.findMany({
            where: { email, type: { not: "AI" }, isErased: false },
            select: {
              id: true,
              name: true,
              email: true,
              type: true,
              role: true,
              hashedPassword: true,
              avatarUrl: true,
              organizationId: true,
              isSuperAdmin: true,
              mfaSecret: true,
              mfaEnabledAt: true,
              organization: { select: { slug: true } },
            },
          });
          if (organizationSlugHint) {
            user =
              candidates.find((u) => u.organization?.slug === organizationSlugHint) ??
              null;
          } else if (candidates.length === 1) {
            user = candidates[0];
          } else {
            user =
              candidates.find((u) => u.isSuperAdmin && !u.organizationId) ?? null;
          }
        } catch (err) {
          console.error("[auth] authorize: database error", err);
          await recordLoginAttempt({ email, outcome: "db_error" });
          throw new DatabaseUnavailable();
        }

        // Hash fixo pré-computado (custo bcrypt igual ao real, cost=10).
        // Usado quando o usuário não existe / é AI / não tem senha,
        // pra manter o tempo de resposta constante e evitar enumeração
        // por timing attack. O hash é de uma senha aleatória descartada.
        const DUMMY_HASH =
          "$2a$10$CwTycUXWue0Thq9StjUM0uJ8n8m6q9Zp5hkoqC0k8Xj9v7oQZk3G";

        if (!user) {
          // Executa compare dummy pra igualar timing com fluxo real.
          await compare(credentials.password as string, DUMMY_HASH);
          await recordLoginAttempt({ email, outcome: "no_user" });
          return null;
        }

        if (user.type === "AI" || !user.hashedPassword) {
          await compare(credentials.password as string, DUMMY_HASH);
          await recordLoginAttempt({
            email,
            userId: user.id,
            outcome: "no_user",
          });
          return null;
        }

        const isValid = await compare(
          credentials.password as string,
          user.hashedPassword
        );

        if (!isValid) {
          await recordLoginAttempt({
            email,
            userId: user.id,
            outcome: "bad_password",
          });
          return null;
        }

        // PR 4.1: MFA enforcement. Se o user habilitou MFA, exige
        // segundo fator. Aceita TOTP atual (preferencial) ou um
        // codigo de backup (single-use).
        if (user.mfaSecret && user.mfaEnabledAt) {
          const totpCode =
            typeof credentials.mfaCode === "string"
              ? credentials.mfaCode.trim()
              : "";
          const backupCode =
            typeof credentials.backupCode === "string"
              ? credentials.backupCode.trim()
              : "";

          if (!totpCode && !backupCode) {
            await recordLoginAttempt({
              email,
              userId: user.id,
              outcome: "mfa_required",
            });
            throw new MfaRequired();
          }

          let mfaOk = false;
          if (totpCode) {
            try {
              const decrypted = decryptSecret(user.mfaSecret);
              mfaOk = verifyTotp(decrypted, totpCode);
            } catch (err) {
              console.error("[auth] decrypt mfaSecret failed", err);
              mfaOk = false;
            }
          }

          if (!mfaOk && backupCode) {
            const stored = await prisma.userMfaBackupCode.findMany({
              where: { userId: user.id, usedAt: null },
              select: { id: true, codeHash: true },
            });
            const matchIdx = await findMatchingBackupCode(
              backupCode,
              stored.map((s) => s.codeHash),
            );
            if (matchIdx >= 0) {
              await prisma.userMfaBackupCode.update({
                where: { id: stored[matchIdx].id },
                data: { usedAt: new Date() },
              });
              mfaOk = true;
            }
          }

          if (!mfaOk) {
            await recordLoginAttempt({
              email,
              userId: user.id,
              outcome: "bad_mfa",
            });
            throw new MfaInvalid();
          }
        }

        // Bloqueio 1: usuario sem organizacao nao-super-admin. No
        // modelo multi-tenant isso eh estado invalido (todo user novo
        // entra via /signup ou /accept-invite e sai vinculado a uma
        // org). Users orfaos s\u00f3 existem por bug ou legado pre-migracao.
        // Sem essa checagem, cairia no /api/.../findMany com ctx
        // organizationId=null e o Prisma scope mostra uma mensagem
        // tecnica vazando pro cliente.
        if (!user.organizationId && !user.isSuperAdmin) {
          console.warn(
            `[auth] login barrado: user ${user.email} sem organizationId`,
          );
          await recordLoginAttempt({
            email,
            userId: user.id,
            outcome: "no_user",
          });
          return null;
        }

        // Bloqueio 2: organizacao suspensa/arquivada. Super-admins da
        // EduIT (organizationId=null) nao sao afetados.
        let organizationSlug: string | null = null;
        if (user.organizationId) {
          const org = await prisma.organization.findUnique({
            where: { id: user.organizationId },
            select: { status: true, slug: true },
          });
          if (org && org.status !== "ACTIVE") {
            await recordLoginAttempt({
              email,
              userId: user.id,
              outcome: "locked",
            });
            return null;
          }
          organizationSlug = org?.slug ?? null;
        }

        await recordLoginAttempt({
          email,
          userId: user.id,
          outcome: "success",
        });
        await clearFailuresOnSuccess(email);

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          organizationId: user.organizationId,
          organizationSlug,
          isSuperAdmin: user.isSuperAdmin,
          // NextAuth lê `image` como o avatar do usuário (mapeia pra
          // `session.user.image`). Espelhamos `User.avatarUrl` aqui pra
          // que a foto cadastrada em `/settings/profile` apareça em
          // qualquer componente que use `useSession()` — o avatar do
          // agente vira herança automática em todo o app (chat,
          // kanban, sales hub, etc.).
          image: user.avatarUrl ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: AppUserRole | null }).role ?? undefined;
        token.organizationId = (user as { organizationId?: string | null }).organizationId ?? null;
        token.organizationSlug =
          (user as { organizationSlug?: string | null }).organizationSlug ?? null;
        token.isSuperAdmin = Boolean((user as { isSuperAdmin?: boolean }).isSuperAdmin);
        token.picture = (user as { image?: string | null }).image ?? null;
      } else if (token.id) {
        try {
          // Refresh role + avatarUrl + organizationId/slug do banco a cada
          // renovação do JWT — garante que se:
          //   a) o agente atualizar a foto em /settings/profile, OU
          //   b) o super-admin mover o user para outra org, OU
          //   c) o super-admin suspender o user / remover super-admin,
          // a session reflita no próximo tick sem exigir re-login. Se
          // a org ficou SUSPENDED, invalidamos o token forcando logout.
          const dbUser = await prisma.user.findUnique({
            where: { id: token.id as string },
            select: {
              role: true,
              avatarUrl: true,
              organizationId: true,
              isSuperAdmin: true,
              isErased: true,
              organization: { select: { status: true, slug: true } },
            },
          });
          if (dbUser) {
            if (
              dbUser.isErased ||
              (dbUser.organization &&
                dbUser.organization.status !== "ACTIVE" &&
                !dbUser.isSuperAdmin)
            ) {
              // Forca logout no proximo getServerSession. Deixamos o
              // token vazio — middleware redireciona pra /login.
              return {};
            }
            token.role = dbUser.role;
            token.organizationId = dbUser.organizationId;
            token.organizationSlug = dbUser.organization?.slug ?? null;
            token.isSuperAdmin = dbUser.isSuperAdmin;
            token.picture = dbUser.avatarUrl ?? null;
          }
        } catch (err) {
          console.error("[auth] jwt role refresh failed", err);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as { role?: unknown }).role = token.role;
        (session.user as { organizationId?: string | null }).organizationId =
          (token.organizationId as string | null | undefined) ?? null;
        (session.user as { organizationSlug?: string | null }).organizationSlug =
          (token.organizationSlug as string | null | undefined) ?? null;
        (session.user as { isSuperAdmin?: boolean }).isSuperAdmin =
          Boolean(token.isSuperAdmin);
        // NextAuth NÃO copia automaticamente `token.picture` pra
        // `session.user.image` (apesar de o tipo permitir) — fazemos
        // explicitamente. Sem isso, qualquer componente que tente ler
        // `session.user.image` recebe `undefined` mesmo com a foto
        // já no banco.
        session.user.image = (token.picture as string | null | undefined) ?? null;
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      const fn = authConfig.callbacks?.redirect;
      if (typeof fn === "function") {
        return fn({ url, baseUrl });
      }
      return baseUrl;
    },
  },
});

export const { handlers, signIn, signOut } = nextAuth;

/**
 * Wrapper de `auth()` que ativa o RequestContext na continuation do
 * CALLER. Nao podemos ativar no `session` callback porque `enterWith`
 * vale so pra async resource atual — quando o callback retorna, o
 * caller (handler) ja voltou a rodar em outro async context.
 *
 * Aqui, como este `auth()` eh executado na mesma continuation do
 * handler, o `enterRequestContext` propaga pra todo `await prisma.*`
 * subsequente. Idempotente por design (nao sobrescreve worker ctx).
 */
export const auth: typeof nextAuth.auth = (async (
  ...args: Parameters<typeof nextAuth.auth>
) => {
  const session = await (nextAuth.auth as (...a: unknown[]) => Promise<unknown>)(
    ...args,
  );
  const user = (session as { user?: Record<string, unknown> } | null)?.user;
  if (user && typeof user.id === "string") {
    enterRequestContext({
      organizationId:
        (user.organizationId as string | null | undefined) ?? null,
      userId: user.id,
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });
  }
  return session;
}) as typeof nextAuth.auth;
