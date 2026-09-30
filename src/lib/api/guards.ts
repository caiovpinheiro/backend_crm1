import { NextResponse } from "next/server";

import type { AppSession } from "@/lib/auth-helpers";
import type { PermissionKey } from "@/lib/authz";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";

/**
 * Guards compartilhados pelas rotas de `team-chat/**` e `demands/**`.
 *
 * Antes cada módulo tinha o seu `_guard.ts` (idênticos, salvo `viewerOf`)
 * tipado com `Session` de `next-auth`, que não é o `AppSession` devolvido
 * por `withOrgContext`/`requireAuth` — cada chamada gerava um erro de
 * tipo. Os `_guard.ts` antigos continuam existindo só como re-export.
 */

/** Identidade mínima de quem está agindo dentro de uma organização. */
export type OrgViewer = {
  userId: string;
  organizationId: string;
};

/** `AppSession` com organização ativa garantida (após `denyUnless`). */
export type OrgSession = AppSession & {
  user: AppSession["user"] & { organizationId: string };
};

export function jsonError(message: string, status: number) {
  return NextResponse.json({ message }, { status });
}

/**
 * Responde 403 quando a sessão não tem a permissão `key`, ou quando não há
 * organização ativa. `requireAuth` só deixa passar sessão sem
 * `organizationId` para super-admin; team-chat e demandas são recursos
 * escopados por organização, então esse caso é negado aqui em vez de
 * chegar aos serviços com `organizationId` nulo.
 */
export async function denyUnless(
  session: AppSession,
  key: PermissionKey,
): Promise<NextResponse | null> {
  if (!hasActiveOrg(session)) {
    return jsonError("Selecione uma organização.", 403);
  }
  return requirePermissionForUser(
    {
      id: session.user.id,
      role: session.user.role,
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    },
    key,
  );
}

export function hasActiveOrg(session: AppSession): session is OrgSession {
  return typeof session.user.organizationId === "string" && session.user.organizationId.length > 0;
}

/**
 * Viewer para os serviços de team-chat. Chame depois de `denyUnless`, que já
 * garante organização ativa; o lançamento abaixo é só a rede de segurança
 * para um handler que esqueça o guard.
 */
export function viewerOf(session: AppSession): OrgViewer {
  if (!hasActiveOrg(session)) {
    throw new Error("viewerOf: sessão sem organização ativa (chame denyUnless antes).");
  }
  return {
    userId: session.user.id,
    organizationId: session.user.organizationId,
  };
}

/**
 * Os serviços de team-chat/demandas devolvem `{ error, status } | { ...dado }`
 * sem anotação de retorno. O TypeScript normaliza essa união de literais
 * acrescentando `error?: undefined` ao ramo de sucesso, então `"error" in
 * result` não estreita e `result.error` fica `string | undefined`. Este
 * predicado faz a mesma checagem em runtime, mas estreita de verdade.
 */
export function isServiceError(
  result: unknown,
): result is { error: string; status: number } {
  return typeof result === "object" && result !== null && "error" in result;
}
