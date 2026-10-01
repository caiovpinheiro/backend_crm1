import "next-auth";
import "next-auth/jwt";

/** Alinhado ao enum `UserRole` do Prisma (evita depender da geração do client no typecheck). */
export type AppUserRole = "ADMIN" | "MANAGER" | "MEMBER";

declare module "next-auth" {
  interface User {
    role?: AppUserRole;
    /// Id da organizacao a que o user pertence. Null somente para super-admin EduIT.
    organizationId?: string | null;
    /// Slug da org (subdomain). Null somente para super-admin sem org.
    organizationSlug?: string | null;
    /// Flag que libera acesso ao painel /admin e bypassa a RLS por organizacao.
    isSuperAdmin?: boolean;
    /// SV-1: `users.sessionVersion` no momento do login (vai para o JWT).
    sessionVersion?: number;
  }
  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      role: AppUserRole;
      /// Id da organizacao resolvida no login. Null so se isSuperAdmin=true.
      /// Helper requireAuth() valida essa precondicao e responde 401 se
      /// encontrar user comum sem organizationId.
      organizationId: string | null;
      /// Slug da org — usado pelo middleware FE para casar Host vs sessão.
      organizationSlug: string | null;
      /// Verdadeiro para operadores da EduIT. Usado no middleware e
      /// em requireSuperAdmin() para gatear /admin/organizations.
      isSuperAdmin: boolean;
      // Espelha `User.avatarUrl` via callback `session` em `src/lib/auth.ts`.
      // É opcional porque usuários sem foto ficam com `null`, e nullable
      // porque pode voltar vazio do banco.
      image?: string | null;
      /// SV-1: claim do token. `requireAuth` compara com o banco (cache 60 s)
      /// e responde 401 quando a sessão foi revogada. Ausente = 0.
      sessionVersion?: number;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: AppUserRole;
    organizationId?: string | null;
    organizationSlug?: string | null;
    isSuperAdmin?: boolean;
    /// SV-1: versão da sessão no login. Nunca é atualizada no refresh —
    /// a comparação com o banco é o que invalida o token.
    sessionVersion?: number;
  }
}

